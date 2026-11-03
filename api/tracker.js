/**
 * Vercel Serverless — ZenRows proxy + cookie cache 12 jam
 *
 * Alur:
 *  1. Setiap 12 jam (atau cache kosong): request ZenRows (js_render+antibot)
 *     ke wosatlas.com, baca header Zr-Cookies, simpan.
 *  2. Request berikutnya: pakai cookie tersimpan.
 *     - Coba fetch LANGSUNG dari Vercel (0 kredit ZenRows).
 *     - Jika gagal → ZenRows ringan + Cookie header.
 *
 * Query:
 *   url=...     single URL
 *   all=1       walk list servers (pakai cookie)
 *   maxPages=N  default 25
 *   refresh=1   paksa refresh cookie
 *   status=1    info cache saja (tanpa scrape)
 *
 * Env:
 *   ZENROWS_API_KEY          (wajib)
 *   SUPABASE_URL             (opsional, persist cookie lintas cold start)
 *   SUPABASE_SERVICE_ROLE_KEY (opsional)
 *   COOKIE_TTL_HOURS         (default 12)
 */

const UPSTREAM = 'https://wosatlas.com/api/v1';
const SITE = 'https://wosatlas.com';
const ALLOWED_HOSTS = new Set(['wosatlas.com', 'www.wosatlas.com', 'api.wosatlas.com']);
const CACHE_KEY = 'wosatlas_zr_cookies';

// In-memory (bertahan selama instance Vercel masih warm)
const mem = { cookie: null, at: 0, source: 0 };

