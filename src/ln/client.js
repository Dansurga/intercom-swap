import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function parseJsonOrJsonLines(text) {
  const s = String(text || '').trim();
  if (!s) return { result: '' };

  try {
    return JSON.parse(s);
  } catch (_e) {
    // Some lncli commands emit multiple JSON objects (stream) in a single stdout.
    // Extract a sequence of top-level JSON objects/arrays by brace matching.
    const out = [];

    let i = 0;
    while (i < s.length) {
      // Skip whitespace until we find a JSON start.
      while (i < s.length && /\s/.test(s[i])) i += 1;
      if (i >= s.length) break;

      const start = s[i];
      const open = start === '{' ? '{' : start === '[' ? '[' : null;
      const close = start === '{' ? '}' : start === '[' ? ']' : null;
      if (!open) break;

      let depth = 0;
      let inString = false;
      let esc = false;
      let j = i;
      for (; j < s.length; j += 1) {
        const ch = s[j];
        if (inString) {
          if (esc) {
            esc = false;
            continue;
          }
          if (ch === '\\') {
            esc = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
            continue;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === open) depth += 1;
        if (ch === close) {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }

      if (depth !== 0) break;
      const chunk = s.slice(i, j).trim();
      try {
        out.push(JSON.parse(chunk));
      } catch (_e2) {}
      i = j;
    }

    if (out.length > 0) return out[out.length - 1];
    return { result: s };
  }
}

function decodeMaybeB64Hex(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    const hex = Buffer.from(s, 'base64').toString('hex');
    if (/^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase();
    return null;
  } catch (_e) {
    return null;
  }
}

function normalizeClnAmountMsat(amountMsat) {
  const s = String(amountMsat || '').trim();
  if (!s) throw new Error('Missing amount');
  if (/^[0-9]+(msat|sat)$/i.test(s)) return s;
  if (/^[0-9]+$/.test(s)) return `${s}msat`;
  throw new Error(`Invalid CLN amount: ${s} (expected <n> or <n>msat/<n>sat)`);
}

async function execCli({ cmd, args, cwd }) {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 1024 * 1024 * 50 });
    return parseJsonOrJsonLines(stdout);
  } catch (err) {
    const code = err?.code;
    const stderr = String(err?.stderr || '').trim();
    const stdout = String(err?.stdout || '').trim();
    const msg = stderr || stdout || err?.message || String(err);
    const e = new Error(msg);
    e.code = code;
    throw e;
  }
}

async function lnClnCli({
  backend,
  composeFile,
  service,
  network,
  cliBin,
  args,
  cwd,
}) {
  const useDocker = backend === 'docker';
  const cmd = useDocker ? 'docker' : (cliBin || 'lightning-cli');
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, 'lightning-cli', `--network=${network}`, ...args]
    : [`--network=${network}`, ...args];
  return execCli({ cmd, args: fullArgs, cwd });
}

async function lnLndCli({
  backend,
  composeFile,
  service,
  network,
  cliBin,
  lnd = null,
  args,
  cwd,
}) {
  const useDocker = backend === 'docker';
  const lncliBin = cliBin || 'lncli';
  const baseArgs = [`--network=${network}`];
  // For CLI backend, lnd connection details should be explicit.
  if (!useDocker) {
    if (lnd?.rpcserver) baseArgs.push(`--rpcserver=${String(lnd.rpcserver)}`);
    if (lnd?.tlscertpath) baseArgs.push(`--tlscertpath=${String(lnd.tlscertpath)}`);
    if (lnd?.macaroonpath) baseArgs.push(`--macaroonpath=${String(lnd.macaroonpath)}`);
    if (lnd?.lnddir) baseArgs.push(`--lnddir=${String(lnd.lnddir)}`);
  }

  const cmd = useDocker ? 'docker' : lncliBin;
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, lncliBin, ...baseArgs, ...args]
    : [...baseArgs, ...args];
  return execCli({ cmd, args: fullArgs, cwd });
}

export async function lnGetInfo(opts) {
  if (opts.impl === 'lnd') return lnLndCli({ ...opts, args: ['getinfo'] });
  return lnClnCli({ ...opts, args: ['getinfo'] });
}

