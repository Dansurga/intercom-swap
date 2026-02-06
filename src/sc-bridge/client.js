import { EventEmitter } from 'node:events';

export class ScBridgeClient extends EventEmitter {
  constructor({ url, token }) {
    super();
    this.url = url;
    this.token = token || null;
    this.ws = null;
    this.hello = null;
    this._pending = new Map();
    this._nextId = 1;
  }

  async connect({ timeoutMs = 10_000 } = {}) {
    if (this.ws) throw new Error('Already connected');

    const ws = new WebSocket(this.url);
    this.ws = ws;

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SC-Bridge connect timeout')), timeoutMs);
      ws.onopen = () => {};
      ws.onerror = (evt) => {
        clearTimeout(timer);
        reject(new Error(evt?.message || 'SC-Bridge socket error'));
      };
      ws.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(String(evt.data || ''));
        } catch (_e) {
          return;
        }
        this._handleMessage(msg);
        if (msg.type === 'hello') {
          this.hello = msg;
          if (msg.requiresAuth && this.token) {
            ws.send(JSON.stringify({ type: 'auth', token: this.token }));
          } else if (msg.requiresAuth && !this.token) {
            clearTimeout(timer);
            reject(new Error('SC-Bridge requires auth but no token provided'));
          } else {
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        if (msg.type === 'auth_ok') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (msg.type === 'error' && msg.error === 'Unauthorized.') {
          clearTimeout(timer);
          reject(new Error('SC-Bridge unauthorized'));
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error('SC-Bridge closed before ready'));
      };
    });

    await ready;
  }

  close() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch (_e) {}
    this.ws = null;
  }

  _rpc(type, payload) {
    if (!this.ws) throw new Error('Not connected');
    const id = this._nextId++;
    const msg = { id, type, ...payload };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      // Rely on caller timeouts for now.
    });
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = msg.id;
    if (id && this._pending.has(id)) {
      const pending = this._pending.get(id);
      this._pending.delete(id);
      pending.resolve(msg);
      return;
    }
    if (msg.type === 'sidechannel_message') {
      this.emit('sidechannel_message', msg);
      return;
    }
    this.emit('event', msg);
  }

  async join(channel, { invite = null, welcome = null } = {}) {
    return this._rpc('join', { channel, invite, welcome });
  }

  async open(channel, { via = null, invite = null, welcome = null } = {}) {
    return this._rpc('open', { channel, via, invite, welcome });
  }

  async send(channel, message, { invite = null, welcome = null } = {}) {
    return this._rpc('send', { channel, message, invite, welcome });
  }

  async subscribe(channels) {
    const list = Array.isArray(channels) ? channels : [channels];
    return this._rpc('subscribe', { channels: list });
  }

  async stats() {
    return this._rpc('stats', {});
  }

  async info() {
    return this._rpc('info', {});
  }

  async sign(payload) {
    return this._rpc('sign', { payload });
  }
}
