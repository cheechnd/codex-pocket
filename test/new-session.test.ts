import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccessControl } from '../src/server/access.js';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { createApp } from '../src/server/app.js';
import { mockDaemon } from './mock.js';
import { randomUUID } from 'node:crypto';

async function setup(t: any, timeout = 200) {
  const mock = await mockDaemon();
  const adapter = new DaemonAdapter(new Transport(mock.socket, timeout));
  await adapter.transport.connect();
  const accessControl = new AccessControl(`${mock.directory}/access`);
  const app = createApp(adapter, 44347, { access: accessControl });
  await new Promise<void>(resolve => app.server.listen(44347, '127.0.0.1', resolve));
  const paired = await fetch(app.origin + '/api/pair', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify({ code: accessControl.pairingCode() }) });
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1', Cookie: cookie };
  t.after(async () => { await app.close(); await mock.close(); });
  return { mock, adapter, app, headers };
}

test('new-session endpoints require pairing and CSRF and reject traversal or configuration overrides before writes', async t => {
  const { mock, app, headers } = await setup(t);
  const directory = await mkdtemp(join(tmpdir(), 'pocket-new-security-'));
  const body = { clientRequestId: randomUUID(), directory, text: 'first' };
  const post = (input: unknown, requestHeaders: Record<string, string> = headers) => fetch(app.origin + '/api/new-session', { method: 'POST', headers: requestHeaders, body: JSON.stringify(input) });
  const { Cookie: _cookie, ...withoutCookie } = headers;
  assert.equal((await post(body, withoutCookie)).status, 401);
  assert.equal((await fetch(app.origin + '/api/new-session/options')).status, 401);
  assert.equal((await post(body, { ...headers, Origin: 'https://evil.example' })).status, 403);
  for (const name of ['..', '../escape', 'a/b', 'a\\b', '.', ' ', 'a\nname']) {
    assert.equal((await post({ ...body, clientRequestId: randomUUID(), newDirectoryName: name })).status, 400);
  }
  assert.equal((await post({ ...body, approvalPolicy: 'never' })).status, 400);
  assert.equal(mock.calls.some(call => call.method === 'thread/start'), false);
});

for (const mode of ['timeout', 'disconnect'] as const) test(`ambiguous thread creation after ${mode} is retained across reconnect and never resent`, async t => {
  const { mock, adapter, app, headers } = await setup(t, 50);
  const directory = await mkdtemp(join(tmpdir(), 'pocket-new-unknown-'));
  const body = { clientRequestId: randomUUID(), directory, text: 'only once' };
  mock.threadStartMode(mode);
  const response = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await response.json() as any).state, 'outcome-unknown');
  mock.threadStartMode('normal'); await adapter.transport.connect();
  const status = await fetch(app.origin + `/api/new-session/${body.clientRequestId}`, { headers });
  assert.equal((await status.json() as any).state, 'outcome-unknown');
  const duplicate = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await duplicate.json() as any).state, 'outcome-unknown');
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(mock.calls.some(call => call.method === 'turn/start'), false);
});

test('new sessions share the existing bounded subscription capacity', async t => {
  const { mock, adapter } = await setup(t);
  for (let n = 0; n < 32; n++) await adapter.createSession(tmpdir(), 'test', `capacity-${n}`);
  await assert.rejects(adapter.createSession(tmpdir(), 'test', 'capacity-overflow'), { code: 'capacity' });
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 32);
});

test('new session starts with cwd only, sends exact first text, and deduplicates requests', async t => {
  const { mock, app, headers } = await setup(t);
  const parent = await mkdtemp(join(tmpdir(), 'pocket-new-session-'));
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const text = '  exact first message\n🙂  ';
  const body = { clientRequestId: id, directory: parent, newDirectoryName: 'project', text };
  const first = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(first.status, 200);
  const record = await first.json() as any;
  assert.equal(record.state, 'created');
  assert.equal(record.cwd, join(parent, 'project'));
  assert.equal(record.submission.state, 'completed');
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.deepEqual(mock.calls.find(call => call.method === 'thread/start').params, { cwd: join(parent, 'project') });
  assert.equal(mock.calls.filter(call => call.method === 'thread/resume').length, 0);
  const sent = mock.calls.find(call => call.method === 'turn/start');
  assert.deepEqual(sent.params.input, [{ type: 'text', text, text_elements: [] }]);
  assert.equal(sent.params.clientUserMessageId, `new-${id}`);
  assert.equal((await stat(join(parent, 'project'))).isDirectory(), true);
  await access(join(parent, 'project'), fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);

  const duplicate = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.deepEqual(await duplicate.json(), record);
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  const conflict = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ ...body, text: 'different' }) });
  assert.equal(conflict.status, 409);
  const status = await fetch(app.origin + `/api/new-session/${id}`, { headers: { Cookie: headers.Cookie } });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as any).id, id);
});

