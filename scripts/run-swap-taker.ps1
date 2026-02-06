Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

# Dev-oriented swap taker/client peer.
# Requires env var SWAP_INVITER_KEYS (comma-separated inviter peer pubkeys, hex).
#
# Usage:
#   $env:SWAP_INVITER_KEYS = "<makerPeerPubkeyHex[,more]>"
#   .\\scripts\\run-swap-taker.ps1 [storeName] [scBridgePort] [otcChannel]

$inviterKeys = if ($env:SWAP_INVITER_KEYS) { [string]$env:SWAP_INVITER_KEYS } else { "" }
if (-not $inviterKeys) {
  throw "SWAP_INVITER_KEYS is required (comma-separated inviter peer pubkeys, hex)."
}

$storeName = if ($args.Length -ge 1 -and $args[0]) { [string]$args[0] } else { "swap-taker" }
$scPort = if ($args.Length -ge 2 -and $args[1]) { [string]$args[1] } else { "49223" }
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
  --sidechannel-invite-prefixes "swap:" `
  --sidechannel-inviter-keys $inviterKeys

