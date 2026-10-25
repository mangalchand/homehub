# AWS deployment (current production)

| Piece | Resource |
| --- | --- |
| App server | EC2 `familyhub-server` (t3.small, Ubuntu 24.04, 30 GB encrypted gp3), Elastic IP `44.198.103.49` |
| HTTPS | Caddy with an automatic Let's Encrypt certificate for `44-198-103-49.sslip.io` |
| Database | RDS PostgreSQL 16 `familyhub-db` (db.t4g.micro, encrypted, private, 1-day automated backups — free-tier limit) |
| Photos | Docker volume `uploads` on the EC2 disk (the IAM user has no S3 access; set `STORAGE_DRIVER=s3` + `S3_BUCKET` once it does) |
| Network | `familyhub-web-sg`: 80/443 public, 22 restricted; `familyhub-rds-sg`: 5432 only from the web SG |

Stack definition: [`infra/docker-compose.aws.yml`](../infra/docker-compose.aws.yml) + [`infra/Caddyfile`](../infra/Caddyfile), deployed to `/opt/familyhub`. Secrets live only in `/opt/familyhub/.env` on the server (mode 600): `DATABASE_URL`, `ENCRYPTION_KEY` (generated on the server), `WEB_ORIGIN`, `API_PUBLIC_URL`, `SITE_HOST`.

## Configuration and deployment files

| File | Purpose |
| --- | --- |
| [`deploy/familyhub.config`](../deploy/familyhub.config) | **All settings** in one place: AWS region, server size, database size and backups, domain, SSH access, and app settings (`APP_*`, e.g. session length, photo storage, Google/Microsoft client IDs) |
| `deploy/secrets.env` | Secrets only (OAuth client secrets, SMTP). Copy from [`deploy/secrets.example.env`](../deploy/secrets.example.env). Git-ignored. |
| [`deploy/deploy.ps1`](../deploy/deploy.ps1) | One-command deploy for Windows |
| [`deploy/deploy.sh`](../deploy/deploy.sh) | Same for macOS/Linux |
| [`deploy/server-init.sh`](../deploy/server-init.sh) | First-boot setup of a new server (Docker, swap) |
| [`deploy/remote-deploy.sh`](../deploy/remote-deploy.sh) | Runs on the server: unpacks code, writes `.env`, builds and restarts containers |
| [`infra/docker-compose.aws.yml`](../infra/docker-compose.aws.yml), [`infra/Caddyfile`](../infra/Caddyfile) | The production container stack and HTTPS proxy |

## Deploy (first time or update)

```cmd
cd path\to\homehub
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
```

The script creates anything missing (key pair, security groups, RDS, EC2, Elastic IP), updates what changed in the config (e.g. a bigger `EC2_INSTANCE_TYPE` or `DB_INSTANCE_CLASS`), uploads the **committed** code, rebuilds the containers on the server and waits for `https://<site>/readyz`. Re-running it is safe.

Local state (SSH key, generated DB password) is kept in `STATE_DIR` (default `%USERPROFILE%\.familyhub-deploy`). Back that folder up. The server's `ENCRYPTION_KEY` is generated on the server and preserved across deploys.

## Use a real domain later

Point an `A` record (e.g. `hub.example.com`) at `44.198.103.49`, set `DOMAIN=hub.example.com` in `deploy/familyhub.config`, run the deploy script, and rebuild the APK with `FAMILYHUB_URL=https://hub.example.com`.

## Cost (us-east-1, on-demand)

EC2 t3.small ≈ $15/mo, EBS 30 GB ≈ $2.40, Elastic IP ≈ $3.60, RDS db.t4g.micro + 20 GB ≈ $14 (free for 12 months on a free-tier account). Total ≈ $21–35/month.

## Backups

RDS automated snapshots (1 day on free tier; raise to 7+ after upgrading the account plan). Photos: `docker run --rm -v familyhub_uploads:/d -v $PWD:/b alpine tar czf /b/photos-$(date +%F).tgz -C /d .` on the server.
