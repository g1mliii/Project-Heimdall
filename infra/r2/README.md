# R2 bucket setup

One-time configuration for the `heimdall-runs` bucket (name from `R2_BUCKET` in `.env`).
Layout: `runs/{id}.parquet` (per-frame data), `exports/` (Phase 11 video exports).

## CORS — required for browser direct uploads (§5.2)

The upload flow (§11.3) has the browser `PUT` a Parquet straight to R2 via a presigned URL.
Without bucket CORS the preflight fails and every browser upload is blocked.

Edit `cors.json` first: replace `https://heimdall.example.com` with the real production
origin (keep `http://localhost:3000` for dev). Then apply it:

```bash
npx wrangler r2 bucket cors set heimdall-runs --file infra/r2/cors.json
# confirm
npx wrangler r2 bucket cors list heimdall-runs
```

`cors.json` uses the R2 API shape (`{"rules": [{"allowed": {...}}]}`), not the
S3-style bare array.

`wrangler` needs `CLOUDFLARE_API_TOKEN` (or `wrangler login`) with R2 edit permission.

Notes:
- `GET`/`HEAD` are included so the dashboard can fetch presigned frame reads cross-origin.
- Presigned URLs already expire (PUT 15 min, GET 60 min — see `apps/web/src/lib/r2.ts`);
  CORS is origin gating on top, not the auth layer.
- Re-running the command replaces the whole CORS ruleset (idempotent).
