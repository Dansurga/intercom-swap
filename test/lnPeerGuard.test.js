import test from 'node:test';
import assert from 'node:assert/strict';

import { ACINQ_PEER_URI, LnPeerGuard, lnPeerProbe, parsePeerUri } from '../src/prompt/lnPeerGuard.js';

function mkPeers({ connected = false } = {}) {
  if (!connected) return { peers: [] };
  const { nodeId, addr } = parsePeerUri(ACINQ_PEER_URI);
  return {
    peers: [
      {
        pub_key: nodeId,
        connected: true,
        netaddr: [addr],
      },
    ],
  };
}

test('parsePeerUri: parses nodeid@host:port', () => {
  const r = parsePeerUri(ACINQ_PEER_URI);
  assert.equal(r.nodeId.length, 66);
  assert.equal(r.addr.includes(':'), true);
  assert.equal(Number.isInteger(r.port), true);
});

test('lnPeerProbe: connected peer does not attempt reconnect', async () => {
  const probe = await lnPeerProbe({
    peerUri: ACINQ_PEER_URI,
    connect: true,
    tcpTimeoutMs: 10,
    probeTcp: async () => ({ ok: true, rtt_ms: 1, error: null }),
    listPeers: async () => mkPeers({ connected: true }),
    connectPeer: async () => {
      throw new Error('connect should not be called when already connected');
    },
  });
  assert.equal(probe.type, 'ln_peer_probe');
  assert.equal(Boolean(probe?.tcp?.ok), true);
  assert.equal(Boolean(probe?.ln?.connected), true);
  assert.equal(Boolean(probe?.ln?.connect_attempted), false);
});

test('lnPeerProbe: disconnected + tcp ok attempts reconnect', async () => {
  let connectCalls = 0;
  let listCalls = 0;
  const probe = await lnPeerProbe({
    peerUri: ACINQ_PEER_URI,
    connect: true,
    tcpTimeoutMs: 10,
    probeTcp: async () => ({ ok: true, rtt_ms: 1, error: null }),
    listPeers: async () => {
      listCalls += 1;
      if (listCalls === 1) return mkPeers({ connected: false });
      return mkPeers({ connected: true });
    },
    connectPeer: async () => {
      connectCalls += 1;
      return {};
    },
  });
  assert.equal(Boolean(probe?.ln?.connect_attempted), true);
  assert.equal(connectCalls, 1);
  assert.equal(Boolean(probe?.ln?.connected_after), true);
});

test('lnPeerProbe: tcp fail suppresses reconnect', async () => {
  let connectCalls = 0;
  const probe = await lnPeerProbe({
    peerUri: ACINQ_PEER_URI,
    connect: true,
    tcpTimeoutMs: 10,
    probeTcp: async () => ({ ok: false, rtt_ms: null, error: 'timeout' }),
    listPeers: async () => mkPeers({ connected: false }),
    connectPeer: async () => {
      connectCalls += 1;
      return {};
    },
  });
  assert.equal(Boolean(probe?.tcp?.ok), false);
  assert.equal(Boolean(probe?.ln?.connect_attempted), false);
  assert.equal(connectCalls, 0);
});

test('LnPeerGuard: just-disconnected triggers immediate reconnect attempt', async () => {
  let listCalls = 0;
  let connectCalls = 0;
  const guard = new LnPeerGuard({
    peerUri: ACINQ_PEER_URI,
    intervalMs: 10_000,
    reconnectCooldownMs: 60_000,
    tcpTimeoutMs: 10,
    probeTcp: async () => ({ ok: true, rtt_ms: 1, error: null }),
    listPeers: async () => {
      listCalls += 1;
      if (listCalls === 1) return mkPeers({ connected: true });
      if (listCalls === 2) return mkPeers({ connected: false }); // tick sees disconnect
      if (listCalls === 3) return mkPeers({ connected: false }); // probe pre-connect listpeers
      return mkPeers({ connected: true }); // probe after connect
    },
    connectPeer: async () => {
      connectCalls += 1;
      return {};
    },
  });

  const a = await guard.tick();
  assert.equal(a.type, 'ln_peer_guard_ok');
  assert.equal(connectCalls, 0);

  const b = await guard.tick();
  assert.equal(b.type, 'ln_peer_guard_reconnected');
  assert.equal(connectCalls, 1);
});
