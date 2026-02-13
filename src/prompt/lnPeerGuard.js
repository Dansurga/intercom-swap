import net from 'node:net';

export const ACINQ_NODE_ID = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
export const ACINQ_PEER_ADDR = '3.33.236.230:9735';
export const ACINQ_PEER_URI = `${ACINQ_NODE_ID}@${ACINQ_PEER_ADDR}`;

export function parsePeerUri(peerRaw) {
  const peer = String(peerRaw || '').trim();
  if (!peer) throw new Error('peer URI is required');
  const at = peer.indexOf('@');
  if (at < 1) throw new Error('peer URI must be nodeid@host:port');
  const nodeId = peer.slice(0, at).trim().toLowerCase();
  if (!/^[0-9a-f]{66}$/i.test(nodeId)) throw new Error('peer URI nodeid must be 33-byte hex (66 chars)');
  const addr = peer.slice(at + 1).trim();
  if (!addr) throw new Error('peer URI missing host:port');

  let host = '';
  let port = 0;
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    if (end < 0) throw new Error('peer URI ipv6 address missing closing ]');
    host = addr.slice(1, end).trim();
    const rest = addr.slice(end + 1).trim();
    if (!rest.startsWith(':')) throw new Error('peer URI ipv6 address must include :port');
    port = Number.parseInt(rest.slice(1).trim(), 10);
  } else {
    const idx = addr.lastIndexOf(':');
    if (idx < 1) throw new Error('peer URI must include host:port');
    host = addr.slice(0, idx).trim();
    port = Number.parseInt(addr.slice(idx + 1).trim(), 10);
  }

  if (!host) throw new Error('peer URI host is empty');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('peer URI port is invalid');

  return { nodeId, addr, host, port };
}

export function extractLnConnectedPeerIds(listPeers) {
  const out = [];
  const seen = new Set();
  const rows = Array.isArray(listPeers?.peers) ? listPeers.peers : [];
  for (const row of rows) {
    const id = String(row?.id || row?.pub_key || row?.pubKey || '').trim().toLowerCase();
    if (!/^[0-9a-f]{66}$/i.test(id)) continue;
    const connectedRaw = row?.connected;
    const connected =
      connectedRaw === undefined || connectedRaw === null
        ? true
        : connectedRaw === true || Number(connectedRaw) === 1 || String(connectedRaw).toLowerCase() === 'true';
    if (!connected) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function tcpProbe({ host, port, timeoutMs = 800 } = {}) {
  const h = String(host || '').trim();
  const p = Number(port);
  const t = Number.isFinite(timeoutMs) ? Math.max(50, Math.trunc(timeoutMs)) : 800;
  if (!h) throw new Error('tcpProbe: host is required');
  if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('tcpProbe: port is invalid');

  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const sock = net.connect({ host: h, port: p });
    const done = (ok, err) => {
      try {
        sock.destroy();
      } catch (_e) {}
      resolve({
        ok: Boolean(ok),
        rtt_ms: ok ? Math.max(0, Date.now() - startedAt) : null,
        error: ok ? null : String(err || 'tcp probe failed'),
      });
    };
    sock.setTimeout(t, () => done(false, 'timeout'));
    sock.once('connect', () => done(true, null));
    sock.once('error', (e) => done(false, e?.message || String(e)));
  });
}

function isAlreadyConnectedMsg(msgRaw) {
  const msg = String(msgRaw || '').trim().toLowerCase();
  if (!msg) return false;
  return msg.includes('already connected') || msg.includes('already connected to peer');
}

export async function lnPeerProbe({
  peerUri,
  connect = true,
  tcpTimeoutMs = 800,
  listPeers,
  connectPeer,
  probeTcp = tcpProbe,
} = {}) {
  const startedAt = Date.now();
  const peer = String(peerUri || '').trim();
  if (!peer) throw new Error('lnPeerProbe: peerUri is required');
  if (typeof listPeers !== 'function') throw new Error('lnPeerProbe: listPeers is required');

  const parts = parsePeerUri(peer);
  const out = {
    type: 'ln_peer_probe',
    ts: startedAt,
    peer,
    node_id: parts.nodeId,
    host: parts.host,
    port: parts.port,
    tcp: null,
    ln: {
      connected: false,
      listpeers_error: null,
      connect_attempted: false,
      connect_ok: null,
      connect_error: null,
      listpeers_after_error: null,
      connected_after: null,
    },
    duration_ms: null,
  };

  try {
    out.tcp = await probeTcp({ host: parts.host, port: parts.port, timeoutMs: tcpTimeoutMs });
  } catch (e) {
    out.tcp = { ok: false, rtt_ms: null, error: e?.message || String(e) };
  }

  let peers = null;
  try {
    peers = await listPeers();
  } catch (e) {
    out.ln.listpeers_error = e?.message || String(e);
  }
  if (peers) {
    const ids = extractLnConnectedPeerIds(peers);
    out.ln.connected = ids.includes(parts.nodeId);
  }

  const canConnect = Boolean(connect) && typeof connectPeer === 'function' && Boolean(out.tcp?.ok);
  if (!out.ln.connected && canConnect) {
    out.ln.connect_attempted = true;
    try {
      await connectPeer(peer);
      out.ln.connect_ok = true;
    } catch (e) {
      const msg = e?.message || String(e);
      if (isAlreadyConnectedMsg(msg)) {
        out.ln.connect_ok = true;
      } else {
        out.ln.connect_ok = false;
        out.ln.connect_error = msg;
      }
    }

    try {
      const after = await listPeers();
      const idsAfter = extractLnConnectedPeerIds(after);
      out.ln.connected_after = idsAfter.includes(parts.nodeId);
    } catch (e) {
      out.ln.listpeers_after_error = e?.message || String(e);
    }
  }

  out.duration_ms = Date.now() - startedAt;
  return out;
}

