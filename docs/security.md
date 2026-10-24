# Security model

## Controls

| Threat | Control |
| --- | --- |
| Credential theft | Argon2id password hashing; rate-limited login; generic error messages |
| Session hijack / XSS token theft | Opaque session tokens in HTTP-only, `SameSite=Lax`, `Secure` (prod) cookies; stored as SHA-256 hashes |
| CSRF | Double-submit `fh_csrf` cookie + `x-csrf-token` header on every mutating request |
| Cross-household access | Every household route resolves membership first; non-members get 404 (no ID probing) |
| Privilege escalation | Capability checks in `packages/shared/permissions.ts`, enforced in API middleware; UI checks are cosmetic only |
| Private calendar leakage | Server-side privacy filter (busy blocks only) before serialization; covered by tests |
| SSRF via ICS URLs | Scheme allow-list, DNS resolution with private/link-local/loopback blocking, re-check on redirect, size + time limits |
| Provider token theft | AES-256-GCM encryption at rest with `ENCRYPTION_KEY`; tokens never sent to the browser |
| OAuth CSRF / code interception | `state` + PKCE (S256); short-lived state records |
| Shared-tablet misuse | Device sessions are scoped to one household; adult actions require PIN elevation (5 min), PIN attempts are rate-limited and audited |
| CSV formula injection | Exported cells beginning with `= + - @` are prefixed |
| Clickjacking / sniffing | Helmet headers (CSP, frame-ancestors, nosniff, referrer policy) |
| Accountability | Audit log for membership, role, device, PIN, calendar connect and data export events |

## Operational requirements

- Generate `ENCRYPTION_KEY` with `openssl rand -base64 32`; store in your secret manager. Rotating it requires re-connecting provider accounts.
- Run behind HTTPS and set `COOKIE_SECURE=true`.
- `ENABLE_DEMO_PROVIDER` is refused when `NODE_ENV=production`.
- Back up Postgres daily (see [operations.md](operations.md)). Household owners can export all data as JSON from Settings.

## Known gaps

- No 2FA/passkeys yet.
- No email verification; invitations rely on possession of the link.
- Rate limiting is in-process (per instance).
