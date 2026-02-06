import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  getEscrowState,
} from '../src/solana/lnUsdtEscrowClient.js';

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

async function killProc(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGINT');
  } catch (_e) {
    try {
      proc.kill('SIGKILL');
    } catch (_e2) {}
  }
  await new Promise((r) => proc.once('exit', r));
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
  const otcChannel = `btc-usdt-sol-otc-${runId}`;
  const swapChannel = `swap:${runId}`;

  // Avoid relying on external DHT bootstrap nodes for e2e reliability.
  // Peers are configured to use this local bootstrapper via --dht-bootstrap.
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
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
  const airdrop1 = await connection.requestAirdrop(solService.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdrop1, 'confirmed');
  const airdrop2 = await connection.requestAirdrop(solClient.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdrop2, 'confirmed');

  const mint = await createMint(connection, solService, solService.publicKey, null, 6);
  const serviceToken = await createAssociatedTokenAccount(connection, solService, mint, solService.publicKey);
  const clientToken = await createAssociatedTokenAccount(connection, solService, mint, solClient.publicKey);
  await mintTo(connection, solService, mint, serviceToken, solService, 200_000_000n);

  // Intercom peer identities.
  const storesDir = path.join(repoRoot, 'stores');
  const aliceStore = `e2e-alice-${runId}`;
  const bobStore = `e2e-bob-${runId}`;
  const eveStore = `e2e-eve-${runId}`;

  const aliceKeys = await writePeerKeypair({ storesDir, storeName: aliceStore });
  const bobKeys = await writePeerKeypair({ storesDir, storeName: bobStore });
  await writePeerKeypair({ storesDir, storeName: eveStore });

  const signAliceHex = (payload) => signPayloadHex(payload, aliceKeys.secHex);

  // Pre-sign a welcome for the OTC channel (startup requirement for welcome enforcement).
  const otcWelcome = createSignedWelcome(
    { channel: otcChannel, ownerPubKey: aliceKeys.pubHex, text: `otc ${runId}` },
    signAliceHex
  );
  const otcWelcomeB64 = toB64Json(otcWelcome);

  const aliceTokenWs = `token-alice-${runId}`;
  const bobTokenWs = `token-bob-${runId}`;
  const eveTokenWs = `token-eve-${runId}`;
  const portBase = 45000 + crypto.randomInt(0, 1000);
  const alicePort = portBase;
  const bobPort = portBase + 1;
  const evePort = portBase + 2;

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
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      aliceTokenWs,
      '--sc-bridge-port',
      String(alicePort),
      '--sidechannels',
      otcChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      aliceKeys.pubHex,
      '--sidechannel-owner',
      `${otcChannel}:${aliceKeys.pubHex}`,
      '--sidechannel-default-owner',
      aliceKeys.pubHex,
      '--sidechannel-welcome',
      `${otcChannel}:b64:${otcWelcomeB64}`,
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
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      bobTokenWs,
      '--sc-bridge-port',
      String(bobPort),
      '--sidechannels',
      otcChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      aliceKeys.pubHex,
      '--sidechannel-owner',
      `${otcChannel}:${aliceKeys.pubHex}`,
      '--sidechannel-default-owner',
      aliceKeys.pubHex,
      '--sidechannel-welcome',
      `${otcChannel}:b64:${otcWelcomeB64}`,
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

  await aliceSc.subscribe([otcChannel, swapChannel]);
  await bobSc.subscribe([otcChannel, swapChannel]);
  await eveSc.subscribe([swapChannel]);

  // Collect messages early; we use OTC pings to ensure peers are connected before the swap.
  const seen = {
    alice: { otc: [], swap: [] },
    bob: { otc: [], swap: [] },
    eve: { swap: [] },
  };
  aliceSc.on('sidechannel_message', (evt) => {
    if (evt.channel === otcChannel) seen.alice.otc.push(evt.message);
    if (evt.channel === swapChannel) seen.alice.swap.push(evt.message);
  });
  bobSc.on('sidechannel_message', (evt) => {
    if (evt.channel === otcChannel) seen.bob.otc.push(evt.message);
    if (evt.channel === swapChannel) seen.bob.swap.push(evt.message);
  });
  eveSc.on('sidechannel_message', (evt) => {
    if (evt.channel === swapChannel) seen.eve.swap.push(evt.message);
  });

  // Ensure we have a working connection (OTC channel is non-invite-protected, but welcome-protected).
  const ping = { ping: runId, ts: Date.now() };
  await sendUntilReceived({
    sender: bobSc,
    receiverSeen: seen.alice.otc,
    channel: otcChannel,
    message: ping,
    sendOptions: {},
    match: (m) => m?.ping === runId,
    label: 'otc ping bob->alice',
  });
  await sendUntilReceived({
    sender: aliceSc,
    receiverSeen: seen.bob.otc,
    channel: otcChannel,
    message: { pong: runId, ts: Date.now() },
    sendOptions: {},
    match: (m) => m?.pong === runId,
    label: 'otc pong alice->bob',
  });

  // Prepare swap-channel welcome + invite (owned by the service peer Alice).
  const swapWelcome = createSignedWelcome(
    { channel: swapChannel, ownerPubKey: aliceKeys.pubHex, text: `swap ${runId}` },
    signAliceHex
  );

  const inviteForBob = createSignedInvite(
    {
      channel: swapChannel,
      inviteePubKey: bobKeys.pubHex,
      inviterPubKey: aliceKeys.pubHex,
      ttlMs: 10 * 60 * 1000,
    },
    signAliceHex,
    { welcome: swapWelcome }
  );

  // Join swap channel (service joins first).
  const joinA = await aliceSc.join(swapChannel, { welcome: swapWelcome });
  assert.equal(joinA.type, 'joined');

  const joinB = await bobSc.join(swapChannel, { invite: inviteForBob, welcome: swapWelcome });
  assert.equal(joinB.type, 'joined');

  const joinE = await eveSc.join(swapChannel);
  assert.equal(joinE.type, 'joined');

  const tradeId = `swap_e2e_${runId}`;
  let aliceTrade = createInitialTrade(tradeId);
  let bobTrade = createInitialTrade(tradeId);

  // Bob sends a signed "ready" status with invite attached (ensures Alice authorizes Bob quickly).
  const readyUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.STATUS,
    tradeId,
    body: { state: STATE.INIT, note: 'ready' },
  });
  const readySigned = await signEnvelopeViaBridge(bobSc, readyUnsigned);
  assert.equal(validateSwapEnvelope(readySigned).ok, true);
  await sendUntilReceived({
    sender: bobSc,
    receiverSeen: seen.alice.swap,
    channel: swapChannel,
    message: readySigned,
    sendOptions: { invite: inviteForBob },
    match: (m) => m?.kind === KIND.STATUS,
    label: 'alice got ready',
    tries: 60,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });

  // Terms (service is LN receiver + Solana depositor).
  const nowSec = Math.floor(Date.now() / 1000);
  const usdtAmount = 100_000_000n;
  const sats = 50_000;

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: sats,
      usdt_amount: usdtAmount.toString(),
      usdt_decimals: 6,
      sol_mint: mint.toBase58(),
      sol_recipient: solClient.publicKey.toBase58(),
      sol_refund: solService.publicKey.toBase58(),
      sol_refund_after_unix: nowSec + 3600,
      ln_receiver_peer: aliceKeys.pubHex,
      ln_payer_peer: bobKeys.pubHex,
      terms_valid_until_unix: nowSec + 300,
    },
  });
  const termsSigned = await signEnvelopeViaBridge(aliceSc, termsUnsigned);
  assert.equal(validateSwapEnvelope(termsSigned).ok, true);
  await sendUntilReceived({
    sender: aliceSc,
    receiverSeen: seen.bob.swap,
    channel: swapChannel,
    message: termsSigned,
    sendOptions: {},
    match: (m) => m?.kind === KIND.TERMS,
    label: 'bob got terms',
    tries: 30,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });
  {
    const r = applySwapEnvelope(aliceTrade, termsSigned);
    assert.equal(r.ok, true, r.error);
    aliceTrade = r.trade;
  }

  {
    const r = applySwapEnvelope(bobTrade, termsSigned);
    assert.equal(r.ok, true, r.error);
    bobTrade = r.trade;
    assert.equal(bobTrade.state, STATE.TERMS);
  }

  // Accept.
  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: hashUnsignedEnvelope(termsUnsigned) },
  });
  const acceptSigned = await signEnvelopeViaBridge(bobSc, acceptUnsigned);
  await sendUntilReceived({
    sender: bobSc,
    receiverSeen: seen.alice.swap,
    channel: swapChannel,
    message: acceptSigned,
    sendOptions: {},
    match: (m) => m?.kind === KIND.ACCEPT,
    label: 'alice got accept',
    tries: 30,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });
  {
    const r = applySwapEnvelope(bobTrade, acceptSigned);
    assert.equal(r.ok, true, r.error);
    bobTrade = r.trade;
    assert.equal(bobTrade.state, STATE.ACCEPTED);
  }

  {
    const r = applySwapEnvelope(aliceTrade, acceptSigned);
    assert.equal(r.ok, true, r.error);
    aliceTrade = r.trade;
    assert.equal(aliceTrade.state, STATE.ACCEPTED);
  }

  // Service creates LN invoice (normal invoice; no hodl invoices).
  const invoice = await clnCli('cln-alice', ['invoice', `${sats}sat`, tradeId, 'swap']);
  const bolt11 = invoice.bolt11;
  const paymentHashHex = parseHex32(invoice.payment_hash, 'payment_hash');

  const lnInvUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_INVOICE,
    tradeId,
    body: {
      bolt11,
      payment_hash_hex: paymentHashHex,
      amount_msat: String(sats * 1000),
    },
  });
  const lnInvSigned = await signEnvelopeViaBridge(aliceSc, lnInvUnsigned);
  await sendUntilReceived({
    sender: aliceSc,
    receiverSeen: seen.bob.swap,
    channel: swapChannel,
    message: lnInvSigned,
    sendOptions: {},
    match: (m) => m?.kind === KIND.LN_INVOICE,
    label: 'bob got invoice',
    tries: 30,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });
  {
    const r = applySwapEnvelope(aliceTrade, lnInvSigned);
    assert.equal(r.ok, true, r.error);
    aliceTrade = r.trade;
    assert.equal(aliceTrade.state, STATE.INVOICE);
  }
  {
    const r = applySwapEnvelope(bobTrade, lnInvSigned);
    assert.equal(r.ok, true, r.error);
    bobTrade = r.trade;
    assert.equal(bobTrade.state, STATE.INVOICE);
  }

  // Service locks USDT in Solana escrow keyed to LN payment_hash.
  const refundAfter = Math.floor(Date.now() / 1000) + 3600;
  const { tx: escrowTx, escrowPda, vault } = await createEscrowTx({
    connection,
    payer: solService,
    payerTokenAccount: serviceToken,
    mint,
    paymentHashHex,
    recipient: solClient.publicKey,
    refund: solService.publicKey,
    refundAfterUnix: refundAfter,
    amount: usdtAmount,
  });
  const escrowSig = await sendAndConfirm(connection, escrowTx);

  const solEscrowUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_ESCROW_CREATED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashHex,
      program_id: LN_USDT_ESCROW_PROGRAM_ID.toBase58(),
      escrow_pda: escrowPda.toBase58(),
      vault_ata: vault.toBase58(),
      mint: mint.toBase58(),
      amount: usdtAmount.toString(),
      refund_after_unix: refundAfter,
      recipient: solClient.publicKey.toBase58(),
      refund: solService.publicKey.toBase58(),
      tx_sig: escrowSig,
    },
  });
  const solEscrowSigned = await signEnvelopeViaBridge(aliceSc, solEscrowUnsigned);
  await sendUntilReceived({
    sender: aliceSc,
    receiverSeen: seen.bob.swap,
    channel: swapChannel,
    message: solEscrowSigned,
    sendOptions: {},
    match: (m) => m?.kind === KIND.SOL_ESCROW_CREATED,
    label: 'bob got escrow proof',
    tries: 30,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });
  {
    const r = applySwapEnvelope(aliceTrade, solEscrowSigned);
    assert.equal(r.ok, true, r.error);
    aliceTrade = r.trade;
    assert.equal(aliceTrade.state, STATE.ESCROW);
  }
  {
    const r = applySwapEnvelope(bobTrade, solEscrowSigned);
    assert.equal(r.ok, true, r.error);
    bobTrade = r.trade;
    assert.equal(bobTrade.state, STATE.ESCROW);
  }

  // Client pays LN invoice and claims escrow with preimage.
  const payRes = await clnCli('cln-bob', ['pay', bolt11]);
  const preimageHex = parseHex32(payRes.payment_preimage, 'payment_preimage');

  const lnPaidUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_PAID,
    tradeId,
    body: { payment_hash_hex: paymentHashHex },
  });
  const lnPaidSigned = await signEnvelopeViaBridge(bobSc, lnPaidUnsigned);
  await sendUntilReceived({
    sender: bobSc,
    receiverSeen: seen.alice.swap,
    channel: swapChannel,
    message: lnPaidSigned,
    sendOptions: {},
    match: (m) => m?.kind === KIND.LN_PAID,
    label: 'alice got ln_paid',
    tries: 30,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });
  {
    const r = applySwapEnvelope(bobTrade, lnPaidSigned);
    assert.equal(r.ok, true, r.error);
    bobTrade = r.trade;
    assert.equal(bobTrade.state, STATE.LN_PAID);
  }

  const beforeBal = (await getAccount(connection, clientToken, 'confirmed')).amount;
  const { tx: claimTx } = await claimEscrowTx({
    connection,
    recipient: solClient,
    recipientTokenAccount: clientToken,
    mint,
    paymentHashHex,
    preimageHex,
  });
  const claimSig = await sendAndConfirm(connection, claimTx);
  const afterBal = (await getAccount(connection, clientToken, 'confirmed')).amount;
  assert.equal(afterBal - beforeBal, usdtAmount);

  const claimedUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_CLAIMED,
    tradeId,
    body: { payment_hash_hex: paymentHashHex, escrow_pda: escrowPda.toBase58(), tx_sig: claimSig },
  });
  const claimedSigned = await signEnvelopeViaBridge(bobSc, claimedUnsigned);
  await sendUntilReceived({
    sender: bobSc,
    receiverSeen: seen.alice.swap,
    channel: swapChannel,
    message: claimedSigned,
    sendOptions: {},
    match: (m) => m?.kind === KIND.SOL_CLAIMED,
    label: 'alice got claimed',
    tries: 30,
    delayMs: 500,
    perTryTimeoutMs: 2000,
  });
  {
    const r = applySwapEnvelope(bobTrade, claimedSigned);
    assert.equal(r.ok, true, r.error);
    bobTrade = r.trade;
    assert.equal(bobTrade.state, STATE.CLAIMED);
  }

  // Verify escrow state on-chain.
  const st = await getEscrowState(connection, paymentHashHex);
  assert.ok(st);
  assert.equal(st.status, 1);
  assert.equal(st.amount, 0n);

  // Apply all messages to state machines.
  for (const msg of seen.alice.swap) {
    if (!msg || typeof msg !== 'object') continue;
    const res = applySwapEnvelope(aliceTrade, msg);
    if (res.ok) aliceTrade = res.trade;
  }
  for (const msg of seen.bob.swap) {
    if (!msg || typeof msg !== 'object') continue;
    const res = applySwapEnvelope(bobTrade, msg);
    if (res.ok) bobTrade = res.trade;
  }
  assert.equal(aliceTrade.state, STATE.CLAIMED);
  assert.equal(bobTrade.state, STATE.CLAIMED);

  // Confidentiality check: Eve joined the channel topic, but should not receive any payloads.
  assert.equal(seen.eve.swap.length, 0, `eve received ${seen.eve.swap.length} messages`);
});