export class LnPeerGuard {
  constructor({
    peerUri = ACINQ_PEER_URI,
    listPeers,
    connectPeer,
    probeTcp = tcpProbe,
    intervalMs = 15_000,
    reconnectCooldownMs = 45_000,
    tcpTimeoutMs = 800,
    logger = null,
  } = {}) {
    if (typeof listPeers !== 'function') throw new Error('LnPeerGuard: listPeers is required');
    if (typeof connectPeer !== 'function') throw new Error('LnPeerGuard: connectPeer is required');
    this._peerUri = String(peerUri || '').trim();
    this._listPeers = listPeers;
    this._connectPeer = connectPeer;
    this._probeTcp = probeTcp;
    this._intervalMs = Math.max(1000, Math.trunc(Number(intervalMs) || 15_000));
    this._cooldownMs = Math.max(1000, Math.trunc(Number(reconnectCooldownMs) || 45_000));
    this._tcpTimeoutMs = Math.max(50, Math.trunc(Number(tcpTimeoutMs) || 800));
    this._log = typeof logger === 'function' ? logger : null;

    this._timer = null;
    this._busy = false;
    this._running = false;

    this._wasConnected = false;
    this._lastConnectAttemptAt = 0;
    this._lastTickAt = null;
    this._lastProbe = null;

    this._stats = {
      ticks: 0,
      reconnect_attempts: 0,
      reconnect_ok: 0,
      reconnect_fail: 0,
      last_error: '',
      last_ok_at: null,
    };
  }

  status() {
    return {
      type: 'ln_peer_guard_status',
      running: Boolean(this._running),
      peer: this._peerUri,
      interval_ms: this._intervalMs,
      reconnect_cooldown_ms: this._cooldownMs,
      tcp_timeout_ms: this._tcpTimeoutMs,
      last_tick_at: this._lastTickAt,
      last_probe: this._lastProbe,
      stats: { ...this._stats },
    };
  }

  start() {
    if (this._running) return this.status();
    this._running = true;
    const run = () => void this.tick().catch(() => {});
    run();
    this._timer = setInterval(run, this._intervalMs);
    return this.status();
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this.status();
  }

  async tick({ force = false } = {}) {
    if (this._busy) return { ...this.status(), type: 'ln_peer_guard_busy' };
    this._busy = true;
    const now = Date.now();
    this._stats.ticks += 1;
    this._lastTickAt = now;

    try {
      const parts = parsePeerUri(this._peerUri);
      const listPeers = await this._listPeers();
      const connectedIds = extractLnConnectedPeerIds(listPeers);
      const connected = connectedIds.includes(parts.nodeId);
      const justDisconnected = this._wasConnected && !connected;

      if (connected) {
        this._wasConnected = true;
        this._stats.last_ok_at = now;
        this._stats.last_error = '';
        return { ...this.status(), type: 'ln_peer_guard_ok', connected: true };
      }

      const cooldownOk = now - this._lastConnectAttemptAt >= this._cooldownMs;
      const shouldAttempt = Boolean(force) || Boolean(justDisconnected) || cooldownOk;
      if (!shouldAttempt) {
        this._wasConnected = false;
        return {
          ...this.status(),
          type: 'ln_peer_guard_cooldown',
          connected: false,
          cooldown_remaining_ms: Math.max(0, this._cooldownMs - (now - this._lastConnectAttemptAt)),
        };
      }

      this._lastConnectAttemptAt = now;
      this._stats.reconnect_attempts += 1;
      const probe = await lnPeerProbe({
        peerUri: this._peerUri,
        connect: true,
        tcpTimeoutMs: this._tcpTimeoutMs,
        listPeers: this._listPeers,
        connectPeer: this._connectPeer,
        probeTcp: this._probeTcp,
      });
      this._lastProbe = probe;

      const ok = Boolean(probe?.ln?.connected_after || probe?.ln?.connected || probe?.ln?.connect_ok);
      if (ok) {
        this._stats.reconnect_ok += 1;
        this._stats.last_ok_at = now;
        this._stats.last_error = '';
        this._wasConnected = true;
        return { ...this.status(), type: 'ln_peer_guard_reconnected', connected: true };
      }
      this._stats.reconnect_fail += 1;
      const errMsg =
        String(probe?.ln?.listpeers_error || '').trim() ||
        String(probe?.ln?.connect_error || '').trim() ||
        String(probe?.tcp?.error || '').trim() ||
        'probe failed';
      this._stats.last_error = errMsg;
      this._wasConnected = false;
      if (this._log) this._log(`[ln-peer-guard] reconnect failed: ${errMsg}`);
      return { ...this.status(), type: 'ln_peer_guard_failed', connected: false };
    } catch (e) {
      const msg = e?.message || String(e);
      this._stats.last_error = msg;
      this._wasConnected = false;
      if (this._log) this._log(`[ln-peer-guard] tick failed: ${msg}`);
      return { ...this.status(), type: 'ln_peer_guard_error', error: msg };
    } finally {
      this._busy = false;
    }
  }
}

