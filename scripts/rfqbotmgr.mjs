#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rfqbotRestart, rfqbotStart, rfqbotStatus, rfqbotStop } from '../src/rfq/botManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
rfqbotmgr (manage local RFQ bot processes)

Commands:
  start-maker --name <id> --store <peerStoreName> --sc-port <n> [--log <path>] [--receipts-db <path>] [--] [rfq-maker args...]
  start-taker --name <id> --store <peerStoreName> --sc-port <n> [--log <path>] [--receipts-db <path>] [--] [rfq-taker args...]
  stop --name <id> [--signal <SIGTERM|SIGINT|SIGKILL>] [--wait-ms <n>]
  restart --name <id> [--wait-ms <n>]
  status [--name <id>]

Notes:
  - This never stops the peer (pear run). It only controls bot processes started via rfqbotmgr.
  - State is stored under onchain/rfq-bots/ (gitignored).
`.trim();
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  let passthru = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      passthru = argv.slice(i + 1);
      break;
    }
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
  return { args, flags, passthru };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function maybeFlag(flags, name, fallback = '') {
  const v = flags.get(name);
  if (!v || v === true) return fallback;
  return String(v);
}

function maybeInt(flags, name, fallback = null) {
  const v = flags.get(name);
  if (v === undefined || v === null || v === true) return fallback;
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) die(`Invalid --${name}`);
  return n;
}

async function main() {
  const { args, flags, passthru } = parseArgs(process.argv.slice(2));
  const cmd = args[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (cmd === 'start-maker' || cmd === 'start-taker') {
    const name = requireFlag(flags, 'name');
    const store = requireFlag(flags, 'store');
    const scPort = maybeInt(flags, 'sc-port', null);
    if (!scPort) die('Missing --sc-port');
    const role = cmd === 'start-maker' ? 'maker' : 'taker';
    const log = maybeFlag(flags, 'log', '');
    const receiptsDb = maybeFlag(flags, 'receipts-db', '');
    const out = rfqbotStart({ repoRoot, name, role, store, scPort, logPath: log, receiptsDb, argv: passthru });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'stop') {
    const name = requireFlag(flags, 'name');
    const signal = maybeFlag(flags, 'signal', 'SIGTERM');
    const waitMs = maybeInt(flags, 'wait-ms', 2000);
    const out = await rfqbotStop({ repoRoot, name, signal, waitMs });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'restart') {
    const name = requireFlag(flags, 'name');
    const waitMs = maybeInt(flags, 'wait-ms', 2000);
    const out = await rfqbotRestart({ repoRoot, name, waitMs });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  if (cmd === 'status') {
    const name = maybeFlag(flags, 'name', '');
    const out = rfqbotStatus({ repoRoot, name });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  die(`Unknown command: ${cmd}\n\n${usage()}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));

