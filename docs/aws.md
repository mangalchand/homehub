# AWS deployment (current production)

| Piece | Resource |
| --- | --- |
| App server | EC2 `familyhub-server` (t3.small, Ubuntu 24.04, 30 GB encrypted gp3), Elastic IP `44.198.103.49` |
| HTTPS | Caddy with an automatic Let's Encrypt certificate for `44-198-103-49.sslip.io` |
| Database | RDS PostgreSQL 16 `familyhub-db` (db.t4g.micro, encrypted, private, 1-day automated backups — free-tier limit) |
| Photos | Docker volume `uploads` on the EC2 disk (the IAM user has no S3 access; set `STORAGE_DRIVER=s3` + `S3_BUCKET` once it does) |
| Network | `familyhub-web-sg`: 80/443 public, 22 restricted; `familyhub-rds-sg`: 5432 only from the web SG |

Stack definition: [`infra/docker-compose.aws.yml`](../infra/docker-compose.aws.yml) + [`infra/Caddyfile`](../infra/Caddyfile), deployed to `/opt/familyhub`. Secrets live only in `/opt/familyhub/.env` on the server (mode 600): `DATABASE_URL`, `ENCRYPTION_KEY` (generated on the server), `WEB_ORIGIN`, `API_PUBLIC_URL`, `SITE_HOST`.

## Deploy an update

```bash
infra/deploy-aws.sh            # builds images, ships them over SSH, restarts, checks /readyz
```

Requires the SSH key (`familyhub-key`) and port 22 allowed from your IP in `familyhub-web-sg`.

## Use a real domain later

Point an `A` record (e.g. `hub.example.com`) at `44.198.103.49`, set `SITE_HOST`, `WEB_ORIGIN` and `API_PUBLIC_URL` in `/opt/familyhub/.env`, `docker compose up -d`, and rebuild the APK with `FAMILYHUB_URL=https://hub.example.com`.

## Cost (us-east-1, on-demand)

EC2 t3.small ≈ $15/mo, EBS 30 GB ≈ $2.40, Elastic IP ≈ $3.60, RDS db.t4g.micro + 20 GB ≈ $14 (free for 12 months on a free-tier account). Total ≈ $21–35/month.

## Backups

RDS automated snapshots (1 day on free tier; raise to 7+ after upgrading the account plan). Photos: `docker run --rm -v familyhub_uploads:/d -v $PWD:/b alpine tar czf /b/photos-$(date +%F).tgz -C /d .` on the server.
