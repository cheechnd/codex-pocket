import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { Entry } from '../src/daemon/types.js';
export async function mockDaemon() {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-test-')); const socket = join(dir, 'daemon.sock');
  const http = createServer(); const wss = new WebSocketServer({ server: http });
  const calls: any[] = [], replies: any[] = [];
  let entries: Entry[] = [{ turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>  exact\ntext' }] } }, { turnId: 'turn-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'Hello from the desktop' } }];
  let hold = false, incompatible = false, status = 'idle';
  let loadedIds = ['thread-1', 'thread-2'];
  let turnMode: 'normal' | 'hold' | 'timeout' | 'disconnect' | 'reject' = 'normal';
  let threadStartMode: 'normal' | 'malformed' | 'reject' | 'timeout' | 'disconnect' = 'normal';
  let resumeMode: 'normal' | 'timeout' | 'disconnect' | 'timeout-accepted' | 'disconnect-accepted' = 'normal';
  let turnCount = 0;
  let sessionCount = 0;
  const metadata = new Map<string, Record<string, unknown>>();
  let savedRecords: any[] = [
    { id: 'thread-1', name: 'Scratch conversation', cwd: '/scratch', preview: 'Hello', updatedAt: 1, recencyAt: 1, status: { type: 'idle' } },
    { id: 'thread-2', name: 'Other conversation', cwd: '/scratch', preview: 'Other', updatedAt: 1, recencyAt: 2, status: { type: 'idle' } },
  ];
  wss.on('connection', ws => ws.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if ('result' in msg || 'error' in msg) { replies.push(msg); return; }
    calls.push(msg);
    if (msg.method === 'thread/resume' && resumeMode !== 'normal') {
      if (resumeMode.endsWith('-accepted') && !loadedIds.includes(msg.params.threadId)) loadedIds.push(msg.params.threadId);
      if (resumeMode.startsWith('disconnect')) ws.close();
      return;
    }
    if (msg.id === undefined || hold) return;
    if (msg.method === 'thread/start') {
      if (threadStartMode === 'reject') { ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Cannot create thread' } })); return; }
      const id = `new-thread-${++sessionCount}`;
      loadedIds.push(id);
      const thread = { id, name: null, cwd: msg.params.cwd, preview: undefined, updatedAt: 2, recencyAt: 2, status: { type: 'idle' } };
      savedRecords.push(thread);
      if (threadStartMode === 'disconnect') { ws.close(); return; }
      if (threadStartMode === 'timeout') return;
      ws.send(JSON.stringify({ id: msg.id, result: { thread: threadStartMode === 'malformed' ? { id } : thread } }));
      return;
    }
    if (msg.method === 'turn/steer') {
      if (turnMode === 'reject' || status !== 'active' || msg.params.expectedTurnId !== `sent-${turnCount}`) { ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Active turn changed' } })); return; }
      const turnId = msg.params.expectedTurnId;
      entries.push({ turnId, item: { id: `reply-${msg.params.clientUserMessageId}`, clientId: msg.params.clientUserMessageId, type: 'userMessage', content: msg.params.input } });
      if (turnMode !== 'timeout' && turnMode !== 'disconnect') ws.send(JSON.stringify({ id: msg.id, result: { turnId } }));
      if (turnMode === 'disconnect') ws.close();
      return;
    }
    if (msg.method === 'turn/start') {
      if (turnMode === 'reject') { ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Competing turn is active' } })); return; }
      const turnId = `sent-${++turnCount}`; status = 'active';
      entries.push({ turnId, item: { id: `user-${turnId}`, clientId: msg.params.clientUserMessageId, type: 'userMessage', content: msg.params.input } });
      ws.send(JSON.stringify({ method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: turnId, status: 'inProgress' } } }));
      if (!['timeout', 'disconnect'].includes(turnMode)) ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } }));
      if (turnMode !== 'hold') {
        status = 'idle'; entries.push({ turnId, item: { id: `assistant-${turnId}`, type: 'agentMessage', text: 'Mock reply' } });
        ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: turnId, status: 'completed' } } }));
      }
      if (turnMode === 'disconnect') ws.close();
      return;
    }
    const result = msg.method === 'initialize' ? { userAgent: 'codex/0.163.0' }
      : msg.method === 'thread/loaded/list' ? { data: loadedIds, nextCursor: null }
      : msg.method === 'thread/list' ? (() => { const term = msg.params.searchTerm?.toLowerCase(); const records = savedRecords.filter(record => !term || String(record.name ?? '').toLowerCase().includes(term)); const start = msg.params.cursor ? Number(msg.params.cursor) : 0; const data = records.slice(start, start + (msg.params.limit ?? 50)); return { data, nextCursor: start + data.length < records.length ? String(start + data.length) : null }; })()
      : msg.method === 'thread/read' ? { thread: { ...(savedRecords.find(record => record.id === msg.params.threadId) ?? { id: msg.params.threadId, name: msg.params.threadId === 'thread-2' ? 'Other conversation' : 'Scratch conversation', cwd: '/scratch', updatedAt: 1, status: { type: status } }), status: { type: status }, ...metadata.get(msg.params.threadId) } }
      : msg.method === 'thread/resume' ? (() => { if (!loadedIds.includes(msg.params.threadId)) loadedIds.push(msg.params.threadId); return { thread: savedRecords.find(record => record.id === msg.params.threadId) ?? { id: msg.params.threadId, name: 'Resumed conversation', cwd: '/scratch', preview: 'Resumed', updatedAt: 1, status: { type: status } } }; })()
      : msg.method === 'thread/turns/list' ? { data: [{ id: `sent-${turnCount}`, status: status === 'idle' ? 'completed' : 'inProgress' }], nextCursor: null }
      : msg.method === 'thread/items/list' ? { data: msg.params.threadId === 'thread-2' ? [] : msg.params.cursor ? [{ turnId: 'older-turn', item: { id: 'old', type: 'agentMessage', text: 'Earlier history' } }] : [...entries].reverse(), nextCursor: msg.params.cursor ? null : 'older' }
      : { ok: true };
    ws.send(JSON.stringify(incompatible || msg.method === 'bad' ? { id: msg.id, error: { code: -32601, message: 'Unsupported method' } } : { id: msg.id, result }));
  }));
  await new Promise<void>(resolve => http.listen(socket, resolve));
  return { directory: dir, socket, calls, replies, clients: wss.clients,
    metadata: (id: string, value: Record<string, unknown>) => { metadata.set(id, value); },
    saved: (records: Record<string, unknown>[]) => { savedRecords = records; },
    loaded: (ids: string[]) => { loadedIds = [...ids]; },
    status: (value: string) => { status = value; },
    turnMode: (value: typeof turnMode) => { turnMode = value; },
    threadStartMode: (value: typeof threadStartMode) => { threadStartMode = value; },
    resumeMode: (value: typeof resumeMode) => { resumeMode = value; },
    hold: (value: boolean) => { hold = value; }, incompatible: () => { incompatible = true; },
    entries: (value: Entry[]) => { entries = value; },
    notice: (value: object) => { for (const ws of wss.clients) ws.send(JSON.stringify(value)); },
    disconnect: () => { for (const ws of wss.clients) ws.terminate(); },
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => http.close(() => resolve()))); await rm(dir, { recursive: true, force: true }); }
  };
}
