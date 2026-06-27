---
name: VPS self-host deploy (hmeriweb.xyz)
description: Gotchas for deploying this monorepo to the user's external VPS without breaking the co-hosted punjab-case-management site.
---

# Self-hosting this monorepo on an external VPS

**Why:** The user runs a fresh standalone deploy of the WhatsApp panel (api-server + support-connect) on their own Ubuntu VPS, alongside an unrelated `punjab-case-management` nginx site that must never be touched.

## Replit DATABASE_URL is NOT portable
The Replit-provided `DATABASE_URL` secret points to internal host **`helium`**, which only resolves inside Replit's network (`getaddrinfo EAI_AGAIN helium` off-platform). Any external/self-host deploy must provision its **own** Postgres (installed local PostgreSQL, created role+db `shoib`, wrote a localhost `DATABASE_URL`, ran `drizzle-kit push`). Do not assume the secret works off-Replit.

## pnpm 11 build gotcha
`pnpm install` **exits 1** on `ERR_PNPM_IGNORED_BUILDS` (refuses until build scripts approved), and `pnpm run <script>`'s pre-run deps check re-runs install and inherits that failure — even with `verify-deps-before-run=false`. 
**How to apply:** linking still completes fine; bypass the pnpm wrapper and run build binaries directly: api = `node build.mjs`; web = `./node_modules/.bin/vite build --config vite.config.ts`. esbuild's native binary comes from its `@esbuild/linux-x64` optional dep so it works without the approved postinstall.

## PM2 stale-env trap
`pm2 restart` / `--update-env` keeps the env captured at first `pm2 start` (does NOT re-read the ecosystem/.env). After editing `.env`, you must `pm2 delete <app> && pm2 start ecosystem.config.cjs` to load changes. Verify presence via `tr '\0' '\n' < /proc/$(pm2 pid <app>)/environ | grep -c '^KEY='`.

## Runtime env the api-server needs in production
`DATABASE_URL`, `PORT`, `NODE_ENV=production`, and **`SESSION_SECRET`** (panel/admin token signing falls back to a hardcoded constant if unset → forgeable tokens). Optional: `LOG_LEVEL`, `ADMIN_USERNAME`/`ADMIN_PASSWORD` (else seeds default `admin`/`admin123`).

## Serving model on the VPS
Frontend calls root-relative `/api`; api-server serves only `/api` (no static). nginx server_name `hmeriweb.xyz`: `location /api` → 127.0.0.1:4000 (SSE: `proxy_http_version 1.1; proxy_buffering off; Connection ""; proxy_read_timeout 3600s`), `location /` → 127.0.0.1:4001 (`pm2 serve dist/public --spa`). Always `nginx -t` then `reload` (never restart) to protect the co-hosted site.

## Open follow-ups (when user sets DNS A record → VPS IP)
1. `certbot --nginx -d hmeriweb.xyz -d www.hmeriweb.xyz` for SSL (blocked until DNS resolves).
2. After HTTPS forced, lock 4000/4001 to localhost (or firewall) — currently bound 0.0.0.0 so they're reachable plaintext by IP, bypassing nginx/TLS.
