# api/tracker.js — ZenRows (jalur UTAMA State Tracker)

Copy ke repo tal-vercel-proxy:

```
api/
├── [...path].js   # existing
└── tracker.js     # this file
```

## Vercel env
ZENROWS_API_KEY = <your key>

## Endpoints
- Single: /api/tracker?url=https://wosatlas.com/api/v1/servers?limit=50
- Full list: /api/tracker?all=1&maxPages=30

Frontend TAL memanggil ?all=1 sebagai sumber utama data State Tracker.