function ttlMs() {
  const h = parseFloat(process.env.COOKIE_TTL_HOURS || '12');
  return Math.max(1, h) * 60 * 60 * 1000;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function cacheAgeMs() {
  return mem.at ? Date.now() - mem.at : null;
}

function cacheValid() {
  return !!(mem.cookie && mem.at && Date.now() - mem.at < ttlMs());
}

// ---- Optional Supabase persistence ----
async function loadCacheFromSupabase() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) return null;
  try {
    const url =
      `${base}/rest/v1/wos_proxy_cache?key=eq.${encodeURIComponent(CACHE_KEY)}&select=value,updated_at&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows[0]) return null;
    const updated = new Date(rows[0].updated_at).getTime();
    if (!Number.isFinite(updated) || Date.now() - updated >= ttlMs()) return null;
    const value = rows[0].value;
    if (!value || typeof value !== 'string') return null;
    mem.cookie = value;
    mem.at = updated;
    return value;
  } catch {
    return null;
  }
}

async function saveCacheToSupabase(cookie) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) return;
  try {
    await fetch(`${base}/rest/v1/wos_proxy_cache`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        key: CACHE_KEY,
        value: cookie,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    /* ignore */
  }
}

async function ensureMemoryCache() {
  if (cacheValid()) return mem.cookie;
  const fromDb = await loadCacheFromSupabase();
  return fromDb;
}

// ---- ZenRows helpers ----
function buildZenrowsUrl(apiKey, targetUrl, opts = {}) {
  const u = new URL('https://api.zenrows.com/v1/');
  u.searchParams.set('apikey', apiKey);
  u.searchParams.set('url', targetUrl);
  if (opts.antibot) {
    u.searchParams.set('js_render', 'true');
    u.searchParams.set('antibot', 'true');
    u.searchParams.set('premium_proxy', 'true');
  } else if (opts.premium) {
    u.searchParams.set('premium_proxy', 'true');
  }
  if (opts.sessionId) u.searchParams.set('session_id', String(opts.sessionId));
  if (opts.customHeaders) u.searchParams.set('custom_headers', 'true');
  return u;
}

async function zenrowsRequest(apiKey, targetUrl, opts = {}) {
  const url = buildZenrowsUrl(apiKey, targetUrl, opts);
  const headers = { Accept: 'application/json' };
  if (opts.cookie) {
    headers.Cookie = opts.cookie;
  }
  const response = await fetch(url.toString(), { headers });
  const zrCookies =
    response.headers.get('Zr-Cookies') ||
    response.headers.get('zr-cookies') ||
    '';
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: true, body: text.slice(0, 50000) };
  }
  return {
    ok: response.ok,
    status: response.status,
    data,
    zrCookies: zrCookies.trim(),
  };
}

/** Request pertama / refresh: antibot, capture cookie */
async function refreshCookies(apiKey) {
  // Hit homepage + API list agar CF/app cookies ter-set
  const sessionId = String(Math.floor(Math.random() * 900000) + 100000);
  const first = await zenrowsRequest(apiKey, `${SITE}/`, {
    antibot: true,
    sessionId,
  });
  let cookie = first.zrCookies || '';

  const second = await zenrowsRequest(
    apiKey,
    `${UPSTREAM}/servers?limit=5`,
    {
      antibot: true,
      sessionId,
      cookie: cookie || undefined,
      customHeaders: !!cookie,
    }
  );
  if (second.zrCookies) {
    cookie = mergeCookies(cookie, second.zrCookies);
  }

  if (!cookie) {
    throw new Error(
      'ZenRows tidak mengembalikan Zr-Cookies. Coba naikkan plan / cek antibot.'
    );
  }

  mem.cookie = cookie;
  mem.at = Date.now();
  mem.source = 'zenrows-refresh';
  await saveCacheToSupabase(cookie);
  return cookie;
}

function mergeCookies(a, b) {
  const map = new Map();
  for (const part of `${a};${b}`.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    // skip attributes
    if (['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite'].includes(k.toLowerCase())) {
      continue;
    }
    map.set(k, v);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getCookie(apiKey, forceRefresh) {
  if (!forceRefresh) {
    const existing = await ensureMemoryCache();
    if (existing && cacheValid()) return existing;
  }
  return refreshCookies(apiKey);
}

/** Fetch target: direct dulu (gratis), fallback ZenRows + cookie */
async function fetchWithCookie(apiKey, targetUrl, cookie) {
  // 1) Direct dari Vercel
  try {
    const res = await fetch(targetUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TAL-Vercel-Proxy/cookie-cache',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (res.ok) {
      const text = await res.text();
      try {
        return { data: JSON.parse(text), via: 'direct' };
      } catch {
        /* fall through */
      }
    }
  } catch {
    /* fall through */
  }

  // 2) ZenRows ringan + cookie (tanpa antibot penuh)
  const zr = await zenrowsRequest(apiKey, targetUrl, {
    premium: true,
    cookie,
    customHeaders: true,
    sessionId: 347512,
  });
  if (zr.zrCookies) {
    mem.cookie = mergeCookies(cookie, zr.zrCookies);
    mem.at = Date.now();
    await saveCacheToSupabase(mem.cookie);
  }
  if (!zr.ok && zr.data && zr.data._raw) {
    throw new Error(`ZenRows HTTP ${zr.status}`);
  }
  return { data: zr.data, via: 'zenrows-cookie' };
}

function extractItems(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.entries)) return data.entries;
  if (Array.isArray(data.servers)) return data.servers;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function extractNext(data) {
  if (!data || typeof data !== 'object') return null;
  const n = data.next ?? data.cursor ?? data.next_cursor ?? null;
  if (n == null || n === '') return null;
  return String(n);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const apiKey = process.env.ZENROWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ZENROWS_API_KEY belum dikonfigurasi di Environment Variables Vercel.',
    });
  }

  // Status cache
  if (String(req.query.status || '') === '1') {
    await ensureMemoryCache();
    return res.status(200).json({
      hasCookie: !!mem.cookie,
      valid: cacheValid(),
      ageMs: cacheAgeMs(),
      ttlMs: ttlMs(),
      source: mem.source || null,
      cookiePreview: mem.cookie ? mem.cookie.slice(0, 40) + '…' : null,
      supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    });
  }

  const forceRefresh = String(req.query.refresh || '') === '1';
  const wantAll = String(req.query.all || '') === '1';
  const maxPages = Math.min(
    Math.max(parseInt(String(req.query.maxPages || '25'), 10) || 25, 1),
    40
  );

  try {
    const cookie = await getCookie(apiKey, forceRefresh);

    if (!wantAll) {
      const targetUrl =
        (typeof req.query.url === 'string' && req.query.url.trim()) ||
        `${UPSTREAM}/servers?limit=50`;
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return res.status(400).json({ error: 'Parameter url tidak valid.' });
      }
      if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        return res.status(400).json({
          error: 'Host tidak diizinkan. Hanya wosatlas.com / api.wosatlas.com.',
        });
      }
      const { data, via } = await fetchWithCookie(apiKey, targetUrl, cookie);
      return res.status(200).json(
        data && typeof data === 'object'
          ? Object.assign({}, data, {
              _proxy: {
                via,
                cookieAgeMs: cacheAgeMs(),
                cookieValid: cacheValid(),
              },
            })
          : data
      );
    }

    // all=1 — walk cursors with cached cookie
    let next = null;
    const allItems = [];
    const pages = [];
    let page = 0;
    let viaLast = null;

    while (page < maxPages) {
      page += 1;
      let targetUrl;
      if (next) {
        if (String(next).startsWith('http')) {
          targetUrl = next;
        } else {
          targetUrl = `${UPSTREAM}/servers?limit=200&cursor=${encodeURIComponent(next)}`;
        }
      } else {
        targetUrl = `${UPSTREAM}/servers?limit=200`;
      }

      const { data, via } = await fetchWithCookie(apiKey, targetUrl, cookie);
      viaLast = via;
      if (data && data._raw) {
        return res.status(502).json({
          error: 'Non-JSON dari upstream',
          page,
          sample: String(data.body || '').slice(0, 200),
        });
      }
      const items = extractItems(data);
      allItems.push(...items);
      pages.push({ page, count: items.length, next: extractNext(data), via });
      next = extractNext(data);
      if (!next || items.length === 0) break;
    }

    return res.status(200).json({
      entries: allItems,
      items: allItems,
      total: allItems.length,
      partial: !!next,
      meta: {
        source: 'cookie-cache',
        via: viaLast,
        pages: pages.length,
        pageDetails: pages,
        stoppedBecause: next ? 'maxPages' : 'done',
        maxPages,
        cookieAgeMs: cacheAgeMs(),
        cookieValid: cacheValid(),
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Gagal proxy / cookie cache',
      details: error.message || String(error),
    });
  }
}
