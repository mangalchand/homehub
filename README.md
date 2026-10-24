# FamilyHub

A warm, modern family operating system: shared calendar, chores & rewards, groceries, home maintenance, expenses, document vault and a reminder center — plus family accounts with invitations.

Built with React + TypeScript + Vite, React Router, TanStack Query, Lucide icons and date-fns. Ships with a Fastify + Prisma/PostgreSQL backend (Docker Compose), but **the frontend works out of the box** with a rich local demo dataset persisted to `localStorage` — no database required to explore the app.

## Quick start (frontend only, no DB needed)

```bash
npm install
npm run dev
```

Open http://localhost:5173 — the app is fully usable in demo mode. Use the **Reset demo** button on the dashboard to restore seed data.

## Full stack (optional)

```bash
cp .env.example .env        # DATABASE_URL + PORT
npm run db:up               # docker compose up -d db (Postgres 16)
npm run db:generate         # prisma generate
npm run db:push             # create tables
npm run server              # Fastify API on :4000 (Vite proxies /api)
npm run dev                 # in a second terminal
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + production build |
| `npm run preview` | Preview production build |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit + component tests |
| `npm run server` | Fastify API (tsx watch) |
| `npm run db:up` / `db:push` / `db:generate` | Postgres via Docker Compose, Prisma schema push, client generation |

## Modules

- **Dashboard** — today at a glance: events, chores, groceries, spend, maintenance, reminders
- **Family** — members, roles, points leaderboard, email invitations
- **Calendar** — month grid, upcoming list, add/delete events per member & category
- **Chores & Rewards** — check off chores, points awarded to kids, recurring chores, progress bar
- **Groceries** — shared list, categories, check-off, clear-checked
- **Home Maintenance** — recurring household tasks with due/overdue status
- **Expenses** — spending log with per-category monthly breakdown
- **Document Vault** — searchable metadata vault with categories & expiry dates
- **Reminder Center** — priorities, assignees, active/done filters

## PWA

Installable via `public/manifest.webmanifest`; an offline-first service worker (`public/sw.js`) is registered in production builds.

## Architecture

- `src/api/demo.ts` — seed data + localStorage persistence
- `src/api/client.ts` — typed API surface used by every page (swap to HTTP calls when the backend is running)
- `src/pages/*` — one screen per module, all interactive
- `server/index.ts` + `server/prisma/schema.prisma` — Fastify REST API mirroring the demo data model
- `src/test/*` — Vitest: store tests + component/integration tests
