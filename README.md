# FamilyHub Pro

A self-hostable family command center: shared calendars (internal + Google/Microsoft/ICS), chores with points and rewards, shared lists that work offline, and a wall-display dashboard for kitchen tablets. Installable as a PWA.

## Quick start (development)

Requirements: Node 22, pnpm 9, Docker (for Postgres).

```bash
pnpm install
docker run -d --name fh-postgres -e POSTGRES_USER=familyhub -e POSTGRES_PASSWORD=familyhub \
  -e POSTGRES_DB=familyhub -p 5432:5432 postgres:16-alpine
cp .env.example .env
# set ENCRYPTION_KEY in .env:  openssl rand -base64 32
pnpm db:migrate && pnpm db:seed
pnpm dev            # API on :4000, web on :5173
```

Open http://localhost:5173 and sign in as `demo@familyhub.local` / `FamilyHub!2024` (household PIN `1234`). These are local seed credentials only.

API docs (OpenAPI / Swagger UI): http://localhost:4000/api/docs

## Self-hosting with Docker Compose

```bash
cp .env.example .env    # set ENCRYPTION_KEY, WEB_ORIGIN, COOKIE_SECURE=true behind HTTPS
docker compose up --build -d
docker compose exec api ./node_modules/.bin/prisma db seed   # optional demo data (needs dev deps; usually skip)
```

The web container (nginx) serves the PWA on port 8080 and proxies `/api` to the API so cookies stay first-party. Put a TLS-terminating proxy (Caddy, Traefik, Cloudflare Tunnel) in front for production.

## Deploy to AWS (one command)

All settings live in [`deploy/familyhub.config`](deploy/familyhub.config). From cmd on Windows:

```cmd
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
```

(macOS/Linux: `./deploy/deploy.sh`.) See [docs/aws.md](docs/aws.md). Android app: [docs/android.md](docs/android.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/api` | Express + Prisma API, background scheduler/worker, OpenAPI, tests |
| `apps/web` | React + Vite PWA (TanStack Query, Zustand, FullCalendar, Tailwind) |
| `packages/shared` | Zod schemas, enums, permission rules and DTO types shared by both |
| `apps/android` | Capacitor Android app (APK) |
| `deploy` | Config file + one-command AWS deploy scripts |
| `infra` | Dockerfiles, compose files, nginx and Caddy config |
| `docs` | Architecture, security, deployment, integrations, operations, roadmap |

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API + web in watch mode |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript across all packages |
| `pnpm test` | API unit + integration tests (needs Postgres; uses `familyhub_test`) and web unit tests |
| `pnpm e2e` | Playwright end-to-end tests (desktop + tablet), against a seeded dev database |
| `pnpm build` | Production builds |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / load demo data |

## Status

See [docs/status.md](docs/status.md) for what is implemented and verified, and what is not (notably: Google/Microsoft sync is implemented against the documented APIs but has not been verified against live accounts without OAuth credentials).
