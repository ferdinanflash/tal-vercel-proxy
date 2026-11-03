# TAL WoS Atlas Vercel API Proxy

Vercel serverless proxy for the public WoS Atlas API. Adds browser CORS headers and caches GET responses for 5 minutes.

## Deploy

1. Upload these files to a new GitHub repository, or import this folder into Vercel.
2. In Vercel, select **Add New → Project**, import the repository, and deploy.
3. Your endpoint will be `https://YOUR-PROJECT.vercel.app/api/servers`.
4. Optional: set `ALLOWED_ORIGINS` in Vercel Project → Settings → Environment Variables to a comma-separated list, e.g. `https://ferdinanflash.github.io`. Default `*` allows any origin.

## Test

- `https://YOUR-PROJECT.vercel.app/api/servers?limit=200`
- `https://YOUR-PROJECT.vercel.app/api/servers?limit=200&cursor=YOUR_CURSOR`
- `https://YOUR-PROJECT.vercel.app/api/search?q=test`
- `https://YOUR-PROJECT.vercel.app/api/servers/3475`

The proxy forwards query parameters to `https://wosatlas.com/api/v1/` and does not remove upstream pagination. It cannot bypass upstream authentication, rate limits, or API-side data restrictions.

## Connect TAL frontend

In `statetracker.js`, set the API base to your deployed domain plus `/api`, and keep the endpoint paths relative to that base. For example:

```js
apiBase: 'https://YOUR-PROJECT.vercel.app/api',
directUrl: 'https://YOUR-PROJECT.vercel.app/api/servers',
preferProxy: false
```

Then make sure `fetchJson()` calls `CFG.apiBase` directly. If the current frontend is still invoking the Supabase Edge Function (`wosatlas-states`) for some operations, those calls need to be switched to direct fetches through this Vercel proxy too. This proxy package deploys the API layer; it does not modify your GitHub Pages frontend.
