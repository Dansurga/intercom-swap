Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

# Dev-oriented swap maker/service peer.
# Usage:
#   .\\scripts\\run-swap-maker.ps1 [storeName] [scBridgePort] [otcChannel]

$storeName = if ($args.Length -ge 1 -and $args[0]) { [string]$args[0] } else { "swap-maker" }
$scPort = if ($args.Length -ge 2 -and $args[1]) { [string]$args[1] } else { "49222" }
$otcChannel = if ($args.Length -ge 3 -and $args[2]) { [string]$args[2] } else { "btc-usdt-sol-otc" }

$tokenDir = Join-Path $root "onchain/sc-bridge"
$tokenFile = Join-Path $tokenDir ("{0}.token" -f $storeName)
New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null
if (-not (Test-Path -Path $tokenFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  Set-Content -NoNewline -Path $tokenFile -Value $token
}
$scToken = (Get-Content -Raw -Path $tokenFile).Trim()

pear run . `
  --peer-store-name $storeName `
  --msb 0 `
  --sc-bridge 1 `
  --sc-bridge-token $scToken `
  --sc-bridge-port $scPort `
  --sidechannels $otcChannel `
  --sidechannel-pow 0 `
  --sidechannel-welcome-required 0 `
  --sidechannel-invite-required 1 `
  --sidechannel-invite-prefixes "swap:"

