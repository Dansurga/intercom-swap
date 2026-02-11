import test from 'node:test';
import assert from 'node:assert/strict';

import { TradeAutoManager } from '../src/prompt/tradeAuto.js';

const MAKER = 'a'.repeat(64);
const TAKER = 'b'.repeat(64);
const SOL_RECIPIENT = '4gRG1QE1YofRgCtTuwEDftYx9aEr9N1z5bFTJTbPNqmg';

function env(kind, tradeId, signer, body = {}) {
  return {
    v: 1,
    kind,
    trade_id: tradeId,
    ts: Date.now(),
    nonce: `${kind}-${tradeId}`.slice(0, 20),
    body,
    signer,
    sig: 'c'.repeat(128),
  };
}

test('tradeauto: settlement can start from synthetic swap context (no prior swap:* terms event)', async () => {
  const tradeId = 'swap_test_1';
  const sent = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
        trade_fee_collector: SOL_RECIPIENT,
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 4, events: [] };
      readOnce = true;
      return { latest_seq: 4, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_terms_post') {
        sent.push({ tool, args });
        return { type: 'terms_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.trade_id, tradeId);
    assert.equal(sent[0].args.channel, `swap:${tradeId}`);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: backend auto-leaves stale swap channels (expired invite)', async () => {
  const tradeId = 'swap_test_2';
  const left = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now - 10_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 1 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 1, events: [] };
      readOnce = true;
      return { latest_seq: 1, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [`swap:${tradeId}`] };
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
      hygiene_interval_ms: 1_000,
    });
    assert.deepEqual(left, [`swap:${tradeId}`]);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});
