import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import DHT from 'hyperdht';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { KIND } from '../src/swap/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

async function retry(fn, { tries = 80, delayMs = 250, label = 'retry' } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr?.message ?? String(lastErr)}`);
}

async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}

async function writePeerKeypair({ storesDir, storeName }) {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();
  const keyPairPath = path.join(storesDir, storeName, 'db', 'keypair.json');
  await mkdirp(path.dirname(keyPairPath));
  wallet.exportToFile(keyPairPath, b4a.alloc(0));
  return {
    keyPairPath,
    pubHex: b4a.toString(wallet.publicKey, 'hex'),
  };
}

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function pickFreePorts(n) {
  const out = new Set();
  while (out.size < n) out.add(await pickFreePort());
  return Array.from(out);
}

function spawnPeer(args, { label }) {
  const proc = spawn('pear', ['run', '.', ...args], {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const append = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  proc.stdout.on('data', (d) => append(String(d)));
  proc.stderr.on('data', (d) => append(String(d)));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`[e2e:${label}] peer exited code=${code}. tail:\n${out}`);
    }
  });
  return { proc, tail: () => out };
}

async function killProc(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGINT');
  await new Promise((r) => proc.once('exit', r));
}

function spawnBot(args, { label }) {
  const proc = spawn('node', args, {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const appendOut = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  const appendErr = (chunk) => {
    err += chunk;
    if (err.length > 20000) err = err.slice(-20000);
  };
  proc.stdout.on('data', (d) => appendOut(String(d)));
  proc.stderr.on('data', (d) => appendErr(String(d)));
  return { proc, tail: () => ({ out, err }) };
}

async function connectBridge(sc, label) {
  await retry(
    async () => {
      try {
        await sc.connect();
      } catch (err) {
        sc.close();
        throw err;
      }
    },
    { label, tries: 160, delayMs: 250 }
  );
}

test('e2e: svc_announce re-broadcast reaches late joiners', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');

  // Local DHT bootstrapper for reliability (avoid public bootstrap nodes).
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  await dht.ready();
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  const storesDir = path.join(repoRoot, 'stores');
  const announcerStore = `e2e-svc-announcer-${runId}`;
  const listenerStore = `e2e-svc-listener-${runId}`;
  await writePeerKeypair({ storesDir, storeName: announcerStore });
  await writePeerKeypair({ storesDir, storeName: listenerStore });

  const announcerToken = `token-announcer-${runId}`;
  const listenerToken = `token-listener-${runId}`;
  const [announcerPort, listenerPort] = await pickFreePorts(2);

  const announcerPeer = spawnPeer(
    [
      '--peer-store-name',
      announcerStore,
      '--subnet-channel',
      `e2e-svc-subnet-${runId}`,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      announcerToken,
      '--sc-bridge-port',
      String(announcerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'announcer' }
  );

  t.after(async () => {
    await killProc(announcerPeer.proc);
  });

  // Wait until announcer SC-Bridge is reachable and sidechannels started.
  const announcerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${announcerPort}`, token: announcerToken });
  await connectBridge(announcerSc, 'announcer sc-bridge');
  await retry(async () => {
    const s = await announcerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('announcer sidechannel not started');
  }, { label: 'announcer sidechannel started', tries: 200, delayMs: 250 });
  announcerSc.close();

  // Start the announce loop on the announcer peer.
  const cfgDir = path.join(repoRoot, 'onchain/announce');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, `e2e-svc-${runId}.json`);
  fs.writeFileSync(
    cfgPath,
    `${JSON.stringify(
      {
        name: `svc-${runId}`,
        pairs: ['BTC_LN/USDT_SOL'],
        rfq_channels: ['0000intercomswapbtcusdt'],
        note: `e2e ${runId}`,
        offers: [{ have: 'USDT_SOL', want: 'BTC_LN', pair: 'BTC_LN/USDT_SOL' }],
      },
      null,
      2
    )}\n`
  );

  const loop = spawnBot(
    [
      'scripts/swapctl.mjs',
      '--url',
      `ws://127.0.0.1:${announcerPort}`,
      '--token',
      announcerToken,
      'svc-announce-loop',
      '--channels',
      '0000intercom',
      '--config',
      cfgPath,
      '--interval-sec',
      '1',
      '--watch',
      '0',
      '--ttl-sec',
      '5',
    ],
    { label: 'svc-announce-loop' }
  );
  t.after(async () => {
    await killProc(loop.proc);
  });

  // Wait for at least one broadcast before the listener peer joins.
  await new Promise((r) => setTimeout(r, 1200));

  const listenerPeer = spawnPeer(
    [
      '--peer-store-name',
      listenerStore,
      '--subnet-channel',
      `e2e-svc-subnet-${runId}`,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      listenerToken,
      '--sc-bridge-port',
      String(listenerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'listener' }
  );
  t.after(async () => {
    await killProc(listenerPeer.proc);
  });

  const listenerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${listenerPort}`, token: listenerToken });
  await connectBridge(listenerSc, 'listener sc-bridge');
  await retry(async () => {
    const s = await listenerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('listener sidechannel not started');
  }, { label: 'listener sidechannel started', tries: 200, delayMs: 250 });

  const seen = [];
  listenerSc.on('sidechannel_message', (evt) => {
    if (evt?.channel !== '0000intercom') return;
    seen.push(evt.message);
  });

  await retry(
    async () => {
      const msg = seen.find((m) => m && typeof m === 'object' && m.kind === KIND.SVC_ANNOUNCE);
      assert.ok(msg, `did not observe svc_announce. stderr tail:\n${loop.tail().err}`);
      assert.equal(String(msg.body?.name), `svc-${runId}`);
      return msg;
    },
    { label: 'observe svc_announce', tries: 40, delayMs: 250 }
  );

  listenerSc.close();
});
