/**
 * Vercel Serverless Function — ZenRows Proxy for State Tracker
 *
 * Endpoint: /api/tracker
 *
 * Query params:
 *   url   (required) – target URL to fetch (e.g. https://wosatlas.com/api/v1/servers?limit=50)
 *
 * Environment:
 *   ZENROWS_API_KEY – required, set in Vercel project settings
 *
 * Example:
 *   GET /api/tracker?url=https%3A%2F%2Fwosatlas.com%2Fapi%2Fv1%2Fservers%3Flimit%3D50
 */

export default async function handler(req, res) {
  // CORS — allow browser calls from the TAL domain (and local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  // Target URL can be passed via query string; fall back to a sensible default
  // for the State list endpoint.
  const targetUrl =
    (typeof req.query.url === 'string' && req.query.url.trim()) ||
    'https://wosatlas.com/api/v1/servers?limit=50';

  // Basic safety: only allow known WoS Atlas hosts
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Parameter url tidak valid.' });
  }
  const allowedHosts = new Set(['wosatlas.com', 'www.wosatlas.com', 'api.wosatlas.com']);
  if (!allowedHosts.has(parsed.hostname)) {
    return res.status(400).json({
      error: 'Host tidak diizinkan. Hanya wosatlas.com / api.wosatlas.com.',
    });
  }

  try {
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
      throw new Error(`ZenRows HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    // ZenRows may return HTML or JSON depending on the page; try JSON first
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return res.status(200).json(data);
    }

    // Fallback: parse as text then attempt JSON
    const raw = await response.text();
    try {
      const data = JSON.parse(raw);
      return res.status(200).json(data);
    } catch {
      // Return raw body wrapped so the client can inspect it
      return res.status(200).json({
        _raw: true,
        contentType,
        body: raw.slice(0, 50000),
      });
    }
  } catch (error) {
    return res.status(500).json({
      error: 'Gagal mengambil data via ZenRows Proxy',
      details: error.message || String(error),
    });
  }
}
