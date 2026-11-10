#!/bin/bash
# Lightsail first boot: swap, Docker, /opt/familyhub. Postgres runs in Docker (see infra/docker-compose.lightsail.yml).
set -eux
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=20 && echo 'vm.swappiness=20' > /etc/sysctl.d/99-familyhub.conf
apt-get update
apt-get install -y ca-certificates curl postgresql-client
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker ubuntu
mkdir -p /opt/familyhub/backups && chown -R ubuntu:ubuntu /opt/familyhub
