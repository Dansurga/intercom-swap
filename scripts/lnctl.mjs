#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeClnNetwork } from '../src/ln/cln.js';
import { normalizeLndNetwork } from '../src/ln/lnd.js';
import {
  lnConnect,
  lnDecodePay,
  lnFundChannel,
  lnGetInfo,
  lnInvoice,
  lnListFunds,
  lnNewAddress,
  lnPay,
  lnPayStatus,
  lnPreimageGet,
  lnWithdraw,
} from '../src/ln/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
lnctl (Lightning operator tool; CLN or LND)

Global flags:
  --impl <cln|lnd>                   (default: cln)
  --backend <cli|docker>             (default: cli)
  --network <bitcoin|mainnet|testnet|regtest|signet> (default: regtest)

Docker backend flags:
  --compose-file <path>             (default: dev/ln-regtest/docker-compose.yml)
  --service <name>                  (required for docker backend)

CLI backend flags:
  --cli-bin <path>                  (default: lightning-cli for cln, lncli for lnd)

LND (cli backend) extra flags:
  --lnd-rpcserver <host:port>
  --lnd-tlscert <path>
  --lnd-macaroon <path>
  --lnd-dir <path>

Commands:
  info
  newaddr
  listfunds
  balance
  withdraw --to <address> --amount-sats <n> [--sat-per-vbyte <n>]
  connect --peer <nodeid@host:port>
  fundchannel --node-id <hex> --amount-sats <n>
  invoice --msat <amountmsat> --label <label> --desc <text> [--expiry <sec>]
  decodepay --bolt11 <invoice>
  pay --bolt11 <invoice>
  pay-status --payment-hash <hex32>
  preimage-get --payment-hash <hex32>
