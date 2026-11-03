# api/tracker.js — ZenRows + cookie cache 12 jam

## Alur
1. **Request pertama** (atau cache > 12 jam / `?refresh=1`):
   - ZenRows `js_render` + `antibot` → baca header `Zr-Cookies`
   - Simpan cookie di memory (+ opsional Supabase)
2. **Request berikutnya**:
   - Pakai cookie tersimpan
   - Coba fetch **langsung** dari Vercel (0 kredit)
   - Jika gagal → ZenRows ringan + header Cookie

## Deploy
```text
tal-vercel-proxy/api/tracker.js   ← file ini
```

### Env Vercel (wajib)
| Key | Keterangan |
|-----|------------|
| `ZENROWS_API_KEY` | API key ZenRows |

### Env opsional (agar cookie survive cold start)
| Key | Keterangan |
|-----|------------|
| `SUPABASE_URL` | URL project Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (server only) |
| `COOKIE_TTL_HOURS` | default `12` |

SQL tabel (jalankan sekali di Supabase SQL editor):
```sql
create table if not exists public.wos_proxy_cache (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
-- RLS: hanya service role (bypass RLS) yang akses
alter table public.wos_proxy_cache enable row level security;
```

## Uji
```
# status cache
https://tal-vercel-proxy.vercel.app/api/tracker?status=1

# paksa refresh cookie (1x ZenRows mahal)
https://tal-vercel-proxy.vercel.app/api/tracker?refresh=1&url=https://wosatlas.com/api/v1/servers?limit=5

# list (pakai cookie cache)
https://tal-vercel-proxy.vercel.app/api/tracker?all=1&maxPages=5
```

## Catatan
- Cookie CF/app yang di-capture ZenRows **belum tentu** sama dengan `ah_session` dari Turnstile.
  Jika list tetap ~20 state, session app-level masih perlu Turnstile (jalur Supabase).
- ZenRows `session_id` hanya pin IP ~10 menit; cookie cache 12 jam dikelola di sisi kita.
