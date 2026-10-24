# Roadmap / backlog

Priority order, after the current release:

1. Live verification of Google and Microsoft sync with real OAuth clients; add recorded-fixture provider tests.
2. Email provider (invites, password reset, reminder digests) and Web Push notifications.
3. Automated offline e2e (Playwright `context.setOffline`) covering queued list and chore mutations.
4. Passkeys / TOTP for adult accounts.
5. Weather widget (Open-Meteo, no key) and photo-frame screensaver for night mode.
6. Meal planner that feeds the grocery list.
7. Routines (morning/bedtime checklists) for kids mode with visual timers.
8. iCloud CalDAV two-way sync.
9. Budget overview (manual entries / CSV import only; no bank credentials).
10. Horizontal scaling: Postgres LISTEN/NOTIFY for SSE fan-out, shared rate limiter.
