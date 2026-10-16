import { AttachmentStore } from '../src/server/attachments.js';
import { AccessControl } from '../src/server/access.js';
import { mockDaemon } from './mock.js';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { createApp } from '../src/server/app.js';
const mock = await mockDaemon(); const adapter = new DaemonAdapter(new Transport(mock.socket, 250)); await adapter.transport.connect();
let access = new AccessControl(`${mock.directory}/access`);
let code = access.pairingCode();
const app = createApp(adapter, 44318, { access: { authenticate: (...args: Parameters<AccessControl['authenticate']>) => access.authenticate(...args), pair: (...args: Parameters<AccessControl['pair']>) => access.pair(...args), logout: (...args: Parameters<AccessControl['logout']>) => access.logout(...args), isValid: (id: string | undefined) => access.isValid(id) } as AccessControl, attachments: new AttachmentStore(`${mock.directory}/attachments`), webRoot: new URL('../dist/src/web/', import.meta.url) });
// Separate test-only control port, never included in production server.
import { createServer } from 'node:http';
const control = createServer((req, res) => {
  if (req.url === '/picker-fixture') { mock.metadata('thread-1', { name: null, preview: '', updatedAt: 9999, recencyAt: 9999 }); mock.metadata('thread-2', { name: null, preview: 'Real unnamed conversation', updatedAt: 999, recencyAt: 10 }); res.end('ok'); return; }
  if (req.url === '/launch') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><a href="http://127.0.0.1:44318/">Open Pocket</a>'); return; }
  if (req.url === '/timeout') { mock.turnMode('timeout'); res.end('ok'); return; }
  if (req.url === '/normal') { mock.turnMode('normal'); res.end('ok'); return; }
  if (req.url === '/forget-items') { mock.entries([]); res.end('ok'); return; }
  if (req.url === '/counts') { res.end(JSON.stringify({ sends: mock.calls.filter(c => c.method === 'turn/start').length })); return; }
  if (req.url === '/code') {
    // Each test starts a fresh attempt window; production rate limits stay unchanged.
    access = new AccessControl(`${mock.directory}/access`);
    code = access.pairingCode(); res.end(code); return; }
  if (req.url === '/change') {
    mock.entries([{ turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>  exact\ntext' }] } }, { turnId: 'turn-1', item: { id: 'assistant-1', type: 'agentMessage', text: 'Live desktop update' } }]);
    mock.notice({ method: 'item/completed', params: { threadId: 'thread-1' } });
  }
  res.end('ok');
});
control.listen(44319, '127.0.0.1'); app.server.listen(44318, '127.0.0.1');
process.once('SIGTERM', () => { control.close(); void app.close().then(() => mock.close()); });
