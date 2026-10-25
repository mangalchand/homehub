<#
  FamilyHub Pro: one-command AWS deployment for Windows.

  Usage (from the repo folder, in cmd or PowerShell):
    powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1

  Reads deploy\familyhub.config (+ optional deploy\secrets.env), then:
    1. creates or updates AWS resources: key pair, security groups, RDS PostgreSQL, EC2, Elastic IP
    2. uploads the committed source code to the server
    3. builds and starts the containers there, and waits until the site is healthy
  Safe to re-run: existing resources are found by name and reused.
  Needs: AWS CLI v2 (logged in), Git, OpenSSH client (built into Windows 10/11).
#>
param([switch]$SkipInfra)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Read-KV([string]$Path) {
  $h = [ordered]@{}
  if (Test-Path $Path) {
    foreach ($line in Get-Content $Path) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $h[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
  }
  return $h
}
$Config = Read-KV (Join-Path $PSScriptRoot 'familyhub.config')
$Secrets = Read-KV (Join-Path $PSScriptRoot 'secrets.env')
function Cfg([string]$Key, [string]$Default = '') { if ($Config.Contains($Key) -and $Config[$Key] -ne '') { return $Config[$Key] } return $Default }

function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Aws {
  $ErrorActionPreference = 'Continue'
  $out = & aws @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed:`n$($out | Out-String)" }
  return ($out | Out-String).Trim()
}
function AwsTry {
  $ErrorActionPreference = 'Continue'
  $out = & aws @args 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $s = ($out | Out-String).Trim()
  if ($s -eq '' -or $s -eq 'None') { return $null }
  return $s
}
function Write-Lf([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
}

$P = Cfg 'PROJECT_NAME' 'familyhub'
$env:AWS_DEFAULT_REGION = Cfg 'AWS_REGION' 'us-east-1'
if (Cfg 'AWS_PROFILE') { $env:AWS_PROFILE = Cfg 'AWS_PROFILE' }
$State = (Cfg 'STATE_DIR' '~/.familyhub-deploy') -replace '^~', $HOME
New-Item -ItemType Directory -Force $State | Out-Null
$KeyName = "$P-key"
$KeyFile = Join-Path $State "$KeyName.pem"
$PwFile = Join-Path $State 'db-password.txt'
$KnownHosts = Join-Path $State 'known_hosts'

Step 'Checking tools and AWS login'
foreach ($tool in 'aws', 'git', 'ssh', 'scp') { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed or not on PATH" } }
$who = Aws sts get-caller-identity --query Arn --output text
Write-Host "AWS identity: $who (region $env:AWS_DEFAULT_REGION)"

# ---- SSH key -------------------------------------------------------------------
Step "SSH key pair $KeyName"
$exists = AwsTry ec2 describe-key-pairs --key-names $KeyName --query 'KeyPairs[0].KeyName' --output text
if (-not $exists) {
  $km = Aws ec2 create-key-pair --key-name $KeyName --key-type ed25519 --query KeyMaterial --output text
  Write-Lf $KeyFile ($km.Trim() + "`n")
  Write-Host "Created; private key saved to $KeyFile"
} elseif (-not (Test-Path $KeyFile)) {
  throw "Key pair $KeyName exists in AWS but $KeyFile is missing. Restore the file or delete the key pair in AWS."
}
icacls $KeyFile /grant:r "$($env:USERNAME):F" | Out-Null
$raw = [IO.File]::ReadAllText($KeyFile)
if ($raw.Contains("`r")) { Write-Lf $KeyFile $raw }
icacls $KeyFile /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null

if (-not (Test-Path $PwFile)) {
  $b = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [IO.File]::WriteAllText($PwFile, ([Convert]::ToBase64String($b) -replace '[+/=]', 'x'))
  Write-Host "Generated database password in $PwFile"
}

$WebSgName = "$P-web-sg"; $DbSgName = "$P-rds-sg"; $DbId = "$P-db"; $ServerName = "$P-server"; $EipName = "$P-eip"

# ---- Network -------------------------------------------------------------------
Step 'Network and security groups'
$Vpc = Aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text
$Az = Cfg 'AWS_AZ' "$($env:AWS_DEFAULT_REGION)a"
$Subnet = Aws ec2 describe-subnets --filters "Name=vpc-id,Values=$Vpc" "Name=availability-zone,Values=$Az" --query 'Subnets[0].SubnetId' --output text
function Get-Sg([string]$Name, [string]$Desc) {
  $id = AwsTry ec2 describe-security-groups --filters "Name=vpc-id,Values=$Vpc" "Name=group-name,Values=$Name" --query 'SecurityGroups[0].GroupId' --output text
  if (-not $id) {
    $id = Aws ec2 create-security-group --group-name $Name --description $Desc --vpc-id $Vpc --query GroupId --output text
    Aws ec2 create-tags --resources $id --tags "Key=Project,Value=$P" | Out-Null
  }
  return $id
}
$WebSg = Get-Sg $WebSgName 'FamilyHub Pro web (HTTP/HTTPS/SSH)'
$DbSg = Get-Sg $DbSgName 'FamilyHub Pro Postgres (from web only)'
foreach ($port in 80, 443) { AwsTry ec2 authorize-security-group-ingress --group-id $WebSg --protocol tcp --port $port --cidr 0.0.0.0/0 | Out-Null }
$SshCidr = Cfg 'SSH_ALLOWED_CIDR' 'auto'
if ($SshCidr -eq 'auto') { $SshCidr = ((Invoke-RestMethod -UseBasicParsing https://checkip.amazonaws.com) | Out-String).Trim() + '/32' }
AwsTry ec2 authorize-security-group-ingress --group-id $WebSg --protocol tcp --port 22 --cidr $SshCidr | Out-Null
AwsTry ec2 authorize-security-group-ingress --group-id $DbSg --protocol tcp --port 5432 --source-group $WebSg | Out-Null
Write-Host "web SG $WebSg (SSH from $SshCidr), db SG $DbSg"

# ---- Database ------------------------------------------------------------------
Step "RDS PostgreSQL $DbId"
$DbClass = Cfg 'DB_INSTANCE_CLASS' 'db.t4g.micro'
$DbStorage = [int](Cfg 'DB_STORAGE_GB' '20')
$DbBackup = Cfg 'DB_BACKUP_DAYS' '1'
$db = AwsTry rds describe-db-instances --db-instance-identifier $DbId --query 'DBInstances[0].[DBInstanceClass,AllocatedStorage,BackupRetentionPeriod]' --output text
if (-not $db) {
  Aws rds create-db-instance --db-instance-identifier $DbId --engine postgres --engine-version (Cfg 'DB_ENGINE_VERSION' '16') `
    --db-instance-class $DbClass --allocated-storage $DbStorage --storage-type gp3 --storage-encrypted `
    --master-username (Cfg 'DB_USER' 'familyhub') --master-user-password ("file://" + $PwFile) --db-name (Cfg 'DB_NAME' 'familyhub') `
    --vpc-security-group-ids $DbSg --no-publicly-accessible --backup-retention-period $DbBackup --no-multi-az `
    --tags "Key=Project,Value=$P" --query 'DBInstance.DBInstanceStatus' --output text | Out-Null
  Write-Host 'Creating database (takes 5-10 minutes the first time)...'
} else {
  $cur = $db -split '\s+'
  $mods = @()
  if ($cur[0] -ne $DbClass) { $mods += @('--db-instance-class', $DbClass) }
  if ([int]$cur[1] -lt $DbStorage) { $mods += @('--allocated-storage', "$DbStorage") }
  if ($cur[2] -ne $DbBackup) { $mods += @('--backup-retention-period', $DbBackup) }
  if ($mods.Count) {
    Write-Host "Updating database: $($mods -join ' ')"
    Aws rds modify-db-instance --db-instance-identifier $DbId @mods --apply-immediately --query 'DBInstance.DBInstanceStatus' --output text | Out-Null
  } else { Write-Host 'Database exists and matches config' }
}
Aws rds wait db-instance-available --db-instance-identifier $DbId | Out-Null
$DbHost = Aws rds describe-db-instances --db-instance-identifier $DbId --query 'DBInstances[0].Endpoint.Address' --output text
Write-Host "Database ready: $DbHost"

# ---- Server --------------------------------------------------------------------
Step "EC2 server $ServerName"
$Type = Cfg 'EC2_INSTANCE_TYPE' 't3.small'
$inst = AwsTry ec2 describe-instances --filters "Name=tag:Name,Values=$ServerName" 'Name=instance-state-name,Values=pending,running,stopping,stopped' --query 'Reservations[0].Instances[0].[InstanceId,InstanceType,State.Name]' --output text
if (-not $inst) {
  $Ami = Aws ec2 describe-images --owners 099720109477 --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text
  $ud = Join-Path $env:TEMP 'familyhub-server-init.sh'
  Write-Lf $ud ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'server-init.sh')))
  $InstanceId = Aws ec2 run-instances --image-id $Ami --instance-type $Type --key-name $KeyName `
    --security-group-ids $WebSg --subnet-id $Subnet --associate-public-ip-address `
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$(Cfg 'EC2_VOLUME_GB' '30'),VolumeType=gp3,Encrypted=true}" `
    --user-data ("file://" + $ud) --metadata-options 'HttpTokens=required' `
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$ServerName},{Key=Project,Value=$P}]" `
    --query 'Instances[0].InstanceId' --output text
  Write-Host "Launched $InstanceId"
} else {
  $cur = $inst -split '\s+'
  $InstanceId = $cur[0]
  if ($cur[1] -ne $Type) {
    Write-Host "Resizing $InstanceId from $($cur[1]) to $Type (brief downtime)"
    Aws ec2 stop-instances --instance-ids $InstanceId | Out-Null
    Aws ec2 wait instance-stopped --instance-ids $InstanceId | Out-Null
    Aws ec2 modify-instance-attribute --instance-id $InstanceId --instance-type "Value=$Type" | Out-Null
    Aws ec2 start-instances --instance-ids $InstanceId | Out-Null
  } elseif ($cur[2] -eq 'stopped' -or $cur[2] -eq 'stopping') {
    if ($cur[2] -eq 'stopping') { Aws ec2 wait instance-stopped --instance-ids $InstanceId | Out-Null }
    Aws ec2 start-instances --instance-ids $InstanceId | Out-Null
  }
}
Aws ec2 wait instance-running --instance-ids $InstanceId | Out-Null

