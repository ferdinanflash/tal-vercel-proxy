# api/tracker.js — ZenRows proxy

Tambahkan file ini ke repo **tal-vercel-proxy**:

```
tal-vercel-proxy/
└── api/
    ├── [...path].js   # sudah ada
    └── tracker.js     # file ini
```

## Setup
1. Copy `api/tracker.js` ke folder `api/` di repo tal-vercel-proxy.
2. Vercel → Project Settings → Environment Variables:
   - Key: `ZENROWS_API_KEY`
   - Value: API key dari https://www.zenrows.com
3. Commit & push → Vercel auto-deploy.
4. Uji:
   https://tal-vercel-proxy.vercel.app/api/tracker?url=https%3A%2F%2Fwosatlas.com%2Fapi%2Fv1%2Fservers%3Flimit%3D10

Endpoint ini dipakai frontend TAL sebagai fallback ketiga bila Turnstile/Supabase gagal.
