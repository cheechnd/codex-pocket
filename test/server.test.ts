import { AccessControl } from '../src/server/access.js';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mockDaemon } from './mock.js';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { createApp } from '../src/server/app.js';

test('local API rejects cross-origin reads/writes/events and arbitrary targets; SSE and shutdown lifecycle', async t => {
  const mock = await mockDaemon(); const adapter = new DaemonAdapter(new Transport(mock.socket)); await adapter.transport.connect();
  const access = new AccessControl(`${mock.directory}/access`);
  const app = createApp(adapter, 44317, { access }); await new Promise<void>(resolve => app.server.listen(44317, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await mock.close(); });
  const paired = await fetch(app.origin + '/api/pair', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify({ code: access.pairingCode() }) });
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const navigation = await fetch(app.origin + '/', { headers: { Origin: 'https://outside.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(navigation.status, 200); assert.match(await navigation.text(), /Pair this device/);
  assert.equal((await fetch(app.origin + '/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site', Cookie: cookie } })).status, 403);
  const authenticatedFetch: typeof fetch = (url, options = {}) => fetch(url, { ...options, headers: { Cookie: cookie, ...options.headers } });
  for (const path of ['/api/status', '/api/threads', '/api/threads/thread-1/events']) {
    assert.equal((await authenticatedFetch(app.origin + path, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  }
  assert.equal(await new Promise(resolve => { httpRequest(app.origin + '/api/status', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).end(); }), 403);
  assert.equal((await authenticatedFetch(app.origin + '/api/threads/unloaded/history')).status, 404);
  const send = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '  exact\ntext  ', clientSubmissionId: 'id-1' }) };
  assert.equal((await authenticatedFetch(app.origin + '/api/threads/thread-1/messages', send)).status, 403);
  const rejected = await authenticatedFetch(app.origin + '/api/threads/thread-1/messages', { ...send, headers: { ...send.headers, Origin: app.origin, 'X-Pocket-Request': '1' } });
  assert.equal(rejected.status, 200); assert.ok((await rejected.json() as any).turnId);
  const cancel = new AbortController(); const events = await authenticatedFetch(app.origin + '/api/threads/thread-1/events', { signal: cancel.signal });
  const reader = events.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  mock.notice({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'sensitive' } });
  const notice = new TextDecoder().decode((await reader.read()).value); assert.match(notice, /event: change/); assert.doesNotMatch(notice, /sensitive/);
  const outcome = await authenticatedFetch(app.origin + '/api/submissions/id-1'); assert.equal(outcome.status, 200); assert.equal((await outcome.json() as any).state, 'completed');
  assert.equal((await authenticatedFetch(app.origin + '/api/submissions/not-retained')).status, 404);
  access.pairingCode(true);
  mock.notice({ method: 'item/completed', params: { threadId: 'thread-1' } });
  assert.equal((await reader.read()).done, true);
  cancel.abort(); assert.equal(mock.calls.some(c => c.method === 'thread/unsubscribe'), false);
});

test('question reply API requires pairing and CSRF and rejects forged/stale targets', async t => {
  const mock = await mockDaemon(); const adapter = new DaemonAdapter(new Transport(mock.socket)); await adapter.transport.connect();
  const access = new AccessControl(`${mock.directory}/access`);
  const app = createApp(adapter, 44326, { access }); await new Promise<void>(resolve => app.server.listen(44326, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await mock.close(); });
  mock.status('active'); mock.turnMode('hold');
  mock.entries([{ turnId: 'sent-0', item: { id: 'async-q', type: 'agentMessage', delivery: 'async', questions: [{ title: 'Which color?' }] } }]);
  const question = { itemId: 'async-q', turnId: 'sent-0' };
  const headers = { Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' };
  const body = JSON.stringify({ text: 'Blue', question, clientSubmissionId: 'api-reply' });
  assert.equal((await fetch(app.origin + '/api/threads/thread-1/messages', { method: 'POST', headers, body })).status, 401);
  const paired = await fetch(app.origin + '/api/pair', { method: 'POST', headers, body: JSON.stringify({ code: access.pairingCode() }) });
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(app.origin + '/api/threads/thread-1/messages', { method: 'POST', headers: { ...headers, Origin: 'https://outside.example', Cookie: cookie }, body })).status, 403);
  const send = (value: unknown) => fetch(app.origin + '/api/threads/thread-1/messages', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify(value) });
  assert.equal((await send({ text: 'Blue', question: { itemId: 'fake', turnId: 'sent-0' }, clientSubmissionId: 'fake' })).status, 409);
  const response = await send(JSON.parse(body)); assert.equal(response.status, 200); assert.equal((await response.json() as any).state, 'accepted');
  assert.equal((await send({ text: 'Again', question, clientSubmissionId: 'again' })).status, 409);
  const followup = await send({ text: 'Also check this', expectedTurnId: 'sent-0', clientSubmissionId: 'api-followup' });
  assert.equal(followup.status, 200); assert.equal((await followup.json() as any).state, 'accepted');
  assert.equal((await send({ text: 'Stale', expectedTurnId: 'old', clientSubmissionId: 'api-stale-followup' })).status, 409);
  assert.equal(mock.calls.filter(c => c.method === 'turn/steer').length, 2);
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 0);
});
