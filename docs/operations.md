# Operations

## Health
- `GET /healthz` — process up. `GET /readyz` — database reachable. Both used by Docker health checks.
- Logs are JSON (pino) on stdout; secrets and cookies are redacted.

## Backups
```bash
docker compose exec postgres pg_dump -U familyhub familyhub | gzip > backup-$(date +%F).sql.gz
```
Schedule daily (cron) and copy off-box. Restore with `gunzip -c file | docker compose exec -T postgres psql -U familyhub familyhub`.

## Upgrades
`git pull && docker compose up --build -d` — migrations apply on API start.

## Troubleshooting
| Symptom | Check |
| --- | --- |
| Login loops back to sign-in | `WEB_ORIGIN` must match the browser origin; `COOKIE_SECURE=true` requires HTTPS |
| Calendar shows a warning icon | Settings → Calendars shows the last sync error; use Sync to retry |
| ICS link rejected | Private/LAN addresses are blocked by design; use a public URL |
| Wall display signed out | Device was revoked or session expired; pair again from Settings → Wall displays |
| Times look shifted | Household timezone (Settings) drives display, not the tablet's clock zone |
