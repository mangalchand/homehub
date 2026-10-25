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
cp src/infra/docker-compose.aws.yml docker-compose.yml
cp src/infra/Caddyfile Caddyfile

SITE_HOST=$(cat "$IN/site-host")
DB_HOST=$(cat "$IN/db-host")
DB_NAME=$(sed -n 's/^DB_NAME=//p' "$IN/app.env")
DB_USER=$(sed -n 's/^DB_USER=//p' "$IN/app.env")
PW=$(cat "$IN/dbpw")

# Keep the encryption key across deploys (provider tokens are encrypted with it).
KEY=$( [ -f .env ] && sed -n 's/^ENCRYPTION_KEY=//p' .env || true )
[ -n "$KEY" ] || KEY=$(openssl rand -base64 32)

(umask 077; {
  grep -vE '^(DB_NAME|DB_USER)=' "$IN/app.env"
  echo "DATABASE_URL=postgresql://${DB_USER}:${PW}@${DB_HOST}:5432/${DB_NAME}?sslmode=require"
  echo "ENCRYPTION_KEY=${KEY}"
  echo "SITE_HOST=${SITE_HOST}"
  echo "WEB_ORIGIN=https://${SITE_HOST}"
  echo "API_PUBLIC_URL=https://${SITE_HOST}"
} > .env.new)
mv .env.new .env
chmod 600 .env
rm -rf "$IN"

docker compose build --pull
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
echo "remote deploy finished"
