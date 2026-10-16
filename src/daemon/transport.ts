import WebSocket from 'ws';
import { realpath, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PocketError, type Notice } from './types.js';

interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; write: boolean }
/** One owned connection. Never starts a daemon or reads authentication files. */
export class Transport extends EventEmitter {
  private ws?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private generation = 0;
  private connecting?: Promise<void>;
  state: 'offline' | 'connecting' | 'connected' | 'incompatible' = 'offline';
  version?: string;
  constructor(readonly socketPath: string, readonly timeoutMs = 15_000) { super(); }
  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    return this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
  }
  private async open() {
    this.state = 'connecting'; this.emit('state');
    const generation = ++this.generation;
    try {
      const socket = await realpath(this.socketPath);
      if (!(await stat(socket)).isSocket()) throw new PocketError('endpoint', 'Selected endpoint is not a Unix socket');
      const ws = this.ws = new WebSocket(`ws+unix://${socket}:/`, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: this.timeoutMs });
      ws.on('message', data => {
        if (generation !== this.generation) return;
        try {
          const msg = JSON.parse(data.toString());
          if (!msg || typeof msg !== 'object') throw new Error();
          if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            clearTimeout(p.timer); this.pending.delete(msg.id);
            msg.error ? p.reject(new PocketError('rpc', String(msg.error.message ?? 'Daemon rejected request'))) : p.resolve(msg.result);
          } else if (typeof msg.method === 'string') {
            // Do not answer/decline requests: a reply could resolve another client's approval.
            this.emit('notice', { method: msg.method, params: msg.params ?? {}, ...(msg.id !== undefined ? { requestId: msg.id } : {}) } satisfies Notice);
          } else throw new Error();
        } catch { ws.close(1002, 'Invalid protocol message'); }
      });
      ws.on('close', () => { if (generation === this.generation) this.disconnected(); });
      ws.on('error', () => { if (generation === this.generation) this.disconnected(); });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('Daemon closed during handshake'))); });
      const info = await this.request('initialize', { clientInfo: { name: 'codex_pocket', title: 'Codex Pocket', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.version = String(info.userAgent ?? info.version ?? 'unknown');
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
      // Capability probe is read-only; actual history support is checked on selection.
      const loaded = await this.request('thread/loaded/list', { limit: 100 });
      if (!Array.isArray(loaded.data) || loaded.data.some((id: unknown) => typeof id !== 'string')) throw new PocketError('incompatible', 'Invalid loaded-thread response');
      this.state = 'connected'; this.emit('state');
    } catch (error) {
      this.ws?.terminate(); this.disconnected();
      if (error instanceof PocketError && ['rpc', 'incompatible'].includes(error.code)) this.state = 'incompatible';
      this.emit('state'); throw error;
    }
  }
  request<T = any>(method: string, params: object = {}, write = false): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new PocketError('offline', 'Daemon unavailable; start Codex normally on the computer'));
    if (this.pending.size >= 32) return Promise.reject(new PocketError('capacity', 'Too many pending daemon requests'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PocketError(write ? 'outcome-unknown' : 'timeout', write ? 'Write outcome unknown; do not retry' : 'Daemon request timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, write });
      const body = JSON.stringify({ id, method, params });
      if (Buffer.byteLength(body) > 128 * 1024) {
        clearTimeout(timer); this.pending.delete(id); reject(new PocketError('size', 'Request exceeds limit')); return;
      }
      ws.send(body, error => {
        if (error) { const p = this.pending.get(id); if (p) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new PocketError(write ? 'outcome-unknown' : 'offline', 'Daemon write failed')); } }
      });
    });
  }
  private disconnected() {
    this.state = 'offline';
    for (const p of this.pending.values()) {
      clearTimeout(p.timer); p.reject(new PocketError(p.write ? 'outcome-unknown' : 'offline', p.write ? 'Write outcome unknown; do not retry' : 'Daemon disconnected'));
    }
    this.pending.clear(); this.emit('state');
  }
  close() { ++this.generation; this.ws?.terminate(); this.disconnected(); }
}
