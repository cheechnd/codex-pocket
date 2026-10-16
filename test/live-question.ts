/** Explicit disposable same-daemon question/steer integration; never uses work threads. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
const socket = process.env.CODEX_DAEMON_SOCKET;
if (!socket || !isAbsolute(socket)) throw new Error('Select the existing daemon socket explicitly');
await mkdir('.local', { recursive: true });
const cwd = await mkdtemp(resolve('.local/question-sandbox-'));
await writeFile(resolve(cwd, 'AGENTS.md'), '# Disposable question test\nOnly ask the requested async question and run sleep if needed. No other tools, file changes or delegation.\n');
const owner = new Transport(socket); const adapter = new DaemonAdapter(new Transport(socket));
let questionSeen = false, terminal: any, reply: any;
try {
  await owner.connect(); await adapter.transport.connect();
  const { thread } = await owner.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Disposable question test. Call request_user_input_async once asking Which test color? with Blue and Green options. Continue independent work using one shell command sleep 20 to keep this turn open while the test client sends an answer. Do not access files, network, or delegate. After the sleep, consume the user answer and reply exactly QUESTION_REPLY_OK_BLUE if it chose Blue. Never ask a blocking question.' });
  owner.on('notice', event => {
    if (event.params.threadId !== thread.id) return;
    if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage' && event.params.item.delivery === 'async') questionSeen = true;
    if (event.method === 'turn/completed') terminal = event.params.turn;
  });
  await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Perform the disposable async question check now. Ask Which test color? via request_user_input_async, continue with sleep 20, and consume the later answer.', text_elements: [] }] }, true);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !reply && !terminal) {
    if (questionSeen) {
      const page = await adapter.history(thread.id);
      if (page.question && page.thread.status.type === 'active') {
        reply = await adapter.send(thread.id, 'Blue', `question-live-${Date.now()}`, [], page.question);
        if (reply.state !== 'accepted') throw new Error(`Question reply not accepted: ${reply.state}`);
        console.log('PASS live async question recognized and exact-turn reply accepted');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!reply) throw new Error('No active async question reply opportunity');
  while (Date.now() < deadline && !terminal) await new Promise(resolve => setTimeout(resolve, 250));
  if (terminal?.status !== 'completed') throw new Error('Scratch question turn did not complete');
  const page = await adapter.history(thread.id);
  if (!page.data.some(e => e.item.type === 'userMessage' && e.item.clientId === reply.id && e.item.content?.some(c => c.type === 'text' && c.text === 'Blue'))) throw new Error('Question answer missing client-ID correlation');
  if (!page.data.some(e => e.item.type === 'agentMessage' && e.item.text?.includes('QUESTION_REPLY_OK_BLUE'))) throw new Error('Scratch model did not consume answer');
  if (page.question) throw new Error('Answered question still pending');
  console.log('PASS live answer consumed, same turn completed, pending question cleared');
} finally { owner.close(); adapter.close(); }
