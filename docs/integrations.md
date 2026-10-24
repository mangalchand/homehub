# Calendar integrations

| Source | Mode | Status |
| --- | --- | --- |
| Internal calendars | read/write | Verified |
| ICS / webcal subscription (school, sports, public iCloud) | read-only, refreshed on a schedule | Verified (local tests) |
| `.ics` file import | read-only snapshot | Verified |
| Google Calendar | two-way | Implemented, **not verified live** |
| Microsoft 365 / Outlook.com | two-way | Implemented, **not verified live** |
| Apple iCloud (CalDAV) | — | Not implemented; use a public ICS link |

## Google setup

1. Google Cloud Console → create project → enable **Google Calendar API**.
2. OAuth consent screen (External, add test users while unverified). Scope: `https://www.googleapis.com/auth/calendar`.
3. Credentials → OAuth client (Web). Redirect URI: `${API_PUBLIC_URL}/api/v1/integrations/google/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart the API. The "Connect Google Calendar" button becomes active in Settings.

## Microsoft setup

1. Entra admin center → App registrations → New (accounts in any org + personal Microsoft accounts).
2. Redirect URI (Web): `${API_PUBLIC_URL}/api/v1/integrations/microsoft/callback`.
3. API permissions (delegated): `Calendars.ReadWrite`, `offline_access`, `User.Read`.
4. Create a client secret. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT=common`.

## Sync semantics

- Incremental sync (Google `syncToken`, Microsoft delta links) on each calendar's refresh interval, plus manual "Sync" in Settings.
- Local edits are saved as pending, pushed by the worker, and only marked synced on provider success; failures surface on the event with a Retry action.
- If a remote change arrives while a local edit is pending, a conflict is recorded and shown instead of silently overwriting either side.
- Disconnecting revokes the token where the provider supports it and removes the imported calendars.