Step "Elastic IP $EipName"
$eip = AwsTry ec2 describe-addresses --filters "Name=tag:Name,Values=$EipName" --query 'Addresses[0].[AllocationId,PublicIp,InstanceId]' --output text
if (-not $eip) {
  $eip = Aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$EipName},{Key=Project,Value=$P}]" --query '[AllocationId,PublicIp]' --output text
}
$e = $eip -split '\s+'
$AllocId = $e[0]; $Ip = $e[1]
if ($e.Count -lt 3 -or $e[2] -ne $InstanceId) { Aws ec2 associate-address --instance-id $InstanceId --allocation-id $AllocId | Out-Null }
Write-Host "Server $InstanceId at $Ip"

$Domain = Cfg 'DOMAIN'
$SiteHost = if ($Domain) { $Domain } else { ($Ip -replace '\.', '-') + '.sslip.io' }

# ---- Deploy app ----------------------------------------------------------------
$Ssh = @('-i', $KeyFile, '-o', "UserKnownHostsFile=$KnownHosts", '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes')
$Target = "ubuntu@$Ip"
Step 'Waiting for the server to finish setup'
$ready = $false
for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
  $ErrorActionPreference = 'Continue'
  $r = & ssh @Ssh $Target 'cloud-init status --wait >/dev/null 2>&1; docker compose version >/dev/null && echo READY' 2>$null
  $ErrorActionPreference = 'Stop'
  if ("$r" -match 'READY') { $ready = $true } else { Start-Sleep -Seconds 10 }
}
if (-not $ready) { throw "Server $Ip is not reachable over SSH. Check that port 22 is open for $SshCidr." }

