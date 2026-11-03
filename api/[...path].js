const UPSTREAM = "https://wosatlas.com/api/v1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowOrigin = ALLOWED_ORIGINS.includes("*")
    ? "*"
    : ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "HEAD"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let parts = req.query.path;
    if (!Array.isArray(parts)) parts = parts ? [parts] : [];
    parts = parts.map(String);
    if (
      !parts.length ||
      parts.some((p) => !p || p === "." || p === ".." || p.includes("/"))
    ) {
      return res.status(400).json({ error: "Invalid API path" });
    }

    const target = new URL(
      `${UPSTREAM}/${parts.map(encodeURIComponent).join("/")}`
    );
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "path") continue;
      if (Array.isArray(value))
        value.forEach((v) => target.searchParams.append(key, String(v)));
      else target.searchParams.set(key, String(value));
    }

    const upstream = await fetch(target.toString(), {
      method: req.method,
      headers: {
        Accept: "application/json",
        "User-Agent": "TAL-Vercel-API-Proxy/1.0",
      },
      redirect: "follow",
    });
    const body = await upstream.text();
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/json; charset=utf-8"
    );
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error("WoS Atlas proxy error:", err);
    return res.status(502).json({ error: "Upstream API request failed" });
  }
}
