import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import DHT from 'hyperdht';

import { Connection, Keypair } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from '@solana/spl-token';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import {
  createUnsignedEnvelope,
  attachSignature,
} from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { applySwapEnvelope, createInitialTrade } from '../src/swap/stateMachine.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { verifySwapPrePayOnchain } from '../src/swap/verify.js';

import {
  createSignedInvite,
  createSignedWelcome,
  signPayloadHex,
  toB64Json,
} from '../src/sidechannel/capabilities.js';

import {
  LN_USDT_ESCROW_PROGRAM_ID,
  claimEscrowTx,
  createEscrowTx,
  initConfigTx,
  initTradeConfigTx,
  getEscrowState,
  withdrawTradeFeesTx,
  withdrawFeesTx,
} from '../src/solana/lnUsdtEscrowClient.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const composeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 50,
    ...opts,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

async function dockerCompose(args) {
  return sh('docker', ['compose', '-f', composeFile, ...args]);
}

async function dockerComposeJson(args) {
  const { stdout } = await dockerCompose(args);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    throw new Error(`Failed to parse JSON: ${text.slice(0, 200)}`);
  }
}

async function retry(fn, { tries = 80, delayMs = 500, label = 'retry' } = {}) {
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

async function btcCli(args) {
  const { stdout } = await dockerCompose([
    'exec',
    '-T',
    'bitcoind',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=rpcuser',
    '-rpcpassword=rpcpass',
    '-rpcport=18443',
    ...args,
  ]);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { result: text };
  }
}

async function clnCli(service, args) {
  return dockerComposeJson(['exec', '-T', service, 'lightning-cli', '--network=regtest', ...args]);
}

function hasConfirmedUtxo(listFundsResult) {
  const outs = listFundsResult?.outputs;
  if (!Array.isArray(outs)) return false;
  return outs.some((o) => String(o?.status || '').toLowerCase() === 'confirmed');
}

function parseHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  assert.match(hex, /^[0-9a-f]{64}$/, `${label} must be 32-byte hex`);
  return hex;
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

