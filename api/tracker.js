/**
 * Vercel Serverless Function — ZenRows Proxy for State Tracker
 *
 * Endpoint: /api/tracker
 *
 * Query params:
 *   url   – target URL (default: servers list)
 *   all   – if "1", walk opaque `next` cursors and return full list (expensive)
 *   maxPages – max cursor pages when all=1 (default 25)
 *
 * Environment:
 *   ZENROWS_API_KEY – required
 *
 * Examples:
 *   GET /api/tracker?url=https://wosatlas.com/api/v1/servers?limit=50
 *   GET /api/tracker?all=1
 *   GET /api/tracker?all=1&maxPages=30
 */

const UPSTREAM = 'https://wosatlas.com/api/v1';
const ALLOWED_HOSTS = new Set(['wosatlas.com', 'www.wosatlas.com', 'api.wosatlas.com']);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function zenrowsFetch(apiKey, targetUrl) {
  const zenrowsUrl = new URL('https://api.zenrows.com/v1/');
  zenrowsUrl.searchParams.append('apikey', apiKey);
  zenrowsUrl.searchParams.append('url', targetUrl);
  zenrowsUrl.searchParams.append('js_render', 'true');
  zenrowsUrl.searchParams.append('antibot', 'true');
  zenrowsUrl.searchParams.append('premium_proxy', 'true');

  const response = await fetch(zenrowsUrl.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ZenRows HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: true, contentType, body: raw.slice(0, 50000) };
  }
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const apiKey = process.env.ZENROWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ZENROWS_API_KEY belum dikonfigurasi di Environment Variables Vercel.',
    });
  }

  const wantAll = String(req.query.all || '') === '1';
  const maxPages = Math.min(
    Math.max(parseInt(String(req.query.maxPages || '25'), 10) || 25, 1),
    40
  );

  // Single-URL mode
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

    try {
      const data = await zenrowsFetch(apiKey, targetUrl);
      return res.status(200).json(data);
    } catch (error) {
      return res.status(500).json({
        error: 'Gagal mengambil data via ZenRows Proxy',
        details: error.message || String(error),
      });
    }
  }

  // all=1 — walk opaque next cursors (expensive: 1 ZenRows credit per page)
  try {
    const limit = 200;
    let next = null;
    const allItems = [];
    const pages = [];
    let page = 0;

    while (page < maxPages) {
      page += 1;
      let targetUrl;
      if (next) {
        targetUrl = `${UPSTREAM}/servers?limit=${limit}&cursor=${encodeURIComponent(next)}`;
        // some APIs use "next" as the full query token
        if (String(next).startsWith('http')) {
          targetUrl = next;
        } else if (String(next).includes('=') || String(next).includes('/')) {
          // opaque cursor string — try common param names
          targetUrl = `${UPSTREAM}/servers?limit=${limit}&next=${encodeURIComponent(next)}`;
        }
      } else {
        targetUrl = `${UPSTREAM}/servers?limit=${limit}`;
      }

      const data = await zenrowsFetch(apiKey, targetUrl);
      if (data && data._raw) {
        return res.status(502).json({
          error: 'ZenRows mengembalikan non-JSON (mungkin masih kena challenge)',
          page,
          sample: String(data.body || '').slice(0, 200),
        });
      }

      const items = extractItems(data);
      allItems.push(...items);
      pages.push({ page, count: items.length, next: extractNext(data) });

      next = extractNext(data);
      if (!next || items.length === 0) break;
    }

    return res.status(200).json({
      entries: allItems,
      items: allItems,
      total: allItems.length,
      partial: !!next,
      meta: {
        source: 'zenrows-all',
        pages: pages.length,
        pageDetails: pages,
        stoppedBecause: next ? 'maxPages' : 'done',
        maxPages,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Gagal mengambil full list via ZenRows',
      details: error.message || String(error),
    });
  }
}
