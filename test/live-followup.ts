/** Explicit disposable shared-daemon active-follow-up check. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
const socket = process.env.CODEX_DAEMON_SOCKET;
if (!socket || !isAbsolute(socket)) throw new Error('Select the existing daemon socket explicitly');
await mkdir('.local', { recursive: true });
const cwd = await mkdtemp(resolve('.local/followup-sandbox-'));
await writeFile(resolve(cwd, 'AGENTS.md'), '# Disposable follow-up test\nNo questions, file operations, network or delegation. Only execute sleep 15, then reply to the follow-up.\n');
const owner = new Transport(socket); const adapter = new DaemonAdapter(new Transport(socket));
let started = false, terminal: any, accepted: any;
try {
  await owner.connect(); await adapter.transport.connect();
  const { thread } = await owner.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Disposable active follow-up test. First run a native shell command sleep 15. No other tools, no questions, no file reads/writes, no network, no delegation. A follow-up arrives during that command. After sleep use its requested reply marker exactly.' });
  owner.on('notice', event => {
    if (event.params.threadId !== thread.id) return;
    if (event.method === 'item/started' && event.params.item?.type === 'commandExecution') started = true;
    if (event.method === 'turn/completed') terminal = event.params.turn;
  });
  await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run sleep 15 now; then consume the follow-up that will arrive while you work. Do not ask a question.', text_elements: [] }] }, true);
  const deadline = Date.now() + 180_000;
  while (!started && !terminal && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  if (!started || terminal) throw new Error('No active tool opportunity');
  await adapter.attach(thread.id);
  const current = await adapter.read(thread.id);
  if (current.status.type !== 'active' || !current.latestTurn?.id) throw new Error('Scratch thread not active');
  accepted = await adapter.send(thread.id, '  Follow-up: reply exactly FOLLOWUP_OK.  ', `followup-live-${Date.now()}`, [], undefined, current.latestTurn.id);
  if (accepted.state !== 'accepted' || accepted.turnId !== current.latestTurn.id) throw new Error('Follow-up not accepted on expected turn');
  console.log('PASS live follow-up accepted on active turn without a question');
  while (!terminal && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  if (terminal?.status !== 'completed') throw new Error('Scratch turn did not complete');
  const page = await adapter.history(thread.id);
  if (!page.data.some(e => e.item.type === 'userMessage' && e.item.clientId === accepted.id && e.item.content?.some(c => c.text === '  Follow-up: reply exactly FOLLOWUP_OK.  '))) throw new Error('Exact follow-up correlation missing');
  if (!page.data.some(e => e.item.type === 'agentMessage' && e.item.text?.trim() === 'FOLLOWUP_OK')) throw new Error('Model did not consume follow-up');
  console.log('PASS live exact follow-up consumed and same turn completed');
} finally { owner.close(); adapter.close(); }