export async function lnListFunds(opts) {
  if (opts.impl === 'lnd') {
    const wallet = await lnLndCli({ ...opts, args: ['walletbalance'] });
    const channel = await lnLndCli({ ...opts, args: ['channelbalance'] });
    const channels = await lnLndCli({ ...opts, args: ['listchannels'] });
    return { wallet, channel, channels };
  }
  return lnClnCli({ ...opts, args: ['listfunds'] });
}

export async function lnNewAddress(opts, { type = 'p2wkh' } = {}) {
  if (opts.impl === 'lnd') {
    const r = await lnLndCli({ ...opts, args: ['newaddress', type] });
    const address = String(r?.address || '').trim();
    if (!address) throw new Error('LND newaddress missing address');
    return { address, raw: r };
  }
  const r = await lnClnCli({ ...opts, args: ['newaddr'] });
  const address = String(r?.bech32 || '').trim();
  if (!address) throw new Error('CLN newaddr missing bech32');
  return { address, raw: r };
}

export async function lnConnect(opts, { peer }) {
  const p = String(peer || '').trim();
  if (!p) throw new Error('Missing peer');
  if (opts.impl === 'lnd') return lnLndCli({ ...opts, args: ['connect', p] });
  return lnClnCli({ ...opts, args: ['connect', p] });
}

export async function lnFundChannel(opts, { nodeId, amountSats, block = true }) {
  const id = String(nodeId || '').trim();
  const amt = Number(amountSats);
  if (!id) throw new Error('Missing nodeId');
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amountSats');

  if (opts.impl === 'lnd') {
    const args = ['openchannel', '--node_key', id, '--local_amt', String(amt)];
    if (block) args.push('--block');
    return lnLndCli({ ...opts, args });
  }

  return lnClnCli({ ...opts, args: ['fundchannel', id, String(amt)] });
}

export async function lnInvoice(opts, { amountMsat, label, description, expirySec = null }) {
  const desc = String(description || '').trim();
  if (!desc) throw new Error('Missing invoice description');

  if (opts.impl === 'lnd') {
    const memo = String(label || '').trim() ? `${String(label).trim()} ${desc}`.trim() : desc;
    const amt = BigInt(String(amountMsat));
    if (amt <= 0n) throw new Error('Invalid amountMsat');
    const args = ['addinvoice', '--amt_msat', String(amt), '--memo', memo];
    if (expirySec !== null && expirySec !== undefined) {
      const exp = Number(expirySec);
      if (Number.isFinite(exp) && exp > 0) args.push('--expiry', String(exp));
    }
    const r = await lnLndCli({ ...opts, args });

    const bolt11 = String(r?.payment_request || r?.paymentRequest || '').trim();
    if (!bolt11) throw new Error('LND addinvoice missing payment_request');

    const paymentHashHex =
      decodeMaybeB64Hex(r?.r_hash_str) ||
      decodeMaybeB64Hex(r?.r_hash) ||
      decodeMaybeB64Hex(r?.rHashStr) ||
      decodeMaybeB64Hex(r?.rHash);
    if (!paymentHashHex) throw new Error('LND addinvoice missing r_hash(_str)');

    return { bolt11, payment_hash: paymentHashHex, raw: r };
  }

  const amount = normalizeClnAmountMsat(amountMsat);
  const lab = String(label || '').trim();
  if (!lab) throw new Error('Missing invoice label');
  const args = ['invoice', amount, lab, desc];
  if (expirySec !== null && expirySec !== undefined) {
    const exp = Number(expirySec);
    if (Number.isFinite(exp) && exp > 0) args.push(String(exp));
  }
  const r = await lnClnCli({ ...opts, args });
  const bolt11 = String(r?.bolt11 || '').trim();
  const paymentHashHex = String(r?.payment_hash || '').trim().toLowerCase();
  if (!bolt11) throw new Error('CLN invoice missing bolt11');
  if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error('CLN invoice missing payment_hash');
  return { bolt11, payment_hash: paymentHashHex, raw: r };
}

export async function lnDecodePay(opts, { bolt11 }) {
  const inv = String(bolt11 || '').trim();
  if (!inv) throw new Error('Missing bolt11');
  if (opts.impl === 'lnd') return lnLndCli({ ...opts, args: ['decodepayreq', inv] });
  return lnClnCli({ ...opts, args: ['decodepay', inv] });
}

