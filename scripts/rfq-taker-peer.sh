#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -lt 2 ]]; then
  echo "Usage: scripts/rfq-taker-peer.sh <storeName> <scBridgePort> [rfq-taker args...]" >&2
  echo "Example: scripts/rfq-taker-peer.sh swap-taker 49223 --btc-sats 50000 --usdt-amount 100000000" >&2
  exit 1
fi

STORE_NAME="$1"
SC_PORT="$2"
shift 2

TOKEN_FILE="onchain/sc-bridge/${STORE_NAME}.token"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing SC-Bridge token file: $TOKEN_FILE" >&2
  echo "Hint: start the peer once so it generates a token (see scripts/run-swap-*.sh)." >&2
  exit 1
fi

SC_TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"

KEYPAIR_FILE="stores/${STORE_NAME}/db/keypair.json"
if [[ ! -f "$KEYPAIR_FILE" ]]; then
  echo "Missing peer keypair file: $KEYPAIR_FILE" >&2
  echo "Hint: this should be created by the peer on first start (storeName=${STORE_NAME})." >&2
  exit 1
fi

exec node scripts/rfq-taker.mjs \
  --url "ws://127.0.0.1:${SC_PORT}" \
  --token "$SC_TOKEN" \
  --peer-keypair "$KEYPAIR_FILE" \
  --receipts-db "onchain/receipts/rfq-bots/${STORE_NAME}/taker.sqlite" \
  "$@"
