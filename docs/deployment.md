# Deployment

## Option A — single small VM (recommended for one family)

1. A VM with 1 vCPU / 1–2 GB RAM (e.g. Hetzner CX22, DigitalOcean basic, Lightsail) with Docker.
2. `git clone`, `cp .env.example .env`, set `ENCRYPTION_KEY`, `WEB_ORIGIN=https://hub.example.com`, `COOKIE_SECURE=true`, `POSTGRES_PASSWORD`.
3. `docker compose up --build -d`.
4. Put Caddy or Cloudflare Tunnel in front of port 8080 for TLS.

## Option B — managed services

- **API + worker**: any container host (Fly.io, Render, Cloud Run, ECS). Run the same image twice: `node dist/server.js` with `WORKER_MODE=off`, and `node dist/worker.js`.
- **Database**: managed Postgres 16 (Neon, Supabase, RDS). Set `DATABASE_URL`.
- **Web**: the `infra/web.Dockerfile` image, or upload `apps/web/dist` to a static host and route `/api/*` to the API on the **same origin** (cookies are first-party).

Migrations run automatically on API start (`prisma migrate deploy`).

## Environment variables

See [`.env.example`](../.env.example). Required in production: `DATABASE_URL`, `ENCRYPTION_KEY`, `WEB_ORIGIN`, `COOKIE_SECURE=true`. Optional: `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET/TENANT`, `API_PUBLIC_URL` (OAuth redirect base).

## Estimated monthly cost (one household)

| Setup | Cost |
| --- | --- |
| Self-hosted on an existing home server / NAS | $0 |
| Single VM (Hetzner CX22) + Cloudflare Tunnel | ~$5 |
| Fly.io (2 small machines) + Neon free tier | ~$5–10 |
| AWS (ECS Fargate + RDS t4g.micro + ALB) | ~$45–60 |

Google and Microsoft calendar APIs are free at family-scale usage.