export async function lnPay(opts, { bolt11 }) {
  const inv = String(bolt11 || '').trim();
  if (!inv) throw new Error('Missing bolt11');

  if (opts.impl === 'lnd') {
    const r = await lnLndCli({ ...opts, args: ['payinvoice', '--force', '--json', inv] });
    const preimageHex =
      decodeMaybeB64Hex(r?.payment_preimage) ||
      decodeMaybeB64Hex(r?.paymentPreimage) ||
      decodeMaybeB64Hex(r?.payment_preimage_hex) ||
      decodeMaybeB64Hex(r?.paymentPreimageHex);
    if (!preimageHex) throw new Error('LND payinvoice missing payment_preimage');
    return { payment_preimage: preimageHex, raw: r };
  }

  const r = await lnClnCli({ ...opts, args: ['pay', inv] });
  const preimageHex = String(r?.payment_preimage || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error('CLN pay missing payment_preimage');
  return { payment_preimage: preimageHex, raw: r };
}

export async function lnPayStatus(opts, { paymentHashHex }) {
  const hash = String(paymentHashHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('paymentHashHex must be 32-byte hex');

  if (opts.impl === 'lnd') {
    // No direct "lookup outgoing payment by hash" command; scan a window.
    const r = await lnLndCli({ ...opts, args: ['listpayments', '--include_incomplete', '--max_payments', '200'] });
    const payments = Array.isArray(r?.payments) ? r.payments : [];
    const match = payments.find((p) => {
      const cand = decodeMaybeB64Hex(p?.payment_hash) || decodeMaybeB64Hex(p?.paymentHash);
      return cand === hash;
    }) || null;
    return { payment_hash_hex: hash, payment: match, raw: r };
  }

  // CLN versions differ; try listpays first, then listsendpays.
  let r;
  try {
    r = await lnClnCli({ ...opts, args: ['listpays', hash] });
  } catch (_e) {
    r = await lnClnCli({ ...opts, args: ['listsendpays', hash] });
  }
  return { payment_hash_hex: hash, raw: r };
}

export async function lnPreimageGet(opts, { paymentHashHex }) {
  const st = await lnPayStatus(opts, { paymentHashHex });

  if (opts.impl === 'lnd') {
    const p = st.payment;
    const preimageHex =
      decodeMaybeB64Hex(p?.payment_preimage) ||
      decodeMaybeB64Hex(p?.paymentPreimage) ||
      decodeMaybeB64Hex(p?.payment_preimage_hex) ||
      decodeMaybeB64Hex(p?.paymentPreimageHex);
    return { payment_hash_hex: st.payment_hash_hex, preimage_hex: preimageHex, raw: st.raw };
  }

  const pays = Array.isArray(st.raw?.pays) ? st.raw.pays : Array.isArray(st.raw?.payments) ? st.raw.payments : [];
  let preimageHex = null;
  for (const p of pays) {
    const cand = p?.preimage || p?.payment_preimage || p?.payment_preimage_hex || p?.preimage_hex;
    if (typeof cand === 'string' && /^[0-9a-f]{64}$/i.test(cand.trim())) {
      preimageHex = cand.trim().toLowerCase();
      break;
    }
  }
  return { payment_hash_hex: st.payment_hash_hex, preimage_hex: preimageHex, raw: st.raw };
}

export async function lnWithdraw(opts, { address, amountSats, satPerVbyte = null }) {
  const addr = String(address || '').trim();
  if (!addr) throw new Error('Missing address');
  const amt = Number(amountSats);
  if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt <= 0) throw new Error('Invalid amountSats');

  const feeRate = satPerVbyte === null || satPerVbyte === undefined ? null : Number(satPerVbyte);
  if (feeRate !== null && (!Number.isFinite(feeRate) || !Number.isInteger(feeRate) || feeRate < 1 || feeRate > 10_000)) {
    throw new Error('Invalid satPerVbyte (expected integer 1..10000)');
  }

  if (opts.impl === 'lnd') {
    const args = ['sendcoins', '--addr', addr, '--amount', String(amt)];
    if (feeRate !== null) args.push('--sat_per_vbyte', String(feeRate));
    return lnLndCli({ ...opts, args });
  }

  // CLN withdraw feerate can be provided as a string; we support sat/vbyte by converting
  // to sat/kw ("perkw") since CLN accepts <n>perkw.
  const args = ['withdraw', addr, String(amt)];
  if (feeRate !== null) {
    const perkw = Math.max(1, Math.trunc(feeRate * 250));
    args.push(`${perkw}perkw`);
  }
  return lnClnCli({ ...opts, args });
}
