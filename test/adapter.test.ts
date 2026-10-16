import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mockDaemon } from './mock.js';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';

async function setup(t: any, timeout = 200) {
  const mock = await mockDaemon(); const transport = new Transport(mock.socket, timeout); const adapter = new DaemonAdapter(transport);
  t.after(async () => { adapter.close(); await mock.close(); });
  await transport.connect(); return { mock, transport, adapter };
}
test('explicit loaded attach is shared; history is bounded; browser release never unloads', async t => {
  const { adapter, mock } = await setup(t);
  const releases = await Promise.all([adapter.acquire('thread-1'), adapter.acquire('thread-1')]);
  assert.equal(mock.calls.filter(c => c.method === 'thread/resume').length, 1);
  assert.deepEqual(mock.calls.find(c => c.method === 'thread/resume').params, { threadId: 'thread-1', excludeTurns: true });
  const page = await adapter.history('thread-1'); assert.equal(page.data[0].item.id, 'user-1');
  assert.equal((await adapter.history('thread-1', page.nextCursor!)).data[0].item.id, 'old');
  assert.equal(mock.calls.find(c => c.method === 'thread/items/list').params.limit, 50);
  releases.forEach(release => { release(); release(); });
  assert.equal(mock.calls.some(c => /unsubscribe|interrupt|archive/.test(c.method)), false);
  await assert.rejects(adapter.attach('unloaded'), /already loaded/);
  assert.equal(mock.calls.filter(c => c.method === 'thread/resume').length, 1);
});
test('exact text, same-ID deduplication, conflicting reuse and concurrent submissions', async t => {
  const { adapter, mock } = await setup(t);
  mock.turnMode('hold');
  const text = '  exact\n🙂 café\ntext  ';
  const first = adapter.send('thread-1', text, 'id-1');
  await assert.rejects(adapter.send('thread-1', 'other', 'id-2'), { code: 'busy' });
  const result = await first; assert.equal(result.state, 'accepted');
  assert.equal((await adapter.send('thread-1', text, 'id-1')).turnId, result.turnId);
  await assert.rejects(adapter.send('thread-1', 'changed', 'id-1'), { code: 'conflict' });
  const calls = mock.calls.filter(c => c.method === 'turn/start'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { threadId: 'thread-1', clientUserMessageId: 'id-1', input: [{ type: 'text', text, text_elements: [] }] });
  await assert.rejects(adapter.send('unloaded', 'text', 'id-3'), /already loaded/);
});
test('busy precheck and daemon race rejection never queue, retry or override policy', async t => {
  const { adapter, mock } = await setup(t);
  mock.status('active'); await assert.rejects(adapter.send('thread-1', 'text', 'busy-1'), { code: 'busy' });
  assert.equal(mock.calls.some(c => c.method === 'turn/start'), false);
  mock.status('idle'); mock.turnMode('reject');
  const result = await adapter.send('thread-1', 'text', 'race-1'); assert.equal(result.state, 'failed');
  assert.match(result.message!, /Competing/); assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('timeout after acceptance is unknown, blocks new sends and reconciles by client ID without resend', async t => {
  const { adapter, mock } = await setup(t, 40); mock.turnMode('timeout');
  const result = await adapter.send('thread-1', 'same text', 'unknown-1'); assert.equal(result.state, 'outcome-unknown');
  await assert.rejects(adapter.send('thread-1', 'next', 'unknown-2'), { code: 'busy' });
  assert.equal((await adapter.send('thread-1', 'same text', 'unknown-1')).state, 'outcome-unknown');
  const recovered = await adapter.submission('unknown-1'); assert.equal(recovered.state, 'completed'); assert.equal(recovered.turnId, 'sent-1');
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('disconnected write reconciles after reconnect; absent client ID remains unknown', async t => {
  const { adapter, transport, mock } = await setup(t, 60); mock.turnMode('disconnect');
  assert.equal((await adapter.send('thread-1', 'text', 'drop-1')).state, 'outcome-unknown');
  await transport.connect(); assert.equal((await adapter.submission('drop-1')).state, 'completed');
  mock.turnMode('timeout'); assert.equal((await adapter.send('thread-1', 'same text', 'missing-1')).state, 'outcome-unknown');
  mock.entries([{ turnId: 'someone-else', item: { id: 'different', type: 'userMessage', content: [{ type: 'text', text: 'same text' }] } }]);
  assert.equal((await adapter.submission('missing-1')).state, 'outcome-unknown');
});
test('interactive requests are visible, unresolved and never answered; resolved notices clear block', async t => {
  const { adapter, mock } = await setup(t);
  let notice = once(adapter, 'event');
  mock.notice({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } });
  assert.equal((await notice)[0].requestId, 'approval-1');
  assert.equal((await adapter.history('thread-1')).blocked, true); assert.equal(mock.replies.length, 0);
  notice = once(adapter, 'event'); mock.notice({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'approval-1' } }); await notice;
  assert.equal((await adapter.history('thread-1')).blocked, false);
});
test('timeouts, disconnects, obsolete connections, inflight limits and reconnect', async t => {
  const { transport, adapter, mock } = await setup(t, 40);
  mock.hold(true);
  await assert.rejects(transport.request('test-write', {}, true), { code: 'outcome-unknown' });
  const pending = transport.request('test-write', {}, true); const rejected = assert.rejects(pending, { code: 'outcome-unknown' }); mock.disconnect(); await rejected;
  assert.equal(transport.state, 'offline');
  mock.hold(false); await transport.connect(); await adapter.attach('thread-1'); assert.equal(transport.state, 'connected');
  mock.hold(true);
  const requests = Array.from({ length: 32 }, () => transport.request('read').catch(e => e.code));
  await assert.rejects(transport.request('overflow'), { code: 'capacity' });
  transport.close(); assert.ok((await Promise.all(requests)).every(code => code === 'offline'));
});
test('incompatibility and absent socket are explicit without fallback', async t => {
  const mock = await mockDaemon(); mock.incompatible(); const transport = new Transport(mock.socket, 50);
  t.after(async () => { transport.close(); await mock.close(); });
  await assert.rejects(transport.connect()); assert.equal(transport.state, 'incompatible');
  const absent = new Transport('/nonexistent/pocket.sock', 50); await assert.rejects(absent.connect()); assert.equal(absent.state, 'offline'); absent.close();
});
test('malformed JSON closes only the owned connection', async t => {
  const { transport, mock } = await setup(t);
  const closed = once(transport, 'state'); for (const ws of mock.clients) ws.send('invalid'); await closed;
  assert.equal(transport.state, 'offline');
});

test('picker omits blank session shells and orders by conversation recency rather than metadata updates', async t => {
  const { adapter, mock } = await setup(t);
  mock.metadata('thread-1', { name: null, preview: '', updatedAt: 9999, recencyAt: 9999 });
  mock.metadata('thread-2', { name: 'Real conversation', preview: 'message', updatedAt: 100, recencyAt: 10 });
  assert.deepEqual((await adapter.list()).map(t => t.id), ['thread-2']);
  mock.metadata('thread-1', { name: null, preview: 'A conversation without a saved title', updatedAt: 9999, recencyAt: 1 });
  const threads = await adapter.list();
  assert.deepEqual(threads.map(t => t.id), ['thread-2', 'thread-1']);
  assert.equal(threads[1].preview, 'A conversation without a saved title');
  assert.equal(mock.calls.some(c => c.method === 'thread/resume' || c.method === 'turn/start'), false);
});

test('completion indicators use one bounded turn header without loading transcript items', async t => {
  const { adapter, mock } = await setup(t);
  const thread = await adapter.read('thread-1');
  assert.deepEqual(thread.latestTurn, { id: 'sent-0', status: 'completed' });
  const request = mock.calls.find(call => call.method === 'thread/turns/list');
  assert.deepEqual(request.params, { threadId: 'thread-1', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  assert.equal(mock.calls.some(call => ['thread/resume', 'thread/items/list', 'turn/start'].includes(call.method)), false);
});

function asyncQuestion(turnId = 'sent-0', itemId = 'question-1') {
  return { turnId, item: { id: itemId, type: 'agentMessage', delivery: 'async', questions: [{ title: 'Which color?', options: ['Blue', 'Green'] }], text: 'Which color?' } };
}
test('active async question replies steer the exact turn, deduplicate and reject stale/ordinary/blocked sends', async t => {
  const { adapter, mock } = await setup(t);
  mock.turnMode('hold'); mock.status('active'); mock.entries([asyncQuestion()]);
  const question = { itemId: 'question-1', turnId: 'sent-0' };
  assert.deepEqual((await adapter.history('thread-1')).question, question);
  await assert.rejects(adapter.send('thread-1', 'ordinary', 'ordinary-1'), { code: 'busy' });
  const exact = '  Green\nplease  ';
  const result = await adapter.send('thread-1', exact, 'reply-1', [], question);
  assert.equal(result.state, 'accepted'); assert.equal(result.turnId, 'sent-0');
  assert.equal((await adapter.send('thread-1', exact, 'reply-1', [], question)).state, 'accepted');
  assert.equal(mock.calls.filter(c => c.method === 'turn/steer').length, 1);
  assert.deepEqual(mock.calls.find(c => c.method === 'turn/steer').params, { threadId: 'thread-1', clientUserMessageId: 'reply-1', expectedTurnId: 'sent-0', input: [{ type: 'text', text: exact, text_elements: [] }] });
  assert.equal((await adapter.history('thread-1')).question, null);
  await assert.rejects(adapter.send('thread-1', 'again', 'reply-2', [], question), { code: 'conflict' });
  // Even if history is momentarily stale, claims cannot be cleared by a rejected duplicate.
  mock.entries([asyncQuestion()]);
  await assert.rejects(adapter.send('thread-1', 'again', 'reply-3', [], question), { code: 'conflict' });
  await assert.rejects(adapter.send('thread-1', 'again', 'reply-4', [], question), { code: 'conflict' });
  mock.entries([asyncQuestion('other-turn', 'question-2')]);
  await assert.rejects(adapter.send('thread-1', 'old', 'reply-5', [], { itemId: 'question-2', turnId: 'other-turn' }), { code: 'busy' });
  mock.notice({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(adapter.send('thread-1', 'approve', 'reply-6', [], { itemId: 'question-2', turnId: 'other-turn' }), { code: 'busy' });
  assert.equal(mock.replies.length, 0); assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 0);
});
test('question replies work after Pocket starts work and ambiguous acceptance reconciles without retry', async t => {
  const { adapter, mock } = await setup(t, 40); mock.turnMode('hold');
  const original = await adapter.send('thread-1', 'Start', 'initial-question');
  const question = { itemId: 'question-1', turnId: original.turnId! };
  mock.entries([asyncQuestion(original.turnId!)]); mock.turnMode('timeout');
  const reply = await adapter.send('thread-1', 'Blue', 'unknown-reply', [], question);
  assert.equal(reply.state, 'outcome-unknown');
  await assert.rejects(adapter.send('thread-1', 'again', 'other-reply', [], question), { code: 'busy' });
  assert.equal((await adapter.submission('unknown-reply')).state, 'accepted');
  assert.equal(mock.calls.filter(c => c.method === 'turn/steer').length, 1);
});
test('idle pending question replies use a normal new turn and history cannot reopen answered questions', async t => {
  const { adapter, mock } = await setup(t); mock.entries([asyncQuestion()]);
  const question = (await adapter.history('thread-1')).question!;
  const result = await adapter.send('thread-1', 'Green', 'idle-reply', [], question);
  assert.equal(result.state, 'completed');
  assert.equal(mock.calls.filter(c => c.method === 'turn/steer').length, 0);
  assert.equal((await adapter.history('thread-1')).question, null);
});

test('explicit active follow-ups preserve text/images and deduplicate while allowing subsequent same-turn messages', async t => {
  const { adapter, mock } = await setup(t); mock.turnMode('hold');
  const original = await adapter.send('thread-1', 'Start work', 'follow-initial');
  const text = '  One more thing\nkeep exact text  ';
  const reply = await adapter.send('thread-1', text, 'follow-one', ['/scratch/image.png'], undefined, original.turnId);
  assert.equal(reply.state, 'accepted'); assert.equal(reply.turnId, original.turnId);
  await adapter.send('thread-1', text, 'follow-one', ['/scratch/image.png'], undefined, original.turnId);
  await assert.rejects(adapter.send('thread-1', text, 'follow-one', ['/scratch/image.png'], undefined, 'different'), { code: 'conflict' });
  assert.deepEqual(mock.calls.find(c => c.method === 'turn/steer').params, { threadId: 'thread-1', clientUserMessageId: 'follow-one', expectedTurnId: original.turnId, input: [{ type: 'text', text, text_elements: [] }, { type: 'localImage', path: '/scratch/image.png' }] });
  await adapter.send('thread-1', 'Another follow-up', 'follow-two', [], undefined, original.turnId);
  assert.equal(mock.calls.filter(c => c.method === 'turn/steer').length, 2);
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('stale, ended, blocked and raced follow-ups never become new turns', async t => {
  const { adapter, mock } = await setup(t); mock.status('active'); mock.turnMode('hold');
  await assert.rejects(adapter.send('thread-1', 'Old target', 'follow-stale', [], undefined, 'old-turn'), { code: 'conflict' });
  mock.status('idle');
  await assert.rejects(adapter.send('thread-1', 'Ended', 'follow-ended', [], undefined, 'sent-0'), { code: 'conflict' });
  mock.status('active'); mock.turnMode('reject');
  const raced = await adapter.send('thread-1', 'Race', 'follow-raced', [], undefined, 'sent-0');
  assert.equal(raced.state, 'failed'); assert.match(raced.message!, /Active turn changed/);
  mock.notice({ id: 'follow-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(adapter.send('thread-1', 'Blocked', 'follow-blocked', [], undefined, 'sent-0'), { code: 'busy' });
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 0); assert.equal(mock.replies.length, 0);
});
test('ambiguous follow-up blocks further writes and recovers by client ID without retry', async t => {
  const { adapter, mock } = await setup(t, 40); mock.status('active'); mock.turnMode('timeout');
  const result = await adapter.send('thread-1', 'Follow-up', 'follow-unknown', [], undefined, 'sent-0');
  assert.equal(result.state, 'outcome-unknown');
  await assert.rejects(adapter.send('thread-1', 'More', 'follow-more', [], undefined, 'sent-0'), { code: 'busy' });
  assert.equal((await adapter.submission('follow-unknown')).state, 'accepted');
  assert.equal(mock.calls.filter(c => c.method === 'turn/steer').length, 1);
});