test('creation failure is retained and never overwrites an existing child', async t => {
  const { mock, app, headers } = await setup(t);
  const parent = await mkdtemp(join(tmpdir(), 'pocket-new-session-'));
  const id = '223e4567-e89b-12d3-a456-426614174000';
  const body = { clientRequestId: id, directory: parent, newDirectoryName: '.', text: 'start' };
  const invalid = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(invalid.status, 400);
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 0);
  const child = join(parent, 'already-there');
  await (await import('node:fs/promises')).mkdir(child);
  const failedId = '323e4567-e89b-12d3-a456-426614174000';
  const failed = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: failedId, directory: parent, newDirectoryName: 'already-there', text: 'start' }) });
  assert.equal(failed.status, 200);
  assert.equal((await failed.json() as any).state, 'failed');
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 0);
});

test('known thread creation retains identity when initial send preflight fails', async t => {
  const { mock, app, headers } = await setup(t);
  mock.status('active');
  const parent = await mkdtemp(join(tmpdir(), 'pocket-new-session-'));
  const id = '523e4567-e89b-12d3-a456-426614174000';
  const response = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: id, directory: parent, text: 'must remain visible' }) });
  const record = await response.json() as any;
  assert.equal(record.state, 'created');
  assert.equal(record.thread.id, 'new-thread-1');
  assert.equal(record.submission.state, 'failed');
  assert.match(record.submission.message, /busy|current turn/i);
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'thread/resume').length, 0);
  assert.equal(mock.calls.filter(call => call.method === 'turn/start').length, 0);
  const duplicate = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: id, directory: parent, text: 'must remain visible' }) });
  assert.deepEqual(await duplicate.json(), record);
});

test('concurrent same-ID creation shares one promise and one daemon start', async t => {
  const { mock, app, headers } = await setup(t);
  const parent = await mkdtemp(join(tmpdir(), 'pocket-new-session-'));
  const id = '623e4567-e89b-12d3-a456-426614174000';
  const body = JSON.stringify({ clientRequestId: id, directory: parent, text: 'only once' });
  const [first, second] = await Promise.all([
    fetch(app.origin + '/api/new-session', { method: 'POST', headers, body }),
    fetch(app.origin + '/api/new-session', { method: 'POST', headers, body }),
  ]);
  const a = await first.json();
  const b = await second.json();
  assert.deepEqual(a, b);
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('malformed successful thread/start is retained as an unknown creation outcome', async t => {
  const { mock, app, headers } = await setup(t);
  mock.threadStartMode('malformed');
  const parent = await mkdtemp(join(tmpdir(), 'pocket-new-session-'));
  const id = '723e4567-e89b-12d3-a456-426614174000';
  const response = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: id, directory: parent, text: 'do not retry' }) });
  const record = await response.json() as any;
  assert.equal(record.state, 'outcome-unknown');
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  const duplicate = await fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: id, directory: parent, text: 'do not retry' }) });
  assert.deepEqual(await duplicate.json(), record);
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
});

test('unknown first submission remains created and GET reconciles only that submission', async t => {
  const { mock, app, headers } = await setup(t, 50);
  mock.turnMode('timeout');
  const parent = await mkdtemp(join(tmpdir(), 'pocket-new-session-'));
  const id = '423e4567-e89b-12d3-a456-426614174000';
  const request = fetch(app.origin + '/api/new-session', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: id, directory: parent, text: 'do not resend' }) });
  const created = await request;
  const record = await created.json() as any;
  assert.equal(record.state, 'created');
  assert.equal(record.submission.state, 'outcome-unknown');
  assert.equal(mock.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(mock.calls.filter(call => call.method === 'turn/start').length, 1);
  const reconciled = await fetch(app.origin + `/api/new-session/${id}`, { headers: { Cookie: headers.Cookie } });
  const after = await reconciled.json() as any;
  assert.equal(after.state, 'created');
  assert.equal(after.submission.state, 'completed');
  assert.equal(mock.calls.filter(call => call.method === 'turn/start').length, 1);
});
