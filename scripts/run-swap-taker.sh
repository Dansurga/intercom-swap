#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

. scripts/_env.sh

# Dev-oriented swap taker/client peer.
# - joins the public OTC channel (to see RFQs/quotes)
# - requires invites for swap:* channels, and must trust the maker's inviter pubkey(s)
#
# Notes:
# - Welcome enforcement is disabled here to keep OTC join friction low. For stricter authenticity,
#   remove `--sidechannel-welcome-required 0` and distribute owner+welcome for the OTC channel.
#
# Usage:
#   SWAP_INVITER_KEYS="<makerPeerPubkeyHex[,more]>" scripts/run-swap-taker.sh [storeName] [scBridgePort] [otcChannel]

STORE_NAME="${1:-swap-taker}"
SC_PORT="${2:-49223}"
OTC_CHANNEL="${3:-btc-usdt-sol-otc}"

INVITER_KEYS="${SWAP_INVITER_KEYS:-}"
if [[ -z "$INVITER_KEYS" ]]; then
  echo "ERROR: SWAP_INVITER_KEYS is required (comma-separated inviter peer pubkeys, hex)." >&2
  echo "Hint: start maker first, then read its pubkey from the startup banner or via swapctl info." >&2
  exit 1
fi

TOKEN_DIR="onchain/sc-bridge"
TOKEN_FILE="${TOKEN_DIR}/${STORE_NAME}.token"
mkdir -p "$TOKEN_DIR"
if [[ ! -f "$TOKEN_FILE" ]]; then
  token="$(
    openssl rand -hex 32 2>/dev/null || \
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  )"
  printf '%s\n' "$token" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
fi
SC_TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"

exec pear run . \
  --peer-store-name "$STORE_NAME" \
  --msb 0 \
  --sc-bridge 1 \
  --sc-bridge-token "$SC_TOKEN" \
  --sc-bridge-port "$SC_PORT" \
  --sidechannels "$OTC_CHANNEL" \
  --sidechannel-pow 0 \
  --sidechannel-welcome-required 0 \
  --sidechannel-invite-required 1 \
  --sidechannel-invite-prefixes "swap:" \
  --sidechannel-inviter-keys "$INVITER_KEYS"