`.trim();
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function normalizeHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) die(`${label} must be 32-byte hex`);
  return hex;
}

function sumMsatFromFunds(listfunds) {
  const outs = Array.isArray(listfunds?.outputs) ? listfunds.outputs : [];
  const chans = Array.isArray(listfunds?.channels) ? listfunds.channels : [];

  const toMsatBig = (v) => {
    if (v === null || v === undefined) return 0n;
    const s = typeof v === 'string' ? v : String(v);
    // CLN encodes amounts like "1234msat".
    const m = s.trim().match(/^([0-9]+)msat$/);
    if (m) return BigInt(m[1]);
    // Some fields may be sats already.
    if (/^[0-9]+$/.test(s.trim())) return BigInt(s.trim());
    return 0n;
  };

  let onchainConfirmed = 0n;
  let onchainUnconfirmed = 0n;
  for (const o of outs) {
    const msat = toMsatBig(o?.amount_msat ?? o?.amount ?? o?.value ?? 0);
    const st = String(o?.status || '').toLowerCase();
    if (st === 'confirmed') onchainConfirmed += msat;
    else onchainUnconfirmed += msat;
  }

  let channelTotal = 0n;
  for (const c of chans) {
    const msat = toMsatBig(c?.our_amount_msat ?? c?.our_amount ?? 0);
    channelTotal += msat;
  }

  return { onchainConfirmed, onchainUnconfirmed, channelTotal };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const impl = (flags.get('impl') && String(flags.get('impl')).trim().toLowerCase()) || 'cln';
  if (impl !== 'cln' && impl !== 'lnd') die('Invalid --impl (expected cln|lnd)');

  const backend = (flags.get('backend') && String(flags.get('backend')).trim()) || 'cli';
  if (backend !== 'cli' && backend !== 'docker') die('Invalid --backend (expected cli|docker)');
  const networkRaw = (flags.get('network') && String(flags.get('network')).trim()) || 'regtest';
  let network;
  try {
    network = impl === 'lnd' ? normalizeLndNetwork(networkRaw) : normalizeClnNetwork(networkRaw);
  } catch (err) {
    die(err?.message ?? String(err));
  }

  const composeFile = (flags.get('compose-file') && String(flags.get('compose-file')).trim()) || defaultComposeFile;
  const service = flags.get('service') ? String(flags.get('service')).trim() : '';
  const cliBin = flags.get('cli-bin') ? String(flags.get('cli-bin')).trim() : '';

  if (backend === 'docker' && !service) die('Missing --service (required for --backend docker)');

  if (cmd === 'info') {
    const info = await lnGetInfo({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    });
    process.stdout.write(`${JSON.stringify({ type: 'info', info }, null, 2)}\n`);
    return;
  }

  if (cmd === 'newaddr') {
    const r = await lnNewAddress({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    });
    process.stdout.write(`${JSON.stringify({ type: 'newaddr', address: r.address, raw: r.raw }, null, 2)}\n`);
    return;
  }

  if (cmd === 'listfunds') {
    const r = await lnListFunds({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    });
    process.stdout.write(`${JSON.stringify({ type: 'listfunds', result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'balance') {
    const funds = await lnListFunds({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    });

    if (impl === 'lnd') {
      const confirmedSat = BigInt(String(funds?.wallet?.confirmed_balance ?? 0));
      const unconfirmedSat = BigInt(String(funds?.wallet?.unconfirmed_balance ?? 0));
      const channelSat = BigInt(String(funds?.channel?.balance ?? 0));
      process.stdout.write(`${JSON.stringify({
        type: 'balance',
        onchain_confirmed_msat: (confirmedSat * 1000n).toString(),
        onchain_unconfirmed_msat: (unconfirmedSat * 1000n).toString(),
        channel_total_msat: (channelSat * 1000n).toString(),
        raw: funds,
      }, null, 2)}\n`);
      return;
    }

    const sums = sumMsatFromFunds(funds);
    process.stdout.write(`${JSON.stringify({
      type: 'balance',
      onchain_confirmed_msat: sums.onchainConfirmed.toString(),
      onchain_unconfirmed_msat: sums.onchainUnconfirmed.toString(),
      channel_total_msat: sums.channelTotal.toString(),
      raw: funds,
    }, null, 2)}\n`);
    return;
  }

  if (cmd === 'withdraw') {
    const to = requireFlag(flags, 'to');
    const amountSats = parseIntFlag(requireFlag(flags, 'amount-sats'), 'amount-sats');
    if (!Number.isInteger(amountSats) || amountSats <= 0) die('Invalid --amount-sats');
    const satPerVbyte = parseIntFlag(flags.get('sat-per-vbyte'), 'sat-per-vbyte', null);

    const r = await lnWithdraw({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { address: to, amountSats, satPerVbyte });
    process.stdout.write(`${JSON.stringify({ type: 'withdraw', to, amount_sats: amountSats, sat_per_vbyte: satPerVbyte, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'connect') {
    const peer = requireFlag(flags, 'peer');
    const r = await lnConnect({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { peer });
    process.stdout.write(`${JSON.stringify({ type: 'connect', peer, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'fundchannel') {
    const nodeId = requireFlag(flags, 'node-id');
    const amountSats = parseIntFlag(requireFlag(flags, 'amount-sats'), 'amount-sats');
    if (!Number.isFinite(amountSats) || amountSats <= 0) die('Invalid --amount-sats');
    const r = await lnFundChannel({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { nodeId, amountSats, block: true });
    process.stdout.write(`${JSON.stringify({ type: 'fundchannel', node_id: nodeId, amount_sats: amountSats, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'invoice') {
    const msat = requireFlag(flags, 'msat');
    const label = requireFlag(flags, 'label');
    const desc = requireFlag(flags, 'desc');
    const expiry = flags.get('expiry') ? parseIntFlag(flags.get('expiry'), 'expiry') : null;
    const r = await lnInvoice({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { amountMsat: msat, label, description: desc, expirySec: expiry });
    process.stdout.write(`${JSON.stringify({ type: 'invoice', bolt11: r.bolt11, payment_hash: r.payment_hash, raw: r.raw }, null, 2)}\n`);
    return;
  }

  if (cmd === 'decodepay') {
    const bolt11 = requireFlag(flags, 'bolt11');
    const r = await lnDecodePay({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { bolt11 });
    process.stdout.write(`${JSON.stringify({ type: 'decodepay', ...r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'pay') {
    const bolt11 = requireFlag(flags, 'bolt11');
    const r = await lnPay({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { bolt11 });
    process.stdout.write(`${JSON.stringify({ type: 'pay', payment_preimage: r.payment_preimage, raw: r.raw }, null, 2)}\n`);
    return;
  }

  if (cmd === 'pay-status') {
    const hash = normalizeHex32(requireFlag(flags, 'payment-hash'), 'payment-hash');
    const r = await lnPayStatus({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { paymentHashHex: hash });
    process.stdout.write(`${JSON.stringify({ type: 'pay_status', payment_hash_hex: hash, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'preimage-get') {
    const hash = normalizeHex32(requireFlag(flags, 'payment-hash'), 'payment-hash');
    const r = await lnPreimageGet({
      impl,
      backend,
      composeFile,
      service,
      network,
      cliBin,
      cwd: repoRoot,
      lnd: {
        rpcserver: flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '',
        tlscertpath: flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '',
        macaroonpath: flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '',
        lnddir: flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '',
      },
    }, { paymentHashHex: hash });
    process.stdout.write(`${JSON.stringify({ type: 'preimage', payment_hash_hex: hash, preimage_hex: r.preimage_hex, result: r }, null, 2)}\n`);
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
