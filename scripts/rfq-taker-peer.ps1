Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

if ($args.Length -lt 2) {
  throw "Usage: scripts\\rfq-taker-peer.ps1 <storeName> <scBridgePort> [rfq-taker args...]`nExample: scripts\\rfq-taker-peer.ps1 swap-taker 49223 --btc-sats 50000 --usdt-amount 100000000"
}

$storeName = [string]$args[0]
$scPort = [string]$args[1]
$rest = @()
if ($args.Length -gt 2) {
  $rest = $args[2..($args.Length - 1)]
}

$tokenFile = Join-Path $root ("onchain/sc-bridge/{0}.token" -f $storeName)
if (-not (Test-Path -Path $tokenFile)) {
  throw "Missing SC-Bridge token file: $tokenFile`nHint: start the peer once so it generates a token (see scripts\\run-swap-*.ps1)."
}

$scToken = (Get-Content -Raw -Path $tokenFile).Trim()

$keypairFile = Join-Path $root ("stores/{0}/db/keypair.json" -f $storeName)
if (-not (Test-Path -Path $keypairFile)) {
  throw "Missing peer keypair file: $keypairFile`nHint: this should be created by the peer on first start (storeName=$storeName)."
}

node scripts/rfq-taker.mjs --url ("ws://127.0.0.1:{0}" -f $scPort) --token $scToken --peer-keypair $keypairFile --receipts-db ("onchain/receipts/rfq-bots/{0}/taker.sqlite" -f $storeName) @rest
