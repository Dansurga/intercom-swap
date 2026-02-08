import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  return String(name || '').replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

function assertSafeId(label, value) {
  const s = String(value || '');
  if (!/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`${label} must match /^[A-Za-z0-9._-]+$/ (got: ${JSON.stringify(s)})`);
  }
  return s;
}

function resolvePathMaybeRelative(p, { baseDir }) {
  const s = String(p || '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.resolve(baseDir, s);
}

function stateDirForRepo(repoRoot) {
  return path.join(repoRoot, 'onchain', 'rfq-bots');
}

export function rfqbotStatePaths({ repoRoot, name }) {
  const stateDir = stateDirForRepo(repoRoot);
  const safe = safeName(name);
  return {
    stateDir,
    json: path.join(stateDir, `${safe}.json`),
    pid: path.join(stateDir, `${safe}.pid`),
    log: path.join(stateDir, `${safe}.log`),
  };
}

export function defaultRfqbotReceiptsDbPath({ repoRoot, store, name }) {
  const safeStore = safeName(assertSafeId('rfqbotStart: store', store));
  const safeBot = safeName(name);
  return path.join(repoRoot, 'onchain', 'receipts', 'rfq-bots', safeStore, `${safeBot}.sqlite`);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
  }
}

async function waitForExit(pid, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function buildBotArgs({ repoRoot, role, store, scPort, receiptsDb, argv }) {
  const tokenFile = path.join(repoRoot, 'onchain', 'sc-bridge', `${store}.token`);
  if (!fs.existsSync(tokenFile)) {
    throw new Error(
      `Missing SC-Bridge token file: ${tokenFile}\nHint: start the peer once (scripts/run-swap-*.sh) to generate it.`
    );
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error(`Empty SC-Bridge token: ${tokenFile}`);

  const peerKeypair = path.join(repoRoot, 'stores', store, 'db', 'keypair.json');
  if (!fs.existsSync(peerKeypair)) {
    throw new Error(
      `Missing peer keypair file: ${peerKeypair}\nHint: start the peer once (storeName=${store}) so it creates the keypair.`
    );
  }

  const url = `ws://127.0.0.1:${scPort}`;
  const script = role === 'maker' ? 'scripts/rfq-maker.mjs' : 'scripts/rfq-taker.mjs';

  const args = [script, '--url', url, '--token', token, '--peer-keypair', peerKeypair];
  if (receiptsDb) args.push('--receipts-db', receiptsDb);
  for (const a of argv || []) args.push(a);
  return args;
}

export function rfqbotStart({
  repoRoot = process.cwd(),
  name,
  role,
  store,
  scPort,
  receiptsDb = '',
  logPath = '',
  argv = [],
  nodeBin = process.execPath,
}) {
  if (!name) throw new Error('rfqbotStart: name is required');
  if (role !== 'maker' && role !== 'taker') throw new Error('rfqbotStart: role must be maker|taker');
  if (!store) throw new Error('rfqbotStart: store is required');
  assertSafeId('rfqbotStart: store', store);
  if (!Number.isInteger(scPort) || scPort <= 0 || scPort > 65535) throw new Error('rfqbotStart: scPort invalid');

  const paths = rfqbotStatePaths({ repoRoot, name });
  mkdirp(paths.stateDir);

  const log = resolvePathMaybeRelative(logPath, { baseDir: repoRoot }) || paths.log;
  const receipts = receiptsDb
    ? resolvePathMaybeRelative(receiptsDb, { baseDir: repoRoot })
    : defaultRfqbotReceiptsDbPath({ repoRoot, store, name });

  const args = buildBotArgs({ repoRoot, role, store, scPort, receiptsDb: receipts, argv });

  const outFd = fs.openSync(log, 'a');
  const child = spawn(nodeBin, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env },
  });
  try {
    fs.closeSync(outFd);
  } catch (_e) {}
  child.unref();

  fs.writeFileSync(paths.pid, `${child.pid}\n`);
  writeJson(paths.json, {
    v: 1,
    name,
    role,
    store,
    sc_port: Number(scPort),
    receipts_db: receipts,
    log,
    argv: Array.isArray(argv) ? argv : [],
    started_at: Date.now(),
  });

  return { type: 'bot_started', name, role, pid: child.pid, log, receipts_db: receipts };
}

export async function rfqbotStop({
  repoRoot = process.cwd(),
  name,
  signal = 'SIGTERM',
  waitMs = 2000,
}) {
  if (!name) throw new Error('rfqbotStop: name is required');
  const paths = rfqbotStatePaths({ repoRoot, name });
  mkdirp(paths.stateDir);

  const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
  const pid = pidText ? Number.parseInt(pidText, 10) : null;
  if (!pid || !Number.isFinite(pid)) {
    return { type: 'bot_stopped', name, ok: true, pid: null, reason: 'no_pidfile' };
  }

  if (!isAlive(pid)) {
    try {
      fs.unlinkSync(paths.pid);
    } catch (_e) {}
    return { type: 'bot_stopped', name, ok: true, pid, reason: 'not_running' };
  }

  try {
    process.kill(pid, signal);
  } catch (err) {
    throw new Error(`Failed to signal pid=${pid}: ${err?.message ?? String(err)}`);
  }

  const ok = await waitForExit(pid, waitMs);
  if (!ok && signal !== 'SIGKILL') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_e) {}
  }

  try {
    fs.unlinkSync(paths.pid);
  } catch (_e) {}
  return { type: 'bot_stopped', name, ok: true, pid, signal };
}

export async function rfqbotRestart({ repoRoot = process.cwd(), name, waitMs = 2000 }) {
  if (!name) throw new Error('rfqbotRestart: name is required');
  const paths = rfqbotStatePaths({ repoRoot, name });
  const cfg = readJson(paths.json);
  if (!cfg) {
    throw new Error(`Missing bot state: ${paths.json}\nHint: start the bot first.`);
  }
  await rfqbotStop({ repoRoot, name, waitMs });
  return rfqbotStart({
    repoRoot,
    name,
    role: cfg.role,
    store: cfg.store,
    scPort: Number(cfg.sc_port),
    receiptsDb: cfg.receipts_db,
    logPath: cfg.log,
    argv: Array.isArray(cfg.argv) ? cfg.argv : [],
  });
}

export function rfqbotStatus({ repoRoot = process.cwd(), name = '' } = {}) {
  const stateDir = stateDirForRepo(repoRoot);
  mkdirp(stateDir);
  const list = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (const f of list) {
    const cfg = readJson(path.join(stateDir, f));
    if (!cfg?.name) continue;
    if (name && cfg.name !== name) continue;
    const paths = rfqbotStatePaths({ repoRoot, name: cfg.name });
    const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
    const pid = pidText ? Number.parseInt(pidText, 10) : null;
    rows.push({
      name: cfg.name,
      role: cfg.role,
      store: cfg.store,
      sc_port: cfg.sc_port,
      pid: pid && Number.isFinite(pid) ? pid : null,
      alive: pid && Number.isFinite(pid) ? isAlive(pid) : false,
      log: cfg.log || null,
      receipts_db: cfg.receipts_db || null,
      argv: cfg.argv || [],
      started_at: cfg.started_at || null,
    });
  }
  return { type: 'bot_status', bots: rows };
}
