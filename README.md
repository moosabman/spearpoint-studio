# Spearpoint Studio — spearpointpro.com

The site is a single page in `public/` served by a small Cloudflare Worker (`src/worker.js`).

- `public/index.html` — the whole site
- `public/assets/` — logo, favicon, stills, portraits
- `src/worker.js` — serves the site, plus:
  - `/api/stats` — live totals and latest posts from Zernio, cached about 30 minutes
  - `/api/thumb/<id>` — post thumbnails, proxied so expiring Instagram links never break
- `wrangler.jsonc` — Cloudflare settings

## Secrets
`ZERNIO_API_KEY` is set in Cloudflare (Worker → Settings → Variables and Secrets, type **Secret**).
Never commit it. Use a read-only Zernio key.

## Deploys
Every push to `main` deploys automatically through Cloudflare's Git integration.
If the stats API is down, the page keeps showing the numbers written into `index.html`.