Step 'Packaging committed source code'
Push-Location $Root
try {
  $dirty = git status --porcelain
  if ($dirty) { Write-Warning 'You have uncommitted changes. Only committed code is deployed.' }
  $Rev = (git rev-parse --short HEAD).Trim()
  $Tmp = Join-Path $env:TEMP "familyhub-deploy-$Rev"
  New-Item -ItemType Directory -Force $Tmp | Out-Null
  git archive --format=tar.gz -o (Join-Path $Tmp 'source.tar.gz') HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
} finally { Pop-Location }

$app = New-Object System.Collections.Generic.List[string]
foreach ($k in $Config.Keys) { if ($k.StartsWith('APP_')) { $app.Add("$($k.Substring(4))=$($Config[$k])") } }
$app.Add("DB_NAME=$(Cfg 'DB_NAME' 'familyhub')")
$app.Add("DB_USER=$(Cfg 'DB_USER' 'familyhub')")
foreach ($k in $Secrets.Keys) { if ($Secrets[$k] -ne '') { $app.Add("$k=$($Secrets[$k])") } }
Write-Lf (Join-Path $Tmp 'app.env') (($app -join "`n") + "`n")
Write-Lf (Join-Path $Tmp 'db-host') $DbHost
Write-Lf (Join-Path $Tmp 'site-host') $SiteHost
Write-Lf (Join-Path $Tmp 'remote-deploy.sh') ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'remote-deploy.sh')))
Copy-Item $PwFile (Join-Path $Tmp 'dbpw')

Step "Uploading revision $Rev to $Ip"
& ssh @Ssh $Target 'rm -rf /opt/familyhub/incoming && mkdir -p /opt/familyhub/incoming'
if ($LASTEXITCODE -ne 0) { throw 'ssh failed' }
& scp @Ssh -q (Join-Path $Tmp '*') "${Target}:/opt/familyhub/incoming/"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
Remove-Item -Recurse -Force $Tmp

Step 'Building and starting containers on the server (a few minutes)'
& ssh @Ssh $Target 'bash /opt/familyhub/incoming/remote-deploy.sh'
if ($LASTEXITCODE -ne 0) { throw 'Remote deploy failed (see output above)' }

Step 'Health check'
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
  try { $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 "https://$SiteHost/readyz"; if ($h.ok) { $ok = $true } } catch { Start-Sleep -Seconds 5 }
}
if (-not $ok) { throw "https://$SiteHost/readyz did not become healthy" }

Write-Host ''
Write-Host "FamilyHub Pro is live:  https://$SiteHost" -ForegroundColor Green
Write-Host "Revision:               $Rev"
Write-Host "SSH:                    ssh -i `"$KeyFile`" ubuntu@$Ip"
Write-Host "Android app URL:        https://$SiteHost  (rebuild the APK if this changed)"