async function startSolanaValidator({ soPath, ledgerSuffix }) {
  const ledgerPath = path.join(repoRoot, `onchain/solana/ledger-e2e-${ledgerSuffix}`);
  const url = 'https://api.devnet.solana.com';
  const args = [
    '--reset',
    '--ledger',
    ledgerPath,
    '--bind-address',
    '127.0.0.1',
    '--rpc-port',
    '8899',
    '--faucet-port',
    '9900',
    '--url',
    url,
    '--clone',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    '--clone',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    '--bpf-program',
    LN_USDT_ESCROW_PROGRAM_ID.toBase58(),
    soPath,
    '--quiet',
  ];

  const proc = spawn('solana-test-validator', args, {
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

  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  await retry(() => connection.getVersion(), { label: 'solana rpc ready', tries: 120, delayMs: 500 });

  return {
    proc,
    connection,
    tail: () => out,
    stop: async () => {
      proc.kill('SIGINT');
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

async function sendAndConfirm(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

async function writePeerKeypair({ storesDir, storeName }) {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();
  const keyPairPath = path.join(storesDir, storeName, 'db', 'keypair.json');
  await fsMkdirp(path.dirname(keyPairPath));
  wallet.exportToFile(keyPairPath, b4a.alloc(0));
  return {
    keyPairPath,
    pubHex: b4a.toString(wallet.publicKey, 'hex'),
    secHex: b4a.toString(wallet.secretKey, 'hex'),
  };
}

async function fsMkdirp(dir) {
  await sh('mkdir', ['-p', dir]);
}

function writeSolanaKeypairJson(filePath, keypair) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
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
      // Surface in logs if a peer dies unexpectedly.
      console.error(`[e2e:${label}] exited code=${code}`);
      console.error(out.slice(-20000));
    }
  });
  return { proc, tail: () => out };
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
  const wait = () =>
    new Promise((resolve, reject) => {
      proc.once('exit', (code) => {
        if (code === 0) resolve({ out, err });
        else reject(new Error(`[${label}] exit code=${code}. stderr tail:\n${err}\nstdout tail:\n${out}`));
      });
      proc.once('error', (e) => reject(e));
    });
  return { proc, wait, tail: () => ({ out, err }) };
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (_e) {}
  }
  return events;
}

async function killProc(proc) {
  if (!proc || proc.killed) return;
  const waitExit = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  try {
    proc.kill('SIGINT');
  } catch (_e) {}
  await waitExit(2500);
  if (!proc.killed) {
    try {
      proc.kill('SIGKILL');
    } catch (_e) {}
    await waitExit(2500);
  }
}

async function signEnvelopeViaBridge(sc, unsignedEnvelope) {
  const res = await sc.sign(unsignedEnvelope);
  assert.equal(res.type, 'signed');
  return attachSignature(unsignedEnvelope, {
    signerPubKeyHex: String(res.signer || '').toLowerCase(),
    sigHex: String(res.sig || '').toLowerCase(),
  });
}

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50, label = 'waitFor' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} timeout after ${timeoutMs}ms`);
}

async function connectBridge(sc, label) {
  await retry(
    async () => {
      try {
        await sc.connect();
      } catch (err) {
        sc.close(); // reset connection state for the next attempt
        throw err;
      }
    },
    { label, tries: 80, delayMs: 250 }
  );
}

async function sendUntilReceived({
  sender,
  receiverSeen,
  channel,
  message,
  sendOptions,
  match,
  label,
  tries = 40,
  delayMs = 500,
  perTryTimeoutMs = 1500,
}) {
  await retry(
    async () => {
      const before = receiverSeen.length;
      const res = await sender.send(channel, message, sendOptions);
      assert.equal(res.type, 'sent');
      await waitFor(
        () => receiverSeen.slice(before).some(match),
        { timeoutMs: perTryTimeoutMs, intervalMs: 50, label: `${label} (per try)` }
      );
    },
    { label, tries, delayMs }
  );
}

test('e2e: sidechannel swap protocol + LN regtest + Solana escrow', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');
  const tradeId = `swap_e2e_${runId}`;
  const rfqChannel = `btc-usdt-sol-rfq-${runId}`;
  const swapChannel = `swap:${tradeId}`;
  let makerBot = null;
  let takerBot = null;

  // Avoid relying on external DHT bootstrap nodes for e2e reliability.
  // Peers are configured to use this local bootstrapper via --dht-bootstrap.
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  await dht.ready();
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  // Build the Solana program once.
  await sh('cargo', ['build-sbf'], { cwd: path.join(repoRoot, 'solana/ln_usdt_escrow') });
  const soPath = path.join(repoRoot, 'solana/ln_usdt_escrow/target/deploy/ln_usdt_escrow.so');

  // Start LN stack.
  await dockerCompose(['up', '-d']);
  t.after(async () => {
    try {
      await dockerCompose(['down', '-v', '--remove-orphans']);
    } catch (_e) {}
  });

  await retry(() => btcCli(['getblockchaininfo']), { label: 'bitcoind ready', tries: 120, delayMs: 500 });
  await retry(() => clnCli('cln-alice', ['getinfo']), { label: 'cln-alice ready', tries: 120, delayMs: 500 });
  await retry(() => clnCli('cln-bob', ['getinfo']), { label: 'cln-bob ready', tries: 120, delayMs: 500 });

  // Create miner wallet and mine spendable coins.
  try {
    await btcCli(['createwallet', 'miner']);
  } catch (_e) {}
  const minerAddr = (await btcCli(['-rpcwallet=miner', 'getnewaddress'])).result;
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '101', minerAddr]);

  // Fund both LN nodes.
  const aliceBtcAddr = (await clnCli('cln-alice', ['newaddr'])).bech32;
  const bobBtcAddr = (await clnCli('cln-bob', ['newaddr'])).bech32;
  await btcCli(['-rpcwallet=miner', 'sendtoaddress', aliceBtcAddr, '1']);
  await btcCli(['-rpcwallet=miner', 'sendtoaddress', bobBtcAddr, '1']);
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);

  await retry(async () => {
    const funds = await clnCli('cln-alice', ['listfunds']);
    if (!hasConfirmedUtxo(funds)) throw new Error('alice not funded (no confirmed UTXO yet)');
    return funds;
  }, { label: 'alice funded' });
  await retry(async () => {
    const funds = await clnCli('cln-bob', ['listfunds']);
    if (!hasConfirmedUtxo(funds)) throw new Error('bob not funded (no confirmed UTXO yet)');
    return funds;
  }, { label: 'bob funded' });

  // Connect and open channel (bob -> alice).
  const aliceInfo = await clnCli('cln-alice', ['getinfo']);
  const aliceNodeId = aliceInfo.id;
  await clnCli('cln-bob', ['connect', `${aliceNodeId}@cln-alice:9735`]);
  await retry(() => clnCli('cln-bob', ['fundchannel', aliceNodeId, '1000000']), {
    label: 'fundchannel',
    tries: 30,
    delayMs: 1000,
  });
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);

  await retry(async () => {
    const chans = await clnCli('cln-bob', ['listpeerchannels']);
    const c = chans.channels?.find((x) => x.peer_id === aliceNodeId);
    const st = c?.state || '';
    if (st !== 'CHANNELD_NORMAL') throw new Error(`channel state=${st}`);
    return chans;
  }, { label: 'channel active', tries: 120, delayMs: 500 });

  // Start Solana local validator with our program loaded.
  const sol = await startSolanaValidator({ soPath, ledgerSuffix: runId });
  t.after(async () => {
    try {
      await sol.stop();
    } catch (_e) {}
  });
  const connection = sol.connection;

  // Solana identities for settlement layer.
  const solService = Keypair.generate();
  const solClient = Keypair.generate();
  const solKeysDir = path.join(repoRoot, 'onchain/solana/keys-e2e', runId);
  const solServiceKeyPath = path.join(solKeysDir, 'service.json');
  const solClientKeyPath = path.join(solKeysDir, 'client.json');
  writeSolanaKeypairJson(solServiceKeyPath, solService);
  writeSolanaKeypairJson(solClientKeyPath, solClient);
  const airdrop1 = await connection.requestAirdrop(solService.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdrop1, 'confirmed');
  const airdrop2 = await connection.requestAirdrop(solClient.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdrop2, 'confirmed');

  const mint = await createMint(connection, solService, solService.publicKey, null, 6);
  const serviceToken = await createAssociatedTokenAccount(connection, solService, mint, solService.publicKey);
  const clientToken = await createAssociatedTokenAccount(connection, solService, mint, solClient.publicKey);
  await mintTo(connection, solService, mint, serviceToken, solService, 200_000_000n);

  // Program-wide fee config (platform fee 0.5%).
  const solFeeAuthority = Keypair.generate();
  const solTradeFeeAuthority = Keypair.generate();
  const airdropFeeAuth = await connection.requestAirdrop(solFeeAuthority.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdropFeeAuth, 'confirmed');
  const airdropTradeFeeAuth = await connection.requestAirdrop(solTradeFeeAuthority.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdropTradeFeeAuth, 'confirmed');
  const feeCollectorToken = await createAssociatedTokenAccount(
    connection,
    solService,
    mint,
    solFeeAuthority.publicKey
  );
  const tradeFeeCollectorToken = await createAssociatedTokenAccount(
    connection,
    solService,
    mint,
    solTradeFeeAuthority.publicKey
  );
  const { tx: initCfgTx } = await initConfigTx({
    connection,
    payer: solFeeAuthority,
    feeCollector: solFeeAuthority.publicKey,
    feeBps: 50,
  });
  await sendAndConfirm(connection, initCfgTx);

  // Trade fee config (trade fee 0.5%).
  const { tx: initTradeCfgTx } = await initTradeConfigTx({
    connection,
    payer: solTradeFeeAuthority,
    feeCollector: solTradeFeeAuthority.publicKey,
    feeBps: 50,
  });
  await sendAndConfirm(connection, initTradeCfgTx);

  // Intercom peer identities.
  const storesDir = path.join(repoRoot, 'stores');
  const aliceStore = `e2e-alice-${runId}`;
  const bobStore = `e2e-bob-${runId}`;
  const eveStore = `e2e-eve-${runId}`;

  const aliceReceiptsDb = path.join(repoRoot, 'onchain/receipts', `${aliceStore}.sqlite`);
  const bobReceiptsDb = path.join(repoRoot, 'onchain/receipts', `${bobStore}.sqlite`);

  const aliceKeys = await writePeerKeypair({ storesDir, storeName: aliceStore });
  const bobKeys = await writePeerKeypair({ storesDir, storeName: bobStore });
  await writePeerKeypair({ storesDir, storeName: eveStore });

  const signAliceHex = (payload) => signPayloadHex(payload, aliceKeys.secHex);

  // Pre-sign a welcome for the RFQ channel (startup requirement for welcome enforcement).
  const rfqWelcome = createSignedWelcome(
    { channel: rfqChannel, ownerPubKey: aliceKeys.pubHex, text: `rfq ${runId}` },
    signAliceHex
  );
  const rfqWelcomeB64 = toB64Json(rfqWelcome);

  const aliceTokenWs = `token-alice-${runId}`;
  const bobTokenWs = `token-bob-${runId}`;
  const eveTokenWs = `token-eve-${runId}`;
  const [alicePort, bobPort, evePort] = await pickFreePorts(3);

  const alicePeer = spawnPeer(
    [
      '--peer-store-name',
      aliceStore,
      '--msb-store-name',
      `${aliceStore}-msb`,
      '--subnet-channel',
      `e2e-subnet-${runId}-a`,
      '--dht-bootstrap',
      dhtBootstrap,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      aliceTokenWs,
      '--sc-bridge-port',
      String(alicePort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      aliceKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${aliceKeys.pubHex}`,
      '--sidechannel-default-owner',
      aliceKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'alice' }
  );

  const bobPeer = spawnPeer(
    [
      '--peer-store-name',
      bobStore,
      '--msb-store-name',
      `${bobStore}-msb`,
      '--subnet-channel',
      `e2e-subnet-${runId}-b`,
      '--dht-bootstrap',
      dhtBootstrap,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      bobTokenWs,
      '--sc-bridge-port',
      String(bobPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      aliceKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${aliceKeys.pubHex}`,
      '--sidechannel-default-owner',
      aliceKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'bob' }
  );

  // Malicious peer: joins the swap topic but is not invited; should receive nothing due to sender-side gating.
  const evePeer = spawnPeer(
    [
      '--peer-store-name',
      eveStore,
      '--msb-store-name',
      `${eveStore}-msb`,
      '--subnet-channel',
      `e2e-subnet-${runId}-e`,
      '--dht-bootstrap',
      dhtBootstrap,
      '--msb',
      '0',
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      eveTokenWs,
      '--sc-bridge-port',
      String(evePort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
      '--sidechannel-invite-required',
      '0',
    ],
    { label: 'eve' }
  );

  t.after(async () => {
    // Bots are not covered by the peer kill hooks below; always tear them down.
    await killProc(takerBot?.proc);
    await killProc(makerBot?.proc);
    await killProc(evePeer.proc);
    await killProc(bobPeer.proc);
    await killProc(alicePeer.proc);
  });

  const aliceSc = new ScBridgeClient({ url: `ws://127.0.0.1:${alicePort}`, token: aliceTokenWs });
  const bobSc = new ScBridgeClient({ url: `ws://127.0.0.1:${bobPort}`, token: bobTokenWs });
  const eveSc = new ScBridgeClient({ url: `ws://127.0.0.1:${evePort}`, token: eveTokenWs });

  await connectBridge(aliceSc, 'alice sc-bridge');
  await connectBridge(bobSc, 'bob sc-bridge');
  await connectBridge(eveSc, 'eve sc-bridge');

  t.after(() => {
    eveSc.close();
    bobSc.close();
    aliceSc.close();
  });

  // Ensure sidechannels have passed the DHT bootstrap barrier and joined topics.
  await retry(async () => {
    const s = await aliceSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('alice sidechannel not started');
  }, { label: 'alice sidechannel started', tries: 200, delayMs: 250 });
  await retry(async () => {
    const s = await bobSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('bob sidechannel not started');
  }, { label: 'bob sidechannel started', tries: 200, delayMs: 250 });

  await aliceSc.subscribe([rfqChannel, swapChannel]);
  await bobSc.subscribe([rfqChannel, swapChannel]);
  await eveSc.subscribe([swapChannel]);

  // Collect messages early; we use RFQ pings to ensure peers are connected before the swap.
  const seen = {
    alice: { rfq: [], swap: [] },
    bob: { rfq: [], swap: [] },
    eve: { swap: [] },
  };
  aliceSc.on('sidechannel_message', (evt) => {
    if (evt.channel === rfqChannel) seen.alice.rfq.push(evt.message);
    if (evt.channel === swapChannel) seen.alice.swap.push(evt.message);
  });
  bobSc.on('sidechannel_message', (evt) => {
    if (evt.channel === rfqChannel) seen.bob.rfq.push(evt.message);
    if (evt.channel === swapChannel) seen.bob.swap.push(evt.message);
  });
  eveSc.on('sidechannel_message', (evt) => {
    if (evt.channel === swapChannel) seen.eve.swap.push(evt.message);
  });

  // Connectivity barrier: ensure both peers can exchange messages on the RFQ channel before
  // starting the RFQ bots (reduces flakiness on slow/bootstrapping hyperswarm discovery).
  await sendUntilReceived({
    sender: aliceSc,
    receiverSeen: seen.bob.rfq,
    channel: rfqChannel,
    message: { type: 'e2e_ping', from: 'alice', runId },
    match: (m) => m?.type === 'e2e_ping' && m?.from === 'alice' && m?.runId === runId,
    label: 'rfq ping alice->bob',
    tries: 80,
    delayMs: 250,
    perTryTimeoutMs: 1500,
  });
  await sendUntilReceived({
    sender: bobSc,
    receiverSeen: seen.alice.rfq,
    channel: rfqChannel,
    message: { type: 'e2e_ping', from: 'bob', runId },
    match: (m) => m?.type === 'e2e_ping' && m?.from === 'bob' && m?.runId === runId,
    label: 'rfq ping bob->alice',
    tries: 80,
    delayMs: 250,
    perTryTimeoutMs: 1500,
  });

  let aliceTrade = createInitialTrade(tradeId);
  let bobTrade = createInitialTrade(tradeId);

  const usdtAmount = 100_000_000n;
  const sats = 50_000;

  // Eve joins the swap topic early (uninvited). Sender-side invite gating must prevent leakage.
  const joinE = await eveSc.join(swapChannel);
  assert.equal(joinE.type, 'joined');

  const beforeBal = (await getAccount(connection, clientToken, 'confirmed')).amount;

  makerBot = spawnBot(
    [
      'scripts/rfq-maker.mjs',
      '--url',
      `ws://127.0.0.1:${alicePort}`,
      '--token',
      aliceTokenWs,
      '--rfq-channel',
      rfqChannel,
      '--once',
      '1',
      '--receipts-db',
      aliceReceiptsDb,
      '--run-swap',
      '1',
      '--swap-timeout-sec',
      '240',
      '--ln-backend',
      'docker',
      '--ln-compose-file',
      composeFile,
      '--ln-service',
      'cln-alice',
      '--ln-network',
      'regtest',
      '--solana-rpc-url',
      'http://127.0.0.1:8899',
      '--solana-keypair',
      solServiceKeyPath,
      '--solana-mint',
      mint.toBase58(),
      '--solana-trade-fee-collector',
      solTradeFeeAuthority.publicKey.toBase58(),
    ],
    { label: 'maker-bot' }
  );

  takerBot = spawnBot(
    [
      'scripts/rfq-taker.mjs',
      '--url',
      `ws://127.0.0.1:${bobPort}`,
      '--token',
      bobTokenWs,
      '--rfq-channel',
      rfqChannel,
      '--trade-id',
      tradeId,
      '--btc-sats',
      String(sats),
      '--usdt-amount',
      usdtAmount.toString(),
      '--timeout-sec',
      '30',
      '--once',
      '1',
      '--receipts-db',
      bobReceiptsDb,
      '--run-swap',
      '1',
      '--swap-timeout-sec',
      '240',
      '--ln-backend',
      'docker',
      '--ln-compose-file',
      composeFile,
      '--ln-service',
      'cln-bob',
      '--ln-network',
      'regtest',
      '--solana-rpc-url',
      'http://127.0.0.1:8899',
      '--solana-keypair',
      solClientKeyPath,
      '--solana-mint',
      mint.toBase58(),
    ],
    { label: 'taker-bot' }
  );

  const [makerRes, takerRes] = await Promise.all([makerBot.wait(), takerBot.wait()]);
  const makerEvents = parseJsonLines(makerRes.out);
  const takerEvents = parseJsonLines(takerRes.out);
  assert.ok(
    makerEvents.some((e) => e?.type === 'swap_done'),
    `maker bot did not emit swap_done. stdout tail:\n${makerRes.out}\nstderr tail:\n${makerRes.err}`
  );
  assert.ok(
    takerEvents.some((e) => e?.type === 'swap_done'),
    `taker bot did not emit swap_done. stdout tail:\n${takerRes.out}\nstderr tail:\n${takerRes.err}`
  );

  await waitFor(
    () => {
      const all = [...seen.alice.swap, ...seen.bob.swap];
      return (
        all.some((m) => m?.kind === KIND.LN_INVOICE) &&
        all.some((m) => m?.kind === KIND.SOL_ESCROW_CREATED) &&
        all.some((m) => m?.kind === KIND.SOL_CLAIMED)
      );
    },
    { timeoutMs: 20_000, intervalMs: 100, label: 'swap messages observed' }
  );

  const afterBal = (await getAccount(connection, clientToken, 'confirmed')).amount;
  assert.equal(afterBal - beforeBal, usdtAmount);

  // Receipts persistence check (local-only, for recovery).
  const aliceReceipts = openTradeReceiptsStore({ dbPath: aliceReceiptsDb });
  const bobReceipts = openTradeReceiptsStore({ dbPath: bobReceiptsDb });
  try {
    const aTrade = aliceReceipts.getTrade(tradeId);
    const bTrade = bobReceipts.getTrade(tradeId);
    assert.ok(aTrade, 'maker receipts missing trade');
    assert.ok(bTrade, 'taker receipts missing trade');
    assert.equal(aTrade.swap_channel, swapChannel);
    assert.equal(bTrade.swap_channel, swapChannel);
    assert.equal(aTrade.role, 'maker');
    assert.equal(bTrade.role, 'taker');
    assert.match(String(aTrade.ln_payment_hash_hex || ''), /^[0-9a-f]{64}$/);
    assert.match(String(bTrade.ln_payment_hash_hex || ''), /^[0-9a-f]{64}$/);
  } finally {
    aliceReceipts.close();
    bobReceipts.close();
  }

  // Fee withdrawal check.
  const feeBal = (await getAccount(connection, feeCollectorToken, 'confirmed')).amount;
  assert.equal(feeBal, 0n);

  const { tx: withdrawTx } = await withdrawFeesTx({
    connection,
    feeCollector: solFeeAuthority,
    feeCollectorTokenAccount: feeCollectorToken,
    mint,
    amount: 0n,
  });
  await sendAndConfirm(connection, withdrawTx);
  const feeBal2 = (await getAccount(connection, feeCollectorToken, 'confirmed')).amount;
  assert.equal(feeBal2, 500_000n);

  const tradeFeeBal = (await getAccount(connection, tradeFeeCollectorToken, 'confirmed')).amount;
  assert.equal(tradeFeeBal, 0n);

  const { tx: withdrawTradeTx } = await withdrawTradeFeesTx({
    connection,
    feeCollector: solTradeFeeAuthority,
    feeCollectorTokenAccount: tradeFeeCollectorToken,
    mint,
    amount: 0n,
  });
  await sendAndConfirm(connection, withdrawTradeTx);
  const tradeFeeBal2 = (await getAccount(connection, tradeFeeCollectorToken, 'confirmed')).amount;
  assert.equal(tradeFeeBal2, 500_000n);

  const invoiceMsg = [...seen.alice.swap, ...seen.bob.swap].find((m) => m?.kind === KIND.LN_INVOICE);
  assert.ok(invoiceMsg, 'missing LN_INVOICE');
  const paymentHashHex = parseHex32(invoiceMsg.body?.payment_hash_hex, 'payment_hash_hex');

  const st = await getEscrowState(connection, paymentHashHex);
  assert.ok(st);
  assert.equal(st.status, 1);
  assert.equal(st.netAmount, 0n);
  assert.equal(st.feeAmount, 0n);

  // Apply union of swap messages to state machines and ensure we reach terminal state.
  const allSwap = [...seen.alice.swap, ...seen.bob.swap]
    .filter((m) => m && typeof m === 'object' && m.trade_id === tradeId)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  for (const msg of allSwap) {
    const resA = applySwapEnvelope(aliceTrade, msg);
    if (resA.ok) aliceTrade = resA.trade;
    const resB = applySwapEnvelope(bobTrade, msg);
    if (resB.ok) bobTrade = resB.trade;
  }
  assert.equal(aliceTrade.state, STATE.CLAIMED);
  assert.equal(bobTrade.state, STATE.CLAIMED);

  // Confidentiality check: Eve joined the channel topic, but should not receive any payloads.
  assert.equal(seen.eve.swap.length, 0, `eve received ${seen.eve.swap.length} messages`);
});
