# api/tracker.js

## Penting tentang Zr-Cookies
Banyak response ZenRows **tidak** mengirim header `Zr-Cookies` (plan, atau target tidak Set-Cookie).
Proxy ini **tidak gagal** jika cookie kosong — data tetap diambil via ZenRows antibot.

Cookie cache = best-effort (hemat request berikutnya kalau cookie ada).

## Uji
```
# status
https://tal-vercel-proxy.vercel.app/api/tracker?status=1

# data + debug header ZenRows
https://tal-vercel-proxy.vercel.app/api/tracker?url=https://wosatlas.com/api/v1/servers?limit=5&debug=1

# full-ish list
https://tal-vercel-proxy.vercel.app/api/tracker?all=1&maxPages=5
```

Env wajib: `ZENROWS_API_KEY`
