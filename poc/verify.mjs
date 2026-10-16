import { Client, defaultSocket } from './client.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(root, 'sandbox');
fs.mkdirSync(cwd, { recursive: true });
// Only the model in our new test thread sees this instruction.
fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Isolated transport test\nReply with the exact requested marker only. Do not use tools, read files, modify anything, or delegate.\n');
const a = new Client(defaultSocket, 'openclaw_poc_test_a');
const b = new Client(defaultSocket, 'openclaw_poc_test_b');
const report = { socket: fs.realpathSync(defaultSocket), threadId: null, checks: [] };
let testThread;
const check = (name, value) => {
  report.checks.push({ name, passed: !!value });
  if (!value) throw new Error(`Failed: ${name}`);
  console.log(`PASS: ${name}`);
};
try {
  await a.connect();
  await b.connect();
  const created = await a.request('thread/start', {
    cwd, approvalPolicy: 'never', sandbox: 'read-only',
    developerInstructions: 'Isolated transport test. Never use tools or delegate. Reply with only the exact marker requested by the user.',
  });
  testThread = created.thread.id;
  report.threadId = testThread;
  console.log(`Test conversation: ${testThread}`);
  // A new thread has no persisted rollout until its first turn; resume needs it.
  const warmup = await a.request('turn/start', {
    threadId: testThread, input: [{ type: 'text', text: 'Reply with exactly POC_READY. Do not use tools.', text_elements: [] }],
  });
  const ready = await a.waitFor(e => e.method === 'turn/completed' && e.params?.turn?.id === warmup.turn.id, 90000);
  check('Initial turn persists isolated test conversation', ready.params.turn.status === 'completed');
  await b.attach(testThread);
  check('Second independent client attaches to first client’s loaded conversation', (await b.loaded()).includes(testThread));

  for (const [sender, marker] of [[b, 'POC_FROM_B'], [a, 'POC_FROM_A']]) {
    const offsets = [a.events.length, b.events.length];
    const { turn } = await sender.send(testThread, `Reply with exactly ${marker}. Do not use any tools.`);
    const completed = await Promise.all([a, b].map((c, i) => c.waitFor(e => e.method === 'turn/completed' && e.params?.turn?.id === turn.id, 90000, offsets[i])));
    check(`${marker}: both clients receive completed turn`, completed.every(e => e.params.turn.status === 'completed'));
    for (const [i, c] of [a, b].entries()) {
      const events = c.events.slice(offsets[i]).filter(e => e.params?.threadId === testThread);
      const messages = events.filter(e => e.method === 'item/completed' && e.params?.item?.type === 'agentMessage');
      check(`${marker}: client ${i === 0 ? 'A' : 'B'} receives assistant marker`, messages.some(e => e.params.item.text?.includes(marker)));
      check(`${marker}: client ${i === 0 ? 'A' : 'B'} receives submitted user message`, events.some(e => ['item/started', 'item/completed'].includes(e.method) && e.params?.item?.type === 'userMessage' && JSON.stringify(e.params.item.content).includes(marker)));
    }
  }
  await b.close();
  const read = await a.request('thread/read', { threadId: testThread });
  check('Closing client B leaves conversation loaded and idle for client A', read.thread.status.type === 'idle');
  let rejected = false;
  try { await a.attach('00000000-0000-0000-0000-000000000000'); } catch (e) { rejected = e.message.includes('Refusing to resume'); }
  check('Guard rejects unloaded conversation without acquiring another session', rejected);
  report.verdict = 'VALIDATED';
} catch (e) {
  report.verdict = 'PARTIAL';
  report.error = e.message;
  console.error(e);
  process.exitCode = 1;
} finally {
  await a.close();
  await b.close();
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
