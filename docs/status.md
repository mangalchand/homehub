# Implementation status

Last updated with the current branch. "Verified" means exercised by automated tests or a recorded local run, not just written.

## Verified

| Area | How it was verified |
| --- | --- |
| Email/password auth, DB-backed sessions, CSRF double-submit | API integration tests; Playwright login tests |
| Tenant isolation (non-members get 404) | API integration tests |
| Roles (Owner, Adult admin, Adult, Child, Guest) and capability checks | API unit + integration tests |
| Calendar privacy: private / busy-only / selected calendars, private events | API unit + integration tests; e2e "Busy" rendering |
| Recurring events (RRULE, EXDATE, this / following / all edits), DST-safe expansion | API unit + integration tests |
| ICS file import and ICS/webcal subscription with SSRF protection | API unit tests (parser), integration test (private-IP blocked) |
| Chores with points, approvals, undo; reward redemption with point reservation | API integration tests |
| Shared lists: idempotent client-ID creates, version conflicts, grocery categories, CSV export | API integration tests; e2e add/check-off |
| Household-timezone display in the web app | Web unit tests; screenshots |
| Wall dashboard, calendar, chores, rewards, lists, family, settings screens | Playwright (desktop + tablet viewports) |
| Lint, typecheck, unit/integration tests, production build | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` |
| Docker images for API and web | `docker build` of both Dockerfiles |

## Implemented but not verified against live services

- **Google Calendar and Microsoft 365/Outlook** two-way sync (OAuth + PKCE, token encryption, incremental sync, pending-until-confirmed writes). Written against the documented REST APIs and exercised only with the in-repo demo provider. Requires OAuth client credentials to verify. See [integrations.md](integrations.md).
- **Email delivery** for invitations and password reset: links are logged in development; no SMTP/provider is wired.
- **Offline replay** of queued mutations (IndexedDB queue) is unit-level only; not yet exercised in an automated offline browser test.

## Not implemented yet

- iCloud two-way CalDAV (published iCloud calendars work via ICS subscription, read-only).
- Weather, meal planning, budgeting, photo frame, smart-home and AI assistant modules (see [roadmap.md](roadmap.md)).
- Push notifications (Web Push). In-app notifications and event reminders exist.
- Multi-household switching is supported by the data model and UI selector, but has no dedicated tests.
