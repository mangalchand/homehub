#!/usr/bin/env bash
# Runs ON the server. Called by deploy.ps1 / deploy.sh after they upload:
#   /opt/familyhub/incoming/{source.tar.gz, app.env, dbpw, db-host, site-host}
set -euo pipefail
cd /opt/familyhub
IN=incoming
# Source files must stay world-readable (nginx serves them); only .env is private.
umask 022

# Fresh copy of the source.
rm -rf src && mkdir src && tar -xzf "$IN/source.tar.gz" -C src
cp src/infra/Caddyfile Caddyfile

mkdir -p secrets
if [ -f "$IN/firebase-service-account.json" ]; then install -m 644 "$IN/firebase-service-account.json" secrets/firebase-service-account.json; fi
SITE_HOST=$(cat "$IN/site-host")
DB_HOST=$(cat "$IN/db-host")
DB_NAME=$(sed -n 's/^DB_NAME=//p' "$IN/app.env")
DB_USER=$(sed -n 's/^DB_USER=//p' "$IN/app.env")
PW=$(cat "$IN/dbpw")
UP_ARGS=()
[ -f "$IN/no-worker" ] && UP_ARGS+=(--scale worker=0)

if [ "$DB_HOST" = local ]; then
  # Lightsail: Postgres runs in the db container on this server.
  cp src/infra/docker-compose.lightsail.yml docker-compose.yml
  DATABASE_URL="postgresql://${DB_USER}:${PW}@db:5432/${DB_NAME}"
  (umask 077; printf 'POSTGRES_DB=%s\nPOSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\n' "$DB_NAME" "$DB_USER" "$PW" > .db.env)
  install -m 755 src/infra/pg-backup.sh backup.sh
  echo '15 3 * * * root /opt/familyhub/backup.sh >> /var/log/familyhub-backup.log 2>&1' | sudo tee /etc/cron.d/familyhub-backup >/dev/null
else
  cp src/infra/docker-compose.aws.yml docker-compose.yml
  DATABASE_URL="postgresql://${DB_USER}:${PW}@${DB_HOST}:5432/${DB_NAME}?sslmode=require"
fi

# Keep the encryption key across deploys (provider tokens are encrypted with it).
KEY=$( [ -f .env ] && sed -n 's/^ENCRYPTION_KEY=//p' .env || true )
[ -n "$KEY" ] || KEY=$( [ -f "$IN/encryption-key" ] && tr -d '\r\n' < "$IN/encryption-key" || true )
[ -n "$KEY" ] || KEY=$(openssl rand -base64 32)

(umask 077; {
  grep -vE '^(DB_NAME|DB_USER)=' "$IN/app.env"
  echo "DATABASE_URL=${DATABASE_URL}"
  echo "ENCRYPTION_KEY=${KEY}"
  echo "SITE_HOST=${SITE_HOST}"
  echo "WEB_ORIGIN=https://${SITE_HOST}"
  echo "API_PUBLIC_URL=https://${SITE_HOST}"
  [ -f secrets/firebase-service-account.json ] && echo "FIREBASE_SERVICE_ACCOUNT_FILE=/run/familyhub/firebase-service-account.json"
} > .env.new)
mv .env.new .env
chmod 600 .env
rm -rf "$IN"

docker compose build --pull
docker compose up -d --remove-orphans "${UP_ARGS[@]}"
docker image prune -f >/dev/null
docker builder prune -f --keep-storage 3gb >/dev/null || true
echo "remote deploy finished"
