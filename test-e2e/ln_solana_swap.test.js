import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  mintTo,
} from '@solana/spl-token';

import {
  LN_USDT_ESCROW_PROGRAM_ID,
  claimEscrowTx,
  createEscrowTx,
  deriveEscrowPda,
  getEscrowState,
  refundEscrowTx,
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

async function retry(fn, { tries = 50, delayMs = 500, label = 'retry' } = {}) {
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

function parseHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  assert.match(hex, /^[0-9a-f]{64}$/, `${label} must be 32-byte hex`);
  return hex;
}

function hasConfirmedUtxo(listFundsResult) {
  const outs = listFundsResult?.outputs;
  if (!Array.isArray(outs)) return false;
  return outs.some((o) => String(o?.status || '').toLowerCase() === 'confirmed');
}

async function startSolanaValidator({ soPath }) {
  const ledgerPath = path.join(repoRoot, 'onchain/solana/ledger-e2e');
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

test('e2e: LN<->Solana escrow flows', async (t) => {
  // Ensure our SBF program is built.
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
  }); // 0.01 BTC-ish in sats (regtest)
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);

  await retry(async () => {
    const chans = await clnCli('cln-bob', ['listpeerchannels']);
    const c = chans.channels?.find((x) => x.peer_id === aliceNodeId);
    const st = c?.state || '';
    if (st !== 'CHANNELD_NORMAL') throw new Error(`channel state=${st}`);
    return chans;
  }, { label: 'channel active', tries: 120, delayMs: 500 });

  // Alice creates invoice (normal invoice; no hodl invoices).
  const invoice = await clnCli('cln-alice', ['invoice', '100000msat', 'swap1', 'swap test']);
  const bolt11 = invoice.bolt11;
  const paymentHashHex = parseHex32(invoice.payment_hash, 'payment_hash');

  // Start Solana local validator with our program loaded.
  const sol = await startSolanaValidator({ soPath });
  t.after(async () => {
    try {
      await sol.stop();
    } catch (_e) {}
  });

  const connection = sol.connection;
  const solAlice = Keypair.generate();
  const solBob = Keypair.generate();
  const airdropAlice = await connection.requestAirdrop(solAlice.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdropAlice, 'confirmed');
  const airdropBob = await connection.requestAirdrop(solBob.publicKey, 2_000_000_000);
  await connection.confirmTransaction(airdropBob, 'confirmed');

  await retry(async () => {
    const bal = await connection.getBalance(solAlice.publicKey, 'confirmed');
    if (bal <= 0) throw new Error('sol alice still has 0 balance');
    return bal;
  }, { label: 'sol alice airdrop' });
  await retry(async () => {
    const bal = await connection.getBalance(solBob.publicKey, 'confirmed');
    if (bal <= 0) throw new Error('sol bob still has 0 balance');
    return bal;
  }, { label: 'sol bob airdrop' });

  const mint = await createMint(connection, solAlice, solAlice.publicKey, null, 6);
  const aliceToken = await createAssociatedTokenAccount(connection, solAlice, mint, solAlice.publicKey);
  const bobToken = await createAssociatedTokenAccount(connection, solAlice, mint, solBob.publicKey);
  // Mint enough for multiple escrows across subtests.
  await mintTo(connection, solAlice, mint, aliceToken, solAlice, 200_000_000n); // 200 USDT (6 decimals)

  // Create escrow keyed to LN payment_hash.
  const now = Math.floor(Date.now() / 1000);
  const refundAfter = now + 3600;
  const { tx: escrowTx, escrowPda } = await createEscrowTx({
    connection,
    payer: solAlice,
    payerTokenAccount: aliceToken,
    mint,
    paymentHashHex,
    recipient: solBob.publicKey,
    refund: solAlice.publicKey,
    refundAfterUnix: refundAfter,
    amount: 100_000_000n,
  });
  await sendAndConfirm(connection, escrowTx);

  const state = await getEscrowState(connection, paymentHashHex);
  assert.ok(state, 'escrow state exists');
  assert.equal(state.status, 0, 'escrow is active');
  assert.equal(state.paymentHashHex, paymentHashHex);
  assert.equal(state.recipient.toBase58(), solBob.publicKey.toBase58());
  assert.equal(state.refund.toBase58(), solAlice.publicKey.toBase58());
  assert.equal(state.amount, 100_000_000n);

  // Bob pays LN invoice and obtains preimage.
  const payRes = await clnCli('cln-bob', ['pay', bolt11]);
  const preimageHex = parseHex32(payRes.payment_preimage, 'payment_preimage');

  // Bob claims escrow using LN preimage.
  const { tx: claimTx } = await claimEscrowTx({
    connection,
    recipient: solBob,
    recipientTokenAccount: bobToken,
    mint,
    paymentHashHex,
    preimageHex,
  });
  await sendAndConfirm(connection, claimTx);

  const bobAcc = await getAccount(connection, bobToken, 'confirmed');
  assert.equal(bobAcc.amount, 100_000_000n);

  const afterState = await getEscrowState(connection, paymentHashHex);
  assert.ok(afterState, 'escrow state still exists');
  assert.equal(afterState.status, 1, 'escrow claimed');
  assert.equal(afterState.amount, 0n, 'escrow drained');

  await t.test('refund path: escrow refunds after timeout', async () => {
    const invoice2 = await clnCli('cln-alice', ['invoice', '100000msat', 'swap2', 'swap refund']);
    const paymentHash2 = parseHex32(invoice2.payment_hash, 'payment_hash');

    const now2 = Math.floor(Date.now() / 1000);
    const refundAfter2 = now2 + 3;

    const { tx: escrowTx2 } = await createEscrowTx({
      connection,
      payer: solAlice,
      payerTokenAccount: aliceToken,
      mint,
      paymentHashHex: paymentHash2,
      recipient: solBob.publicKey,
      refund: solAlice.publicKey,
      refundAfterUnix: refundAfter2,
      amount: 1_000_000n,
    });
    await sendAndConfirm(connection, escrowTx2);

    // Wait for timeout and refund.
    await new Promise((r) => setTimeout(r, 4000));

    const { tx: refundTx2 } = await refundEscrowTx({
      connection,
      refund: solAlice,
      refundTokenAccount: aliceToken,
      mint,
      paymentHashHex: paymentHash2,
    });
    await sendAndConfirm(connection, refundTx2);

    const st2 = await getEscrowState(connection, paymentHash2);
    assert.ok(st2, 'escrow state exists');
    assert.equal(st2.status, 2, 'escrow refunded');
    assert.equal(st2.amount, 0n, 'escrow drained');
  });

  await t.test('negative: wrong preimage cannot claim', async () => {
    const invoice3 = await clnCli('cln-alice', ['invoice', '100000msat', 'swap3', 'swap wrong preimage']);
    const paymentHash3 = parseHex32(invoice3.payment_hash, 'payment_hash');
    const bolt113 = invoice3.bolt11;

    const now3 = Math.floor(Date.now() / 1000);
    const refundAfter3 = now3 + 3600;

    const { tx: escrowTx3 } = await createEscrowTx({
      connection,
      payer: solAlice,
      payerTokenAccount: aliceToken,
      mint,
      paymentHashHex: paymentHash3,
      recipient: solBob.publicKey,
      refund: solAlice.publicKey,
      refundAfterUnix: refundAfter3,
      amount: 1_000_000n,
    });
    await sendAndConfirm(connection, escrowTx3);

    // Bob pays invoice to obtain the real preimage, but attempts to claim with a wrong one.
    const payRes3 = await clnCli('cln-bob', ['pay', bolt113]);
    const realPreimage3 = parseHex32(payRes3.payment_preimage, 'payment_preimage');
    const wrongPreimage = crypto.randomBytes(32).toString('hex');

    const { tx: badClaimTx } = await claimEscrowTx({
      connection,
      recipient: solBob,
      recipientTokenAccount: bobToken,
      mint,
      paymentHashHex: paymentHash3,
      preimageHex: wrongPreimage,
    });

    let threw = false;
    try {
      await sendAndConfirm(connection, badClaimTx);
    } catch (_e) {
      threw = true;
    }
    assert.equal(threw, true, 'expected claim with wrong preimage to fail');

    // Clean up by claiming with the real preimage.
    const before = (await getAccount(connection, bobToken, 'confirmed')).amount;
    const { tx: goodClaimTx } = await claimEscrowTx({
      connection,
      recipient: solBob,
      recipientTokenAccount: bobToken,
      mint,
      paymentHashHex: paymentHash3,
      preimageHex: realPreimage3,
    });
    await sendAndConfirm(connection, goodClaimTx);
    const after = (await getAccount(connection, bobToken, 'confirmed')).amount;
    assert.equal(after - before, 1_000_000n);
  });

  await t.test('negative: refund too early fails', async () => {
    const invoice4 = await clnCli('cln-alice', ['invoice', '100000msat', 'swap4', 'swap early refund']);
    const paymentHash4 = parseHex32(invoice4.payment_hash, 'payment_hash');

    const now4 = Math.floor(Date.now() / 1000);
    const refundAfter4 = now4 + 3;

    const { tx: escrowTx4 } = await createEscrowTx({
      connection,
      payer: solAlice,
      payerTokenAccount: aliceToken,
      mint,
      paymentHashHex: paymentHash4,
      recipient: solBob.publicKey,
      refund: solAlice.publicKey,
      refundAfterUnix: refundAfter4,
      amount: 1_000_000n,
    });
    await sendAndConfirm(connection, escrowTx4);

    const { tx: refundTx4 } = await refundEscrowTx({
      connection,
      refund: solAlice,
      refundTokenAccount: aliceToken,
      mint,
      paymentHashHex: paymentHash4,
    });

    let threw = false;
    try {
      await sendAndConfirm(connection, refundTx4);
    } catch (_e) {
      threw = true;
    }
    assert.equal(threw, true, 'expected early refund to fail');

    // Then refund succeeds after timeout (and cleans up the escrow).
    await new Promise((r) => setTimeout(r, 4000));
    const { tx: refundTx4b } = await refundEscrowTx({
      connection,
      refund: solAlice,
      refundTokenAccount: aliceToken,
      mint,
      paymentHashHex: paymentHash4,
    });
    await sendAndConfirm(connection, refundTx4b);
    const st4 = await getEscrowState(connection, paymentHash4);
    assert.ok(st4, 'escrow state exists');
    assert.equal(st4.status, 2, 'escrow refunded');
  });
});
