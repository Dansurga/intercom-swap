import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { stableStringify } from '../util/stableStringify.js';

const normalizeChannel = (value) => String(value || '').trim();

const normalizeKeyHex = (value) => {
  if (!value) return '';
  if (b4a.isBuffer(value)) return b4a.toString(value, 'hex');
  return String(value).trim().toLowerCase();
};

export function normalizeInvitePayload(payload) {
  return {
    channel: normalizeChannel(payload?.channel),
    inviteePubKey: normalizeKeyHex(payload?.inviteePubKey),
    inviterPubKey: normalizeKeyHex(payload?.inviterPubKey),
    inviterAddress: payload?.inviterAddress ?? null,
    issuedAt: Number(payload?.issuedAt),
    expiresAt: Number(payload?.expiresAt),
    nonce: String(payload?.nonce ?? ''),
    version: Number.isFinite(payload?.version) ? Number(payload.version) : 1,
  };
}

export function normalizeWelcomePayload(payload) {
  return {
    channel: normalizeChannel(payload?.channel),
    ownerPubKey: normalizeKeyHex(payload?.ownerPubKey),
    text: String(payload?.text ?? ''),
    issuedAt: Number(payload?.issuedAt),
    version: Number.isFinite(payload?.version) ? Number(payload.version) : 1,
  };
}

export function encodePayloadForSigning(normalizedPayload) {
  // Deterministic encoding; must match sidechannel verification.
  return stableStringify(normalizedPayload);
}

export function signPayloadHex(normalizedPayload, secretKeyHexOrBuf) {
  const message = encodePayloadForSigning(normalizedPayload);
  const msgBuf = b4a.from(message);
  const secretBuf = b4a.isBuffer(secretKeyHexOrBuf)
    ? secretKeyHexOrBuf
    : b4a.from(String(secretKeyHexOrBuf || '').trim(), 'hex');
  const sigBuf = PeerWallet.sign(msgBuf, secretBuf);
  return b4a.toString(sigBuf, 'hex');
}

export function toB64Json(obj) {
  return b4a.toString(b4a.from(JSON.stringify(obj)), 'base64');
}

export function createSignedWelcome({ channel, ownerPubKey, text, issuedAt = Date.now(), version = 1 }, signHex) {
  const payload = normalizeWelcomePayload({ channel, ownerPubKey, text, issuedAt, version });
  const sig = signHex(payload);
  return { payload, sig };
}

export function createSignedInvite(
  {
    channel,
    inviteePubKey,
    inviterPubKey,
    inviterAddress = null,
    issuedAt = Date.now(),
    expiresAt,
    ttlMs,
    nonce = null,
    version = 1,
  },
  signHex,
  { welcome = null } = {}
) {
  const ttl = Number.isFinite(ttlMs) ? Math.max(Number(ttlMs), 0) : null;
  const exp = Number.isFinite(expiresAt)
    ? Number(expiresAt)
    : ttl !== null
      ? issuedAt + ttl
      : NaN;

  const payload = normalizeInvitePayload({
    channel,
    inviteePubKey,
    inviterPubKey,
    inviterAddress,
    issuedAt,
    expiresAt: exp,
    nonce: nonce || Math.random().toString(36).slice(2, 10),
    version,
  });
  const sig = signHex(payload);
  return { payload, sig, welcome: welcome || undefined };
}

