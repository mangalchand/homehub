<#
  FamilyHub Pro: low-cost deployment to one AWS Lightsail server (~$7/month) with Postgres in Docker.

  Usage (from the repo folder, in cmd or PowerShell):
    powershell -ExecutionPolicy Bypass -File deploy\deploy-lightsail.ps1 [-NoWorker]

  Reads deploy\familyhub.config (+ deploy\secrets.env), then:
    1. creates or reuses the Lightsail server, its static IP, firewall and daily snapshots
    2. uploads the committed source code and builds/starts the containers there
    3. waits until https://<site>/readyz is healthy
  -NoWorker starts everything except background jobs (use while testing a copy before cutover).
  Email: Lightsail has no instance role, so SES needs AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
  (a send-email-only IAM user) in deploy\secrets.env.
#>
param([switch]$NoWorker)
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
function Invoke-Aws {
  $ErrorActionPreference = 'Continue'
  $out = & aws.exe @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed:`n$($out | Out-String)" }
  return ($out | Out-String).Trim()
}
function AwsTry {
  $ErrorActionPreference = 'Continue'
  $out = & aws.exe @args 2>$null
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
$Name = Cfg 'LIGHTSAIL_INSTANCE' "$P-ls"
$IpName = "$P-ip"

Step 'Checking tools and AWS login'
foreach ($tool in 'aws.exe', 'git', 'ssh', 'scp', 'ssh-keygen') { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed or not on PATH" } }
Write-Host "AWS identity: $(Invoke-Aws sts get-caller-identity --query Arn --output text)"
if (-not (Test-Path $KeyFile)) { throw "SSH key $KeyFile is missing (run deploy.ps1 once, or restore it)." }
if (-not (Test-Path $PwFile)) {
  $b = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [IO.File]::WriteAllText($PwFile, ([Convert]::ToBase64String($b) -replace '[+/=]', 'x'))
}
if ((Cfg 'APP_EMAIL_DRIVER') -eq 'ses' -and -not $Secrets.Contains('AWS_ACCESS_KEY_ID')) {
  Write-Warning 'EMAIL_DRIVER=ses but secrets.env has no AWS_ACCESS_KEY_ID: emails will fail on Lightsail.'
}

Step "Lightsail server $Name"
if (-not (AwsTry lightsail get-key-pair --key-pair-name $KeyName --query keyPair.name --output text)) {
  $pub = Join-Path $State "$KeyName.pub"
  & ssh-keygen -y -f $KeyFile | Out-File -Encoding ascii $pub
  Invoke-Aws lightsail import-key-pair --key-pair-name $KeyName --public-key-base64 ("file://" + $pub) | Out-Null
}
if (-not (AwsTry lightsail get-instance --instance-name $Name --query instance.name --output text)) {
  $ud = Join-Path $env:TEMP 'familyhub-lightsail-init.sh'
  Write-Lf $ud ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'lightsail-init.sh')))
  Invoke-Aws lightsail create-instances --instance-names $Name --availability-zone (Cfg 'AWS_AZ' "$($env:AWS_DEFAULT_REGION)a") `
    --blueprint-id ubuntu_24_04 --bundle-id (Cfg 'LIGHTSAIL_BUNDLE' 'micro_3_0') --key-pair-name $KeyName `
    --user-data ("file://" + $ud) --tags "key=Project,value=$P" | Out-Null
  Write-Host 'Created; waiting for it to start'
}
for ($i = 0; $i -lt 60; $i++) { if ((AwsTry lightsail get-instance-state --instance-name $Name --query state.name --output text) -eq 'running') { break }; Start-Sleep 5 }

if (-not (AwsTry lightsail get-static-ip --static-ip-name $IpName --query staticIp.name --output text)) {
  Invoke-Aws lightsail allocate-static-ip --static-ip-name $IpName | Out-Null
}
if ((AwsTry lightsail get-static-ip --static-ip-name $IpName --query staticIp.attachedTo --output text) -ne $Name) {
  Invoke-Aws lightsail attach-static-ip --static-ip-name $IpName --instance-name $Name | Out-Null
}
$Ip = Invoke-Aws lightsail get-static-ip --static-ip-name $IpName --query staticIp.ipAddress --output text

$SshCidr = Cfg 'SSH_ALLOWED_CIDR' 'auto'
if ($SshCidr -eq 'auto') { $SshCidr = ((Invoke-RestMethod -UseBasicParsing https://checkip.amazonaws.com) | Out-String).Trim() + '/32' }
Invoke-Aws lightsail put-instance-public-ports --instance-name $Name --port-infos `
  'fromPort=80,toPort=80,protocol=TCP' 'fromPort=443,toPort=443,protocol=TCP' "fromPort=22,toPort=22,protocol=TCP,cidrs=$SshCidr" | Out-Null
$snap = AwsTry lightsail get-instance --instance-name $Name --query "instance.addOns[?name=='AutoSnapshot'].status" --output text
if ($snap -ne 'Enabled') {
  Invoke-Aws lightsail enable-add-on --resource-name $Name --add-on-request 'addOnType=AutoSnapshot,autoSnapshotAddOnRequest={snapshotTimeOfDay=08:00}' | Out-Null
}
Write-Host "Server $Name at $Ip (SSH from $SshCidr, daily snapshots on)"

$Domain = Cfg 'DOMAIN'
$SiteHost = if ($Domain) { $Domain } else { ($Ip -replace '\.', '-') + '.sslip.io' }

$Ssh = @('-i', $KeyFile, '-o', "UserKnownHostsFile=$KnownHosts", '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes')
$Target = "ubuntu@$Ip"
Step 'Waiting for the server to finish setup'
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
  $ErrorActionPreference = 'Continue'
  $r = & ssh @Ssh $Target 'cloud-init status --wait >/dev/null 2>&1; docker compose version >/dev/null && echo READY' 2>$null
  $ErrorActionPreference = 'Stop'
  if ("$r" -match 'READY') { $ready = $true } else { Start-Sleep -Seconds 10 }
}
if (-not $ready) { throw "Server $Ip is not reachable over SSH. Check that port 22 is open for $SshCidr." }

