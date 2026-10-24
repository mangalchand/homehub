# Architecture

```
 Browser / wall tablet (PWA)                     Server                                   Data
┌────────────────────────────┐   HTTPS (same   ┌─────────────────────────────┐        ┌──────────────┐
│ React + Vite               │   origin via    │ Express API (apps/api)      │ Prisma │ PostgreSQL   │
│ TanStack Query (persisted  │ ───────────────▶│  • auth / sessions / CSRF   │───────▶│ 16           │
│  to IndexedDB)             │   /api/v1       │  • household-scoped routers │        └──────────────┘
│ Offline mutation queue     │ ◀───────────────│  • privacy filter on output │
│ SSE client → invalidations │   SSE /stream   │  • in-process SSE bus       │        ┌──────────────┐
│ Service worker (Workbox)   │                 │ Worker (same image)         │ HTTPS  │ Google / MS  │
└────────────────────────────┘                 │  • calendar sync, retries   │───────▶│ Graph / ICS  │
                                               │  • reminders, cleanup       │        └──────────────┘
                                               └─────────────────────────────┘
```

## Key decisions

- **Monorepo** (pnpm workspaces): `packages/shared` holds Zod schemas, enums, permission rules and DTO types so the API and web agree on contracts at compile time.
- **REST + OpenAPI** generated from the same Zod schemas used for validation (`/api/openapi.json`, Swagger UI at `/api/docs`).
- **Sessions, not JWTs**: opaque tokens stored hashed in Postgres, HTTP-only `SameSite=Lax` cookies, CSRF double-submit header. Revocation is immediate (sign out everywhere, device revoke).
- **Wall displays are device actors**, paired with a one-time code. They get read access plus child-level actions; adult actions require a short-lived household PIN elevation.
- **Privacy is enforced server-side** before serialization (`calendar/access.ts`): unauthorized callers receive busy blocks without title, location or attendees.
- **Recurrence** is stored as RRULE on the master event with exception rows; expansion happens per request in the event's own timezone (Luxon + rrule) so DST transitions keep wall-clock times.
- **Provider sync** is adapter-based (`calendar/providers/*`). Local edits to external events are stored as `PENDING_*` and only marked `SYNCED` after the provider confirms; remote changes never overwrite pending local edits (a conflict is recorded instead).
- **Realtime** uses Server-Sent Events from an in-process bus. For horizontal scaling, swap the bus for Postgres `LISTEN/NOTIFY` or Redis (single interface in `apps/api/src/lib/realtime.ts`).
- **Offline**: queries are persisted to IndexedDB; list/chore mutations carry client-generated IDs and versions so replay is idempotent and conflicts are detected.

## Data model (summary)

`User` ─< `HouseholdMember` >─ `Household` ─< `Calendar` ─< `Event` ─< `EventException`
`Household` ─< `Task` ─< `ChoreCompletion`, `Reward` ─< `RewardTransaction`, `List` ─< `ListItem`,
`Announcement`, `DashboardLayout`, `Device`, `Invitation`, `AuditLog`, `Notification`,
`CalendarAccount` (encrypted tokens) ─< `Calendar` ─ `CalendarSyncState`, `SyncRun`, `SyncConflict`.

Full schema: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).
