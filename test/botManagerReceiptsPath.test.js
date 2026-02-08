import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { defaultRfqbotReceiptsDbPath } from '../src/rfq/botManager.js';

test('defaultRfqbotReceiptsDbPath is per-bot (store + name) under onchain/receipts/rfq-bots/', () => {
  const repoRoot = path.resolve('/tmp', 'intercomswap-test');
  const out = defaultRfqbotReceiptsDbPath({ repoRoot, store: 'swap-maker', name: 'maker-1' });
  assert.equal(out, path.join(repoRoot, 'onchain', 'receipts', 'rfq-bots', 'swap-maker', 'maker-1.sqlite'));
});

test('defaultRfqbotReceiptsDbPath throws on unsafe store ids (path traversal guard)', () => {
  const repoRoot = path.resolve('/tmp', 'intercomswap-test');
  assert.throws(() => defaultRfqbotReceiptsDbPath({ repoRoot, store: '../evil', name: 'bot' }), /store/);
});

