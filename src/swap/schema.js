import { ASSET, KIND, PAIR, STATE, SWAP_PROTOCOL_VERSION } from './constants.js';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const isHex = (value, bytes) => {
  if (typeof value !== 'string') return false;
  const hex = value.trim().toLowerCase();
  const re = bytes ? new RegExp(`^[0-9a-f]{${bytes * 2}}$`) : /^[0-9a-f]+$/;
  return re.test(hex);
};

const isBase58 = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  // Conservative: just ensure it's plausible base58 without 0/O/I/l.
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
};

const isUint = (value) =>
  Number.isInteger(value) && Number.isFinite(value) && value >= 0;

const isPosInt = (value) =>
  Number.isInteger(value) && Number.isFinite(value) && value > 0;

const isAmountString = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  // integer amount in smallest units, encoded as decimal string
  return /^[0-9]+$/.test(s) && s.length > 0;
};

export function validateSwapEnvelopeShape(envelope) {
  if (!isObject(envelope)) return { ok: false, error: 'Envelope must be an object' };
  if (!isUint(envelope.v)) return { ok: false, error: 'Envelope.v must be an integer >= 0' };
  if (envelope.v !== SWAP_PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported swap envelope version v=${envelope.v}` };
  }
  if (typeof envelope.kind !== 'string' || envelope.kind.length === 0) {
    return { ok: false, error: 'Envelope.kind is required' };
  }
  if (typeof envelope.trade_id !== 'string' || envelope.trade_id.length === 0) {
    return { ok: false, error: 'Envelope.trade_id is required' };
  }
  if (!isUint(envelope.ts)) return { ok: false, error: 'Envelope.ts must be an integer unix ms timestamp' };
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length === 0) {
    return { ok: false, error: 'Envelope.nonce is required' };
  }
  if (!('body' in envelope)) return { ok: false, error: 'Envelope.body is required' };
  return { ok: true, error: null };
}

export function validateSwapBody(kind, body) {
  if (!isObject(body)) return { ok: false, error: 'Body must be an object' };

  switch (kind) {
    case KIND.SVC_ANNOUNCE: {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return { ok: false, error: 'svc_announce.name is required' };
      }
      if (body.pairs !== undefined) {
        if (!Array.isArray(body.pairs) || body.pairs.some((p) => typeof p !== 'string')) {
          return { ok: false, error: 'svc_announce.pairs must be an array of strings' };
        }
      }
      if (body.rfq_channels !== undefined) {
        if (!Array.isArray(body.rfq_channels) || body.rfq_channels.some((c) => typeof c !== 'string')) {
          return { ok: false, error: 'svc_announce.rfq_channels must be an array of strings' };
        }
      }
      if (body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') return { ok: false, error: 'svc_announce.note must be a string' };
      }
      if (body.offers !== undefined && body.offers !== null) {
        if (!Array.isArray(body.offers)) return { ok: false, error: 'svc_announce.offers must be an array' };
        // Keep validation minimal; offers are informational and may evolve.
        for (const offer of body.offers) {
          if (!isObject(offer)) return { ok: false, error: 'svc_announce.offers entries must be objects' };
          if (offer.have !== undefined && offer.have !== null && typeof offer.have !== 'string') {
            return { ok: false, error: 'svc_announce.offers.have must be a string' };
          }
          if (offer.want !== undefined && offer.want !== null && typeof offer.want !== 'string') {
            return { ok: false, error: 'svc_announce.offers.want must be a string' };
          }
          if (offer.pair !== undefined && offer.pair !== null && typeof offer.pair !== 'string') {
            return { ok: false, error: 'svc_announce.offers.pair must be a string' };
          }
        }
      }
      if (body.valid_until_unix !== undefined && body.valid_until_unix !== null) {
        if (!isPosInt(body.valid_until_unix)) {
          return { ok: false, error: 'svc_announce.valid_until_unix must be a unix seconds integer' };
        }
      }
      return { ok: true, error: null };
    }

    case KIND.RFQ: {
      if (body.pair !== PAIR.BTC_LN__USDT_SOL) return { ok: false, error: 'rfq.pair unsupported' };
      if (body.direction !== `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`) {
        return { ok: false, error: 'rfq.direction unsupported' };
      }
      if (!isPosInt(body.btc_sats)) return { ok: false, error: 'rfq.btc_sats must be a positive integer' };
      if (!isAmountString(body.usdt_amount)) return { ok: false, error: 'rfq.usdt_amount must be a decimal string' };
      if (body.sol_mint !== undefined && body.sol_mint !== null) {
        if (!isBase58(body.sol_mint)) return { ok: false, error: 'rfq.sol_mint must be base58' };
      }
      if (body.sol_recipient !== undefined && body.sol_recipient !== null) {
        if (!isBase58(body.sol_recipient)) return { ok: false, error: 'rfq.sol_recipient must be base58' };
      }
      if (body.valid_until_unix !== undefined && !isPosInt(body.valid_until_unix)) {
        return { ok: false, error: 'rfq.valid_until_unix must be a unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.QUOTE: {
      if (!isHex(body.rfq_id, 32)) return { ok: false, error: 'quote.rfq_id must be 32-byte hex' };
      if (body.pair !== PAIR.BTC_LN__USDT_SOL) return { ok: false, error: 'quote.pair unsupported' };
      if (body.direction !== `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`) {
        return { ok: false, error: 'quote.direction unsupported' };
      }
      if (!isAmountString(body.usdt_amount)) return { ok: false, error: 'quote.usdt_amount must be a decimal string' };
      if (!isPosInt(body.btc_sats)) return { ok: false, error: 'quote.btc_sats must be a positive integer' };
      if (body.sol_mint !== undefined && body.sol_mint !== null) {
        if (!isBase58(body.sol_mint)) return { ok: false, error: 'quote.sol_mint must be base58' };
      }
      if (body.sol_recipient !== undefined && body.sol_recipient !== null) {
        if (!isBase58(body.sol_recipient)) return { ok: false, error: 'quote.sol_recipient must be base58' };
      }
      if (!isPosInt(body.valid_until_unix)) {
        return { ok: false, error: 'quote.valid_until_unix must be a unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.QUOTE_ACCEPT: {
      if (!isHex(body.rfq_id, 32)) return { ok: false, error: 'quote_accept.rfq_id must be 32-byte hex' };
      if (!isHex(body.quote_id, 32)) return { ok: false, error: 'quote_accept.quote_id must be 32-byte hex' };
      if (body.note !== undefined && typeof body.note !== 'string') {
        return { ok: false, error: 'quote_accept.note must be a string' };
      }
      return { ok: true, error: null };
    }

    case KIND.SWAP_INVITE: {
      if (!isHex(body.rfq_id, 32)) return { ok: false, error: 'swap_invite.rfq_id must be 32-byte hex' };
      if (!isHex(body.quote_id, 32)) return { ok: false, error: 'swap_invite.quote_id must be 32-byte hex' };
      if (typeof body.swap_channel !== 'string' || body.swap_channel.trim().length === 0) {
        return { ok: false, error: 'swap_invite.swap_channel is required' };
      }
      if (body.owner_pubkey !== undefined && body.owner_pubkey !== null) {
        if (!isHex(body.owner_pubkey, 32)) return { ok: false, error: 'swap_invite.owner_pubkey must be 32-byte hex' };
      }

      // Sidechannel invite payload can be included inline (preferred) or as base64 JSON.
      const hasInviteObject = isObject(body.invite);
      const hasInviteB64 = typeof body.invite_b64 === 'string' && body.invite_b64.trim().length > 0;
      if (!hasInviteObject && !hasInviteB64) {
        return { ok: false, error: 'swap_invite.invite (object) or invite_b64 (string) is required' };
      }
      if (hasInviteObject) {
        if (!isObject(body.invite.payload) || typeof body.invite.sig !== 'string' || body.invite.sig.trim().length === 0) {
          return { ok: false, error: 'swap_invite.invite must include { payload, sig }' };
        }
        if (String(body.invite.payload.channel || '') !== String(body.swap_channel)) {
          return { ok: false, error: 'swap_invite.invite.payload.channel must match swap_channel' };
        }
      }
      if (body.welcome !== undefined && body.welcome !== null) {
        if (!isObject(body.welcome)) return { ok: false, error: 'swap_invite.welcome must be an object' };
      }
      if (body.welcome_b64 !== undefined && body.welcome_b64 !== null) {
        if (typeof body.welcome_b64 !== 'string' || body.welcome_b64.trim().length === 0) {
          return { ok: false, error: 'swap_invite.welcome_b64 must be a string' };
        }
      }
      return { ok: true, error: null };
    }

    case KIND.TERMS: {
      if (body.pair !== PAIR.BTC_LN__USDT_SOL) return { ok: false, error: 'terms.pair unsupported' };
      if (body.direction !== `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`) {
        return { ok: false, error: 'terms.direction unsupported' };
      }
      if (!isPosInt(body.btc_sats)) return { ok: false, error: 'terms.btc_sats must be a positive integer' };
      if (!isAmountString(body.usdt_amount)) return { ok: false, error: 'terms.usdt_amount must be a decimal string' };
      if (body.usdt_decimals !== undefined && !isUint(body.usdt_decimals)) {
        return { ok: false, error: 'terms.usdt_decimals must be an integer >= 0' };
      }
      if (!isBase58(body.sol_mint)) return { ok: false, error: 'terms.sol_mint must be base58' };
      if (!isBase58(body.sol_recipient)) return { ok: false, error: 'terms.sol_recipient must be base58' };
      if (!isBase58(body.sol_refund)) return { ok: false, error: 'terms.sol_refund must be base58' };
      if (!isPosInt(body.sol_refund_after_unix)) {
        return { ok: false, error: 'terms.sol_refund_after_unix must be a unix seconds integer' };
      }
      if (!isHex(body.ln_receiver_peer, 32)) {
        return { ok: false, error: 'terms.ln_receiver_peer must be 32-byte hex' };
      }
      if (!isHex(body.ln_payer_peer, 32)) {
        return { ok: false, error: 'terms.ln_payer_peer must be 32-byte hex' };
      }

      // Fee policy is part of the binding terms. Values are bps integers.
      if (!isUint(body.platform_fee_bps)) {
        return { ok: false, error: 'terms.platform_fee_bps must be an integer >= 0' };
      }
      if (!isUint(body.trade_fee_bps)) {
        return { ok: false, error: 'terms.trade_fee_bps must be an integer >= 0' };
      }
      if (Number(body.platform_fee_bps) > 500) {
        return { ok: false, error: 'terms.platform_fee_bps exceeds 500 bps cap' };
      }
      if (Number(body.trade_fee_bps) > 1000) {
        return { ok: false, error: 'terms.trade_fee_bps exceeds 1000 bps cap' };
      }
      if (Number(body.platform_fee_bps) + Number(body.trade_fee_bps) > 1500) {
        return { ok: false, error: 'terms total fee bps exceeds 1500 bps cap' };
      }
      if (body.platform_fee_collector !== undefined && body.platform_fee_collector !== null) {
        if (!isBase58(body.platform_fee_collector)) {
          return { ok: false, error: 'terms.platform_fee_collector must be base58' };
        }
      }
      if (!isBase58(body.trade_fee_collector)) {
        return { ok: false, error: 'terms.trade_fee_collector must be base58' };
      }

      if (body.terms_valid_until_unix !== undefined && !isPosInt(body.terms_valid_until_unix)) {
        return { ok: false, error: 'terms.terms_valid_until_unix must be unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.ACCEPT: {
      if (typeof body.terms_hash !== 'string' || !isHex(body.terms_hash)) {
        return { ok: false, error: 'accept.terms_hash must be hex' };
      }
      return { ok: true, error: null };
    }

    case KIND.LN_INVOICE: {
      if (typeof body.bolt11 !== 'string' || body.bolt11.trim().length === 0) {
        return { ok: false, error: 'ln_invoice.bolt11 is required' };
      }
      if (!isHex(body.payment_hash_hex, 32)) {
        return { ok: false, error: 'ln_invoice.payment_hash_hex must be 32-byte hex' };
      }
      if (body.amount_msat !== undefined && !isAmountString(body.amount_msat)) {
        return { ok: false, error: 'ln_invoice.amount_msat must be a decimal string' };
      }
      if (body.expires_at_unix !== undefined && !isPosInt(body.expires_at_unix)) {
        return { ok: false, error: 'ln_invoice.expires_at_unix must be unix seconds integer' };
      }
      return { ok: true, error: null };
    }

    case KIND.SOL_ESCROW_CREATED: {
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: 'sol_escrow_created.payment_hash_hex invalid' };
      if (!isBase58(body.program_id)) return { ok: false, error: 'sol_escrow_created.program_id invalid' };
      if (!isBase58(body.escrow_pda)) return { ok: false, error: 'sol_escrow_created.escrow_pda invalid' };
      if (!isBase58(body.vault_ata)) return { ok: false, error: 'sol_escrow_created.vault_ata invalid' };
      if (!isBase58(body.mint)) return { ok: false, error: 'sol_escrow_created.mint invalid' };
      if (!isAmountString(body.amount)) return { ok: false, error: 'sol_escrow_created.amount must be a decimal string' };
      if (!isPosInt(body.refund_after_unix)) return { ok: false, error: 'sol_escrow_created.refund_after_unix invalid' };
      if (!isBase58(body.recipient)) return { ok: false, error: 'sol_escrow_created.recipient invalid' };
      if (!isBase58(body.refund)) return { ok: false, error: 'sol_escrow_created.refund invalid' };
      if (typeof body.tx_sig !== 'string' || body.tx_sig.trim().length === 0) {
        return { ok: false, error: 'sol_escrow_created.tx_sig is required' };
      }
      return { ok: true, error: null };
    }

    case KIND.LN_PAID: {
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: 'ln_paid.payment_hash_hex invalid' };
      if (body.preimage_hex !== undefined && !isHex(body.preimage_hex, 32)) {
        return { ok: false, error: 'ln_paid.preimage_hex must be 32-byte hex' };
      }
      return { ok: true, error: null };
    }

    case KIND.SOL_CLAIMED:
    case KIND.SOL_REFUNDED: {
      const label = kind === KIND.SOL_CLAIMED ? 'sol_claimed' : 'sol_refunded';
      if (!isHex(body.payment_hash_hex, 32)) return { ok: false, error: `${label}.payment_hash_hex invalid` };
      if (!isBase58(body.escrow_pda)) return { ok: false, error: `${label}.escrow_pda invalid` };
      if (typeof body.tx_sig !== 'string' || body.tx_sig.trim().length === 0) {
        return { ok: false, error: `${label}.tx_sig is required` };
      }
      return { ok: true, error: null };
    }

    case KIND.CANCEL: {
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        return { ok: false, error: 'cancel.reason must be a string' };
      }
      return { ok: true, error: null };
    }

    case KIND.STATUS: {
      if (typeof body.state !== 'string' || !Object.values(STATE).includes(body.state)) {
        return { ok: false, error: 'status.state must be a valid state' };
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        return { ok: false, error: 'status.note must be a string' };
      }
      return { ok: true, error: null };
    }

    default:
      return { ok: false, error: `Unknown swap kind: ${kind}` };
  }
}

export function validateSwapEnvelope(envelope) {
  const base = validateSwapEnvelopeShape(envelope);
  if (!base.ok) return base;
  return validateSwapBody(envelope.kind, envelope.body);
}
