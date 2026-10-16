import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Standalone dependency: no imports from OpenClaw or its checkout.
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
export const defaultSocket = path.join(homedir(), '.codex/app-server-control/app-server-control.sock');

export class Client {
  constructor(socketPath = defaultSocket, name = 'openclaw_daemon_poc') {
    this.socketPath = socketPath;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
  }
  async connect() {
    // Do not launch a server, read credentials, or change daemon settings.
    const resolved = fs.realpathSync(this.socketPath);
    if (!fs.statSync(resolved).isSocket()) throw new Error('Endpoint is not a Unix socket');
    this.ws = new WebSocket(`ws+unix://${resolved}:/`, { handshakeTimeout: 10000 });
    this.ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
        }
      } else if (msg.id !== undefined) {
        // This tiny prototype never grants approvals or answers user-input requests.
        this.ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'PoC does not handle interactive requests; use the CLI' } }));
      } else {
        this.events.push(msg);
        if (this.events.length > 2000) this.events.shift();
        for (const fn of this.listeners) fn(msg);
      }
    });
    this.ws.on('close', () => this.failPending(new Error('Daemon connection closed')));
    this.ws.on('error', error => this.failPending(error));
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    const info = await this.request('initialize', {
      clientInfo: { name: this.name, title: 'Shared daemon feasibility PoC', version: '0.1.0' },
    });
    this.ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return info;
  }
  failPending(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  request(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; write outcome may be unknown—do not blindly retry`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async loaded() { return (await this.request('thread/loaded/list')).data; }
  async attach(threadId) {
    if (!(await this.loaded()).includes(threadId)) throw new Error('Refusing to resume an unloaded conversation; select an already-loaded daemon thread');
    return this.request('thread/resume', { threadId });
  }
  async send(threadId, text) {
    const { thread } = await this.request('thread/read', { threadId });
    if (thread.status?.type === 'active') throw new Error('Conversation is active; refusing to queue or interrupt work');
    return this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  }
  waitFor(predicate, timeoutMs = 60000, from = 0) {
    const previous = this.events.slice(from).find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const done = msg => { if (predicate(msg)) { clearTimeout(timer); this.listeners.delete(done); resolve(msg); } };
      const timer = setTimeout(() => { this.listeners.delete(done); reject(new Error('Event wait timed out')); }, timeoutMs);
      this.listeners.add(done);
    });
  }
  async close() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.ws.terminate(); resolve(); }, 1500);
      this.ws.once('close', () => { clearTimeout(timer); resolve(); });
      this.ws.close();
    });
  }
}

async function main() {
  const [command = 'loaded', threadId, ...words] = process.argv.slice(2);
  if (!['loaded', 'watch', 'send'].includes(command) || (command !== 'loaded' && !threadId) || (command === 'send' && !words.length)) {
    throw new Error('Usage: node client.mjs loaded | watch THREAD_ID | send THREAD_ID MESSAGE');
  }
  const client = new Client(process.env.CODEX_DAEMON_SOCKET || defaultSocket);
  try {
    const info = await client.connect();
    console.error(JSON.stringify({ connected: true, socket: fs.realpathSync(client.socketPath), server: info }));
    if (command === 'loaded') {
      for (const id of await client.loaded()) {
        const { thread } = await client.request('thread/read', { threadId: id });
        console.log(JSON.stringify({ id, name: thread.name, cwd: thread.cwd, status: thread.status }));
      }
      return;
    }
    await client.attach(threadId);
    client.listeners.add(msg => {
      if (msg.params?.threadId === threadId) console.log(JSON.stringify(msg));
    });
    if (command === 'watch') {
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    } else {
      const from = client.events.length;
      const result = await client.send(threadId, words.join(' '));
      console.error(JSON.stringify({ submitted: result.turn.id }));
      const completed = await client.waitFor(msg => msg.method === 'turn/completed' && msg.params?.turn?.id === result.turn.id, 120000, from);
      if (completed.params.turn.status !== 'completed') throw new Error(JSON.stringify(completed.params.turn));
    }
  } finally { await client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
