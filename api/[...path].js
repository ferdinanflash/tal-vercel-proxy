
const UPSTREAM = 'https://wosatlas.com/api/v1';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const url = new URL(
      req.url,
      `https://${req.headers.host}`
    );

    // Remove /api/ from the requested path
    const path = url.pathname
      .replace(/^\/api\/?/, '')
      .split('/')
      .filter(Boolean);

    if (!path.length) {
      return res.status(400).json({
        error: 'Invalid API path',
        received: url.pathname
      });
    }

    const target = new URL(
      `${UPSTREAM}/${path.map(encodeURIComponent).join('/')}`
    );

    // Preserve query parameters
    url.searchParams.forEach((value, key) => {
      target.searchParams.append(key, value);
    });

    const response = await fetch(target.toString(), {
      method: req.method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TAL-Vercel-API-Proxy/1.0'
      }
    });

    const body = await response.text();

    res.setHeader(
      'Content-Type',
      response.headers.get('content-type') ||
      'application/json; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      's-maxage=300, stale-while-revalidate=600'
    );

    return res.status(response.status).send(body);

  } catch (error) {
    return res.status(502).json({
      error: 'Upstream API request failed',
      message: error.message
    });
  }
}
