#!/bin/sh
# Nightly backup on the Lightsail server (installed to /etc/cron.d by remote-deploy.sh).
# Keeps 14 days of database dumps and photo archives in /opt/familyhub/backups.
set -eu
cd /opt/familyhub
mkdir -p backups
d=$(date -u +%F)
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --format=custom' > "backups/db-$d.dump.tmp"
mv "backups/db-$d.dump.tmp" "backups/db-$d.dump"
tar -czf "backups/uploads-$d.tar.gz" -C /var/lib/docker/volumes/familyhub_uploads/_data .
find backups -type f -mtime +14 -delete