Step 'Packaging committed source code'
Push-Location $Root
try {
  if (git status --porcelain) { Write-Warning 'You have uncommitted changes. Only committed code is deployed.' }
  $Rev = (git rev-parse --short HEAD).Trim()
  $Tmp = Join-Path $env:TEMP "familyhub-ls-deploy-$Rev"
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
Write-Lf (Join-Path $Tmp 'db-host') 'local'
Write-Lf (Join-Path $Tmp 'site-host') $SiteHost
Write-Lf (Join-Path $Tmp 'remote-deploy.sh') ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'remote-deploy.sh')))
Copy-Item $PwFile (Join-Path $Tmp 'dbpw')
$Ek = Join-Path $State 'encryption-key.txt'
if (Test-Path $Ek) { Copy-Item $Ek (Join-Path $Tmp 'encryption-key') }
if ($NoWorker) { Write-Lf (Join-Path $Tmp 'no-worker') '1' }
$Sa = Join-Path $State 'firebase-service-account.json'
if (Test-Path $Sa) { Copy-Item $Sa (Join-Path $Tmp 'firebase-service-account.json') }

Step "Uploading revision $Rev to $Ip"
& ssh @Ssh $Target 'rm -rf /opt/familyhub/incoming && mkdir -p /opt/familyhub/incoming'
if ($LASTEXITCODE -ne 0) { throw 'ssh failed' }
& scp @Ssh -q (Join-Path $Tmp '*') "${Target}:/opt/familyhub/incoming/"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
Remove-Item -Recurse -Force $Tmp

Step 'Building and starting containers on the server (5-10 minutes on the small plan)'
& ssh @Ssh $Target 'bash /opt/familyhub/incoming/remote-deploy.sh'
if ($LASTEXITCODE -ne 0) { throw 'Remote deploy failed (see output above)' }

Step 'Health check'
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  try { $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 "https://$SiteHost/readyz"; if ($h.ok) { $ok = $true } } catch { Start-Sleep -Seconds 5 }
}
if (-not $ok) { throw "https://$SiteHost/readyz did not become healthy" }

Write-Host ''
Write-Host "FamilyHub Pro is live:  https://$SiteHost" -ForegroundColor Green
Write-Host "Revision:               $Rev$(if ($NoWorker) { ' (background jobs OFF)' })"
Write-Host "SSH:                    ssh -i `"$KeyFile`" ubuntu@$Ip"
