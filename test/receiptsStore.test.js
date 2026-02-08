import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { TradeReceiptsStore } from '../src/receipts/store.js';

function tmpDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercomswap-receipts-'));
  return path.join(dir, `${name}.sqlite`);
}

test('receipts store: listTradesPaged supports offset', () => {
  const dbPath = tmpDbPath('paged');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('t1', { state: 'init', created_at: 1, updated_at: 100 });
    store.upsertTrade('t2', { state: 'init', created_at: 2, updated_at: 300 });
    store.upsertTrade('t3', { state: 'init', created_at: 3, updated_at: 200 });

    const all = store.listTradesPaged({ limit: 10, offset: 0 });
    assert.deepEqual(all.map((t) => t.trade_id), ['t2', 't3', 't1']);

    const page = store.listTradesPaged({ limit: 1, offset: 1 });
    assert.deepEqual(page.map((t) => t.trade_id), ['t3']);
  } finally {
    store.close();
  }
});

test('receipts store: listOpenClaims filters ln_paid with preimage', () => {
  const dbPath = tmpDbPath('claims');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('t1', { state: 'ln_paid', ln_preimage_hex: 'a'.repeat(64), updated_at: 100 });
    store.upsertTrade('t2', { state: 'ln_paid', ln_preimage_hex: null, updated_at: 200 });
    store.upsertTrade('t3', { state: 'escrow', ln_preimage_hex: 'b'.repeat(64), updated_at: 300 });

    const claims = store.listOpenClaims({ limit: 10, offset: 0, state: 'ln_paid' });
    assert.deepEqual(claims.map((t) => t.trade_id), ['t1']);
  } finally {
    store.close();
  }
});

test('receipts store: listOpenRefunds filters escrow by refund_after', () => {
  const dbPath = tmpDbPath('refunds');
  const store = TradeReceiptsStore.open({ dbPath });
  try {
    store.upsertTrade('t1', { state: 'escrow', sol_refund_after_unix: 1000, updated_at: 100 });
    store.upsertTrade('t2', { state: 'escrow', sol_refund_after_unix: 2000, updated_at: 200 });
    store.upsertTrade('t3', { state: 'ln_paid', sol_refund_after_unix: 500, updated_at: 300 });

    const refunds = store.listOpenRefunds({ nowUnix: 1500, limit: 10, offset: 0, state: 'escrow' });
    assert.deepEqual(refunds.map((t) => t.trade_id), ['t1']);
  } finally {
    store.close();
  }
});

