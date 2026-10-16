import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockDaemon } from './mock.js';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';

async function setup(t: any, timeout = 80) {
  const mock = await mockDaemon();
  const adapter = new DaemonAdapter(new Transport(mock.socket, timeout));
  t.after(async () => { adapter.close(); await mock.close(); });
  await adapter.transport.connect();
  return { mock, adapter };
}

const record = (id: string, name: string | null, preview: string, recencyAt: number) => ({
  id, name, cwd: '/saved', preview, updatedAt: recencyAt, recencyAt, status: { type: 'idle' },
  path: '/private/should-not-leak.jsonl', turns: [{ id: 'turn', items: ['transcript'] }], config: { secret: true },
});

test('saved listing is bounded, metadata-only, sanitized, paginated, and marks loaded rows', async t => {
  const { adapter, mock } = await setup(t);
  mock.saved([record('saved-1', 'First', 'preview', 3), record('saved-2', null, 'Unnamed preview', 2), record('saved-3', '', '', 1)]);
  mock.loaded(['saved-1']);

  const page = await adapter.saved();
  assert.deepEqual(page.data.map(thread => [thread.id, thread.loaded]), [['saved-1', true], ['saved-2', false]]);
  assert.equal('path' in page.data[0], false);
  assert.equal('turns' in page.data[0], false);
  assert.equal('config' in page.data[0], false);
  assert.equal(mock.calls.filter(call => call.method === 'thread/list').length, 1);
  assert.deepEqual(mock.calls.find(call => call.method === 'thread/list').params, {
    cursor: null, limit: 50, sortKey: 'recency_at', sortDirection: 'desc', archived: false, useStateDbOnly: true, modelProviders: [],
  });
});

test('saved search is trimmed and paginated without broad transcript access', async t => {
  const { adapter, mock } = await setup(t);
  mock.saved(Array.from({ length: 51 }, (_, i) => record(`saved-${i}`, `Project ${i}`, `preview ${i}`, 100 - i)));
  const first = await adapter.saved(undefined, '  project  ');
  assert.equal(first.data.length, 50);
  assert.equal(first.nextCursor, '50');
  assert.equal(mock.calls.find(call => call.method === 'thread/list').params.searchTerm, 'project');
  const second = await adapter.saved(first.nextCursor!);
  assert.equal(second.data.length, 1);
  assert.equal(second.data[0].id, 'saved-50');
  assert.equal(mock.calls.some(call => ['thread/items/list', 'thread/resume', 'turn/start'].includes(call.method)), false);
  await assert.rejects(adapter.saved('x'.repeat(4097)), { code: 'input' });
  await assert.rejects(adapter.saved(undefined, 'x'.repeat(201)), { code: 'input' });
});

test('open explicitly resumes one saved thread and deduplicates concurrent opens without overrides', async t => {
  const { adapter, mock } = await setup(t);
  mock.saved([record('saved-open', 'Saved thread', 'A preview', 10)]);
  mock.loaded([]);
  const [first, second] = await Promise.all([adapter.open('saved-open'), adapter.open('saved-open')]);
  assert.equal(first.id, 'saved-open');
  assert.equal(second.id, 'saved-open');
  assert.equal(first.status.type, 'idle');
  assert.equal(second.status.type, 'idle');
  const resumes = mock.calls.filter(call => call.method === 'thread/resume');
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].params, { threadId: 'saved-open', excludeTurns: true });
  assert.equal(mock.calls.filter(call => call.method === 'turn/start').length, 0);
  await assert.rejects(adapter.open('../not-an-id'), { code: 'input' });
  assert.equal((await adapter.history('saved-open')).thread.id, 'saved-open');
});

test('ambiguous saved resume is not retried', async t => {
  const { adapter, mock } = await setup(t, 35);
  mock.saved([record('saved-timeout', 'Timeout thread', 'preview', 10)]);
  mock.loaded([]);
  mock.resumeMode('timeout');
  await assert.rejects(adapter.open('saved-timeout'), { code: 'outcome-unknown' });
  assert.equal(mock.calls.filter(call => call.method === 'thread/resume').length, 1);
});

test('ambiguous saved resume recovers only after loaded-state confirmation', async t => {
  const { adapter, mock } = await setup(t, 35);
  mock.saved([record('saved-recovered', 'Recovered thread', 'preview', 10)]);
  mock.loaded([]);
  mock.resumeMode('timeout-accepted');
  const opened = await adapter.open('saved-recovered');
  assert.equal(opened.id, 'saved-recovered');
  assert.equal(opened.status.type, 'idle');
  assert.equal(mock.calls.filter(call => call.method === 'thread/resume').length, 1);
});
