#!/usr/bin/env bash
# Build images locally and ship them to the EC2 host over SSH (no registry needed).
set -euo pipefail
HOST="${FAMILYHUB_HOST:-ubuntu@44.198.103.49}"
KEY="${FAMILYHUB_KEY:-$HOME/.familyhub-deploy/familyhub-key.pem}"
SITE="${FAMILYHUB_SITE:-https://44-198-103-49.sslip.io}"
cd "$(dirname "$0")/.."
docker build -f infra/api.Dockerfile -t familyhub-api:latest .
docker build -f infra/web.Dockerfile -t familyhub-web:latest .
docker save familyhub-api:latest familyhub-web:latest | gzip -1 | ssh -i "$KEY" "$HOST" 'gunzip | docker load'
scp -i "$KEY" infra/docker-compose.aws.yml "$HOST:/opt/familyhub/docker-compose.yml"
scp -i "$KEY" infra/Caddyfile "$HOST:/opt/familyhub/Caddyfile"
ssh -i "$KEY" "$HOST" 'cd /opt/familyhub && docker compose up -d --remove-orphans && docker image prune -f >/dev/null'
for i in $(seq 1 30); do
  if curl -fsS "$SITE/readyz" >/dev/null; then echo "Deployed: $SITE"; exit 0; fi
  sleep 3
done
echo "Deployment did not become ready" >&2
exit 1
