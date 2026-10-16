import { AttachmentStore } from './attachments.js';
import { AccessControl } from './access.js';
import { isAbsolute, resolve } from 'node:path';
import { Transport } from '../daemon/transport.js';
import { DaemonAdapter } from '../daemon/adapter.js';
import { createApp } from './app.js';

const socket = process.env.CODEX_DAEMON_SOCKET;
if (!socket || !isAbsolute(socket)) throw new Error('Set CODEX_DAEMON_SOCKET to the absolute path of the selected existing daemon socket. No daemon will be started.');
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024–65535');
const transport = new Transport(socket);
const app = createApp(new DaemonAdapter(transport), port, { access: new AccessControl(resolve(process.env.POCKET_STATE_DIR ?? '.local/access')), attachments: new AttachmentStore(resolve(process.env.POCKET_ATTACHMENTS_DIR ?? '.local/attachments')), origin: process.env.PUBLIC_ORIGIN });
let stopped = false; let timer: NodeJS.Timeout | undefined; let delay = 1000; let inFlight = false;
function schedule() {
  if (!stopped && !timer && !inFlight) timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
}
async function connect() {
  inFlight = true;
  try { await transport.connect(); delay = 1000; } catch { /* Status endpoint reports unavailability; never log transcripts. */ }
  inFlight = false;
  if (transport.state !== 'connected') { schedule(); delay = Math.min(delay * 2, 30_000); }
}
transport.on('state', () => {
  if (transport.state === 'offline') schedule();
});
app.server.listen(port, '127.0.0.1', () => { console.log(`Codex Pocket: ${app.origin} (loopback backend; authenticated access)`); void connect(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopped = true; clearTimeout(timer); void app.close(); });
