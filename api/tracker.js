/**
 * Vercel Serverless — ZenRows proxy (cookie cache best-effort)
 *
 * Zr-Cookies sering TIDAK dikirim ZenRows (plan / target tidak Set-Cookie).
 * Cookie cache = opsional. Data tetap diambil lewat ZenRows.
 *
 * Query:
 *   url=... | all=1 | maxPages=N | refresh=1 | status=1 | debug=1
 *
 * Env: ZENROWS_API_KEY (wajib)
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (opsional persist cookie)
 *      COOKIE_TTL_HOURS (default 12)
 */

const UPSTREAM = 'https://wosatlas.com/api/v1';
const SITE = 'https://wosatlas.com';
const ALLOWED_HOSTS = new Set(['wosatlas.com', 'www.wosatlas.com', 'api.wosatlas.com']);
const CACHE_KEY = 'wosatlas_zr_cookies';

const mem = {
  cookie: null,
  at: 0,
  source: null,
  sessionId: null,
  lastDebug: null,
};

function ttlMs() {
  const h = parseFloat(process.env.COOKIE_TTL_HOURS || '12');
  return Math.max(1, h) * 60 * 60 * 1000;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function cacheValid() {
  return !!(mem.cookie && mem.at && Date.now() - mem.at < ttlMs());
}

function cacheAgeMs() {
  return mem.at ? Date.now() - mem.at : null;
}

async function loadCacheFromSupabase() {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) return null;
  try {
    const url = `${base}/rest/v1/wos_proxy_cache?key=eq.${encodeURIComponent(CACHE_KEY)}&select=value,updated_at&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows[0]) return null;
    const updated = new Date(rows[0].updated_at).getTime();
    if (!Number.isFinite(updated) || Date.now() - updated >= ttlMs()) return null;
    if (!rows[0].value) return null;
    mem.cookie = rows[0].value;
    mem.at = updated;
    mem.source = 'supabase';
    return mem.cookie;
  } catch {
    return null;
  }
}

async function saveCacheToSupabase(cookie) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key || !cookie) return;
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

function collectZrHeaders(response) {
  const out = {};
  try {
    for (const [k, v] of response.headers.entries()) {
      if (k.toLowerCase().startsWith('zr-') || k.toLowerCase().startsWith('x-request')) {
        out[k] = v;
      }
    }
  } catch {
    /* ignore */
  }
  // undici may expose set-cookie separately
  try {
    if (typeof response.headers.getSetCookie === 'function') {
      const sc = response.headers.getSetCookie();
      if (sc && sc.length) out['set-cookie'] = sc;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function pickCookiesFromHeaders(hdrs) {
  const keys = Object.keys(hdrs || {});
  for (const k of keys) {
    if (k.toLowerCase() === 'zr-cookies') return String(hdrs[k] || '').trim();
  }
  // fallback: join Set-Cookie name=value
  const sc = hdrs['set-cookie'];
  if (Array.isArray(sc) && sc.length) {
    return sc
      .map((line) => String(line).split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

function mergeCookies(a, b) {
  const map = new Map();
  for (const part of `${a || ''};${b || ''}`.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    if (['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite'].includes(k.toLowerCase())) {
      continue;
    }
    map.set(k, v);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function zenrowsFetch(apiKey, targetUrl, opts = {}) {
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
  if (opts.sessionId != null) u.searchParams.set('session_id', String(opts.sessionId));
  if (opts.cookie) u.searchParams.set('custom_headers', 'true');

  const headers = { Accept: 'application/json, text/plain, */*' };
  if (opts.cookie) headers.Cookie = opts.cookie;

  const response = await fetch(u.toString(), { headers });
  const zrHeaders = collectZrHeaders(response);
  const cookies = pickCookiesFromHeaders(zrHeaders);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: true, body: text.slice(0, 8000) };
  }

  mem.lastDebug = {
    status: response.status,
    ok: response.ok,
    zrHeaderKeys: Object.keys(zrHeaders),
    zrHeaders,
    cookieLen: cookies ? cookies.length : 0,
    bodyPreview: typeof text === 'string' ? text.slice(0, 120) : null,
  };

  return {
    ok: response.ok,
    status: response.status,
    data,
    cookies,
    zrHeaders,
  };
}

/** Best-effort cookie refresh — TIDAK gagal jika cookie kosong */
async function tryRefreshCookies(apiKey) {
  const sessionId = String(Math.floor(Math.random() * 900000) + 100000);
  mem.sessionId = sessionId;

  const first = await zenrowsFetch(apiKey, `${UPSTREAM}/servers?limit=5`, {
    antibot: true,
    sessionId,
    cookie: cacheValid() ? mem.cookie : undefined,
  });

  let cookie = first.cookies || '';
  if (cookie) {
    mem.cookie = mergeCookies(mem.cookie, cookie);
    mem.at = Date.now();
    mem.source = 'zenrows-zr-cookies';
    await saveCacheToSupabase(mem.cookie);
  }

  return { cookie: mem.cookie, data: first.data, ok: first.ok, hadCookie: !!cookie };
}

async function ensureCookieSoft(apiKey, force) {
  if (!force) {
    if (cacheValid()) return mem.cookie;
    await loadCacheFromSupabase();
    if (cacheValid()) return mem.cookie;
  }
  const r = await tryRefreshCookies(apiKey);
  return r.cookie;
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

async function fetchTarget(apiKey, targetUrl) {
  // 1) Direct (gratis)
  try {
    const res = await fetch(targetUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TAL-Vercel-Proxy/1.1',
        ...(mem.cookie ? { Cookie: mem.cookie } : {}),
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

  // 2) ZenRows + antibot (jalur yang sudah terbukti jalan)
  const sessionId = mem.sessionId || String(Math.floor(Math.random() * 900000) + 100000);
  mem.sessionId = sessionId;
  const zr = await zenrowsFetch(apiKey, targetUrl, {
    antibot: true,
    sessionId,
    cookie: mem.cookie || undefined,
  });
  if (zr.cookies) {
    mem.cookie = mergeCookies(mem.cookie, zr.cookies);
    mem.at = Date.now();
    mem.source = 'zenrows-zr-cookies';
    await saveCacheToSupabase(mem.cookie);
  }
  if (!zr.ok && zr.data && zr.data._raw) {
    throw new Error(`ZenRows HTTP ${zr.status}: ${String(zr.data.body || '').slice(0, 200)}`);
  }
  if (zr.data && zr.data.detail && !extractItems(zr.data).length) {
    // ZenRows API error object
    throw new Error(typeof zr.data.detail === 'string' ? zr.data.detail : JSON.stringify(zr.data).slice(0, 200));
  }
  return { data: zr.data, via: 'zenrows-antibot' };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ZENROWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ZENROWS_API_KEY belum dikonfigurasi di Environment Variables Vercel.',
    });
  }

  if (String(req.query.status || '') === '1') {
    await loadCacheFromSupabase();
    return res.status(200).json({
      hasCookie: !!mem.cookie,
      valid: cacheValid(),
      ageMs: cacheAgeMs(),
      ttlMs: ttlMs(),
      source: mem.source,
      cookiePreview: mem.cookie ? mem.cookie.slice(0, 48) + '…' : null,
      supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      note: 'Zr-Cookies sering kosong; data tetap bisa diambil tanpa cookie cache.',
      lastDebug: mem.lastDebug,
    });
  }

  const forceRefresh = String(req.query.refresh || '') === '1';
  const wantAll = String(req.query.all || '') === '1';
  const wantDebug = String(req.query.debug || '') === '1';
  const maxPages = Math.min(
    Math.max(parseInt(String(req.query.maxPages || '25'), 10) || 25, 1),
    40
  );

  try {
    // Soft cookie attempt — never blocks data path
    await ensureCookieSoft(apiKey, forceRefresh);

    if (!wantAll) {
      const targetUrl =
        (typeof req.query.url === 'string' && req.query.url.trim()) ||
        `${UPSTREAM}/servers?limit=50`;
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return res.status(400).json({ error: 'url tidak valid' });
      }
      if (!ALLOWED_HOSTS.has(parsed.hostname)) {
        return res.status(400).json({ error: 'Host tidak diizinkan' });
      }

      const { data, via } = await fetchTarget(apiKey, targetUrl);
      const payload =
        data && typeof data === 'object'
          ? Object.assign({}, data, {
              _proxy: {
                via,
                hasCookie: !!mem.cookie,
                cookieValid: cacheValid(),
                cookieAgeMs: cacheAgeMs(),
                ...(wantDebug ? { lastDebug: mem.lastDebug } : {}),
              },
            })
          : data;
      return res.status(200).json(payload);
    }

    // all=1
    let next = null;
    const allItems = [];
    const pages = [];
    let page = 0;
    let viaLast = null;

    while (page < maxPages) {
      page += 1;
      let targetUrl;
      if (next) {
        targetUrl = String(next).startsWith('http')
          ? next
          : `${UPSTREAM}/servers?limit=200&cursor=${encodeURIComponent(next)}`;
      } else {
        targetUrl = `${UPSTREAM}/servers?limit=200`;
      }

      const { data, via } = await fetchTarget(apiKey, targetUrl);
      viaLast = via;
      if (data && data._raw) {
        return res.status(502).json({
          error: 'Non-JSON dari upstream',
          page,
          sample: String(data.body || '').slice(0, 200),
          lastDebug: mem.lastDebug,
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
        source: 'zenrows',
        via: viaLast,
        pages: pages.length,
        pageDetails: pages,
        stoppedBecause: next ? 'maxPages' : 'done',
        maxPages,
        hasCookie: !!mem.cookie,
        cookieValid: cacheValid(),
        ...(wantDebug ? { lastDebug: mem.lastDebug } : {}),
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Gagal proxy',
      details: error.message || String(error),
      lastDebug: mem.lastDebug,
    });
  }
}
