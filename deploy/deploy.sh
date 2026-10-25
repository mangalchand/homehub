#!/usr/bin/env bash
# FamilyHub Pro: one-command AWS deployment for macOS/Linux (same steps as deploy.ps1).
#   ./deploy/deploy.sh
# Reads deploy/familyhub.config (+ optional deploy/secrets.env). Safe to re-run.
# Needs: AWS CLI v2 (logged in), git, ssh, scp, curl, openssl.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

declare -A CFG=()
SECRET_LINES=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"; [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" == *=* ]] || continue
  CFG["${line%%=*}"]="${line#*=}"
done < "$HERE/familyhub.config"
if [ -f "$HERE/secrets.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"; [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *=?* ]] && SECRET_LINES+=("$line")
  done < "$HERE/secrets.env"
fi
cfg() { local v="${CFG[$1]:-}"; [ -n "$v" ] && echo "$v" || echo "${2:-}"; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
nn() { [ -n "$1" ] && [ "$1" != "None" ]; }
q() { aws "$@" 2>/dev/null || true; }

P=$(cfg PROJECT_NAME familyhub)
export AWS_DEFAULT_REGION=$(cfg AWS_REGION us-east-1)
[ -n "$(cfg AWS_PROFILE)" ] && export AWS_PROFILE=$(cfg AWS_PROFILE)
STATE=$(cfg STATE_DIR '~/.familyhub-deploy'); STATE="${STATE/#\~/$HOME}"; mkdir -p "$STATE"
KEY_NAME="$P-key"; KEY_FILE="$STATE/$KEY_NAME.pem"; PW_FILE="$STATE/db-password.txt"; KNOWN="$STATE/known_hosts"

step "Checking tools and AWS login"
for t in aws git ssh scp curl openssl; do command -v $t >/dev/null || { echo "$t is required" >&2; exit 1; }; done
echo "AWS identity: $(aws sts get-caller-identity --query Arn --output text) (region $AWS_DEFAULT_REGION)"

step "SSH key pair $KEY_NAME"
if ! nn "$(q ec2 describe-key-pairs --key-names "$KEY_NAME" --query 'KeyPairs[0].KeyName' --output text)"; then
  aws ec2 create-key-pair --key-name "$KEY_NAME" --key-type ed25519 --query KeyMaterial --output text > "$KEY_FILE"
  echo "Created; private key saved to $KEY_FILE"
elif [ ! -f "$KEY_FILE" ]; then
  echo "Key pair $KEY_NAME exists in AWS but $KEY_FILE is missing" >&2; exit 1
fi
sed -i.bak 's/\r$//' "$KEY_FILE" && rm -f "$KEY_FILE.bak"; chmod 600 "$KEY_FILE"
[ -f "$PW_FILE" ] || { openssl rand -base64 24 | tr '+/=' 'xxx' | tr -d '\n' > "$PW_FILE"; chmod 600 "$PW_FILE"; echo "Generated database password in $PW_FILE"; }

step "Network and security groups"
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
AZ=$(cfg AWS_AZ "${AWS_DEFAULT_REGION}a")
SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" "Name=availability-zone,Values=$AZ" --query 'Subnets[0].SubnetId' --output text)
sg() {
  local id; id=$(q ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC" "Name=group-name,Values=$1" --query 'SecurityGroups[0].GroupId' --output text)
  if ! nn "$id"; then
    id=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC" --query GroupId --output text)
    aws ec2 create-tags --resources "$id" --tags "Key=Project,Value=$P" >/dev/null
  fi
  echo "$id"
}
WEB_SG=$(sg "$P-web-sg" 'FamilyHub Pro web (HTTP/HTTPS/SSH)')
DB_SG=$(sg "$P-rds-sg" 'FamilyHub Pro Postgres (from web only)')
for port in 80 443; do q ec2 authorize-security-group-ingress --group-id "$WEB_SG" --protocol tcp --port $port --cidr 0.0.0.0/0 >/dev/null; done
SSH_CIDR=$(cfg SSH_ALLOWED_CIDR auto); [ "$SSH_CIDR" = auto ] && SSH_CIDR="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')/32"
q ec2 authorize-security-group-ingress --group-id "$WEB_SG" --protocol tcp --port 22 --cidr "$SSH_CIDR" >/dev/null
q ec2 authorize-security-group-ingress --group-id "$DB_SG" --protocol tcp --port 5432 --source-group "$WEB_SG" >/dev/null
echo "web SG $WEB_SG (SSH from $SSH_CIDR), db SG $DB_SG"

DB_ID="$P-db"; step "RDS PostgreSQL $DB_ID"
DB_CLASS=$(cfg DB_INSTANCE_CLASS db.t4g.micro); DB_STORAGE=$(cfg DB_STORAGE_GB 20); DB_BACKUP=$(cfg DB_BACKUP_DAYS 1)
CUR=$(q rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].[DBInstanceClass,AllocatedStorage,BackupRetentionPeriod]' --output text)
if ! nn "$CUR"; then
  aws rds create-db-instance --db-instance-identifier "$DB_ID" --engine postgres --engine-version "$(cfg DB_ENGINE_VERSION 16)" \
    --db-instance-class "$DB_CLASS" --allocated-storage "$DB_STORAGE" --storage-type gp3 --storage-encrypted \
    --master-username "$(cfg DB_USER familyhub)" --master-user-password "file://$PW_FILE" --db-name "$(cfg DB_NAME familyhub)" \
    --vpc-security-group-ids "$DB_SG" --no-publicly-accessible --backup-retention-period "$DB_BACKUP" --no-multi-az \
    --tags "Key=Project,Value=$P" >/dev/null
  echo "Creating database (takes 5-10 minutes the first time)..."
else
  read -r C_CLASS C_STORAGE C_BACKUP <<<"$CUR"; MODS=()
  [ "$C_CLASS" != "$DB_CLASS" ] && MODS+=(--db-instance-class "$DB_CLASS")
  [ "$C_STORAGE" -lt "$DB_STORAGE" ] && MODS+=(--allocated-storage "$DB_STORAGE")
  [ "$C_BACKUP" != "$DB_BACKUP" ] && MODS+=(--backup-retention-period "$DB_BACKUP")
  if [ ${#MODS[@]} -gt 0 ]; then echo "Updating database: ${MODS[*]}"; aws rds modify-db-instance --db-instance-identifier "$DB_ID" "${MODS[@]}" --apply-immediately >/dev/null
  else echo "Database exists and matches config"; fi
fi
aws rds wait db-instance-available --db-instance-identifier "$DB_ID"
DB_HOST=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
echo "Database ready: $DB_HOST"

NAME="$P-server"; step "EC2 server $NAME"
TYPE=$(cfg EC2_INSTANCE_TYPE t3.small)
CUR=$(q ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" 'Name=instance-state-name,Values=pending,running,stopping,stopped' --query 'Reservations[0].Instances[0].[InstanceId,InstanceType,State.Name]' --output text)
if ! nn "$CUR"; then
  AMI=$(aws ec2 describe-images --owners 099720109477 --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
  ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY_NAME" \
    --security-group-ids "$WEB_SG" --subnet-id "$SUBNET" --associate-public-ip-address \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$(cfg EC2_VOLUME_GB 30),VolumeType=gp3,Encrypted=true}" \
    --user-data "file://$HERE/server-init.sh" --metadata-options HttpTokens=required \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=$P}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "Launched $ID"
else
  read -r ID C_TYPE C_STATE <<<"$CUR"
  if [ "$C_TYPE" != "$TYPE" ]; then
    echo "Resizing $ID from $C_TYPE to $TYPE (brief downtime)"
    aws ec2 stop-instances --instance-ids "$ID" >/dev/null; aws ec2 wait instance-stopped --instance-ids "$ID"
    aws ec2 modify-instance-attribute --instance-id "$ID" --instance-type "Value=$TYPE"
    aws ec2 start-instances --instance-ids "$ID" >/dev/null
  elif [ "$C_STATE" = stopped ] || [ "$C_STATE" = stopping ]; then
    aws ec2 wait instance-stopped --instance-ids "$ID"; aws ec2 start-instances --instance-ids "$ID" >/dev/null
  fi
fi
aws ec2 wait instance-running --instance-ids "$ID"

step "Elastic IP $P-eip"
EIP=$(q ec2 describe-addresses --filters "Name=tag:Name,Values=$P-eip" --query 'Addresses[0].[AllocationId,PublicIp,InstanceId]' --output text)
nn "$EIP" || EIP=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$P-eip},{Key=Project,Value=$P}]" --query '[AllocationId,PublicIp]' --output text)
read -r ALLOC IP ASSOC <<<"$EIP"
[ "${ASSOC:-}" = "$ID" ] || aws ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
echo "Server $ID at $IP"
DOMAIN=$(cfg DOMAIN); SITE_HOST=${DOMAIN:-${IP//./-}.sslip.io}

SSH=(-i "$KEY_FILE" -o "UserKnownHostsFile=$KNOWN" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
T="ubuntu@$IP"
step "Waiting for the server to finish setup"
for i in $(seq 1 40); do
  ssh "${SSH[@]}" "$T" 'cloud-init status --wait >/dev/null 2>&1; docker compose version >/dev/null && echo READY' 2>/dev/null | grep -q READY && break
  [ "$i" = 40 ] && { echo "Server $IP is not reachable over SSH" >&2; exit 1; }; sleep 10
done

step "Packaging committed source code"
cd "$ROOT"
[ -n "$(git status --porcelain)" ] && echo "WARNING: uncommitted changes are not deployed; only committed code is."
REV=$(git rev-parse --short HEAD); TMP=$(mktemp -d)
git archive --format=tar.gz -o "$TMP/source.tar.gz" HEAD
{
  for k in "${!CFG[@]}"; do [[ "$k" == APP_* ]] && echo "${k#APP_}=${CFG[$k]}"; done
  echo "DB_NAME=$(cfg DB_NAME familyhub)"; echo "DB_USER=$(cfg DB_USER familyhub)"
  for l in "${SECRET_LINES[@]}"; do echo "$l"; done
} > "$TMP/app.env"
printf '%s' "$DB_HOST" > "$TMP/db-host"; printf '%s' "$SITE_HOST" > "$TMP/site-host"
cp "$HERE/remote-deploy.sh" "$TMP/"; cp "$PW_FILE" "$TMP/dbpw"

step "Uploading revision $REV to $IP"
ssh "${SSH[@]}" "$T" 'rm -rf /opt/familyhub/incoming && mkdir -p /opt/familyhub/incoming'
scp "${SSH[@]}" -q "$TMP"/* "$T:/opt/familyhub/incoming/"
rm -rf "$TMP"

step "Building and starting containers on the server (a few minutes)"
ssh "${SSH[@]}" "$T" 'bash /opt/familyhub/incoming/remote-deploy.sh'

step "Health check"
for i in $(seq 1 40); do curl -fsS -m 10 "https://$SITE_HOST/readyz" >/dev/null 2>&1 && break; [ "$i" = 40 ] && { echo "https://$SITE_HOST/readyz did not become healthy" >&2; exit 1; }; sleep 5; done
printf '\n\033[32mFamilyHub Pro is live:  https://%s\033[0m\nRevision: %s\nSSH: ssh -i "%s" ubuntu@%s\n' "$SITE_HOST" "$REV" "$KEY_FILE" "$IP"
