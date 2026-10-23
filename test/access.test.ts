import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { mockDaemon } from './mock.js';
import { AccessControl } from '../src/server/access.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { Transport } from '../src/daemon/transport.js';
import { createApp } from '../src/server/app.js';

test('private-origin pairing, protected reads/writes/SSE, expiry, cookie flags, replay, revocation and rate limits', async t => {
  const mock = await mockDaemon(); const adapter = new DaemonAdapter(new Transport(mock.socket)); await adapter.transport.connect();
  const access = new AccessControl(`${mock.directory}/access`); const origin = 'https://pocket.test:9443';
  const app = createApp(adapter, 44321, { access, origin }); await new Promise<void>(resolve => app.server.listen(44321, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await mock.close(); });
  function call(path: string, method = 'GET', cookie = '', body?: unknown, extra: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: any; body: any }>((resolve, reject) => {
      const req = request('http://127.0.0.1:44321' + path, { method, headers: { Host: 'pocket.test:9443', Cookie: cookie, ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' } : {}), ...extra } }, res => {
        let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(data) }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  for (const path of ['/api/status', '/api/threads', '/api/threads/thread-1/history', '/api/threads/thread-1/events', '/api/submissions']) {
    assert.equal((await call(path, 'GET', '', undefined, { 'Tailscale-User-Login': 'fake', 'X-Forwarded-For': '127.0.0.1' })).status, 401);
  }
  assert.equal((await call('/api/threads/thread-1/messages', 'POST', '', { text: 'no', clientSubmissionId: 'no' })).status, 401);
  const code = access.pairingCode();
  assert.equal((await call('/api/pair', 'POST', '', { code }, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await call('/api/pair', 'POST', '', { code }, { Host: 'attacker.test' })).status, 403);
  const paired = await Promise.all([call('/api/pair', 'POST', '', { code }), call('/api/pair', 'POST', '', { code })]);
  assert.deepEqual(paired.map(p => p.status).sort(), [200, 401]);
  const rawCookie: string = paired.find(p => p.status === 200)!.headers['set-cookie'][0];
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(rawCookie.toLowerCase().includes(attribute.toLowerCase()));
  assert.ok(rawCookie.startsWith('__Host-codex-pocket='));
  assert.equal(statSync(access.stateFile).mode & 0o777, 0o600);
  const cookie = rawCookie.split(';')[0];
  assert.equal((await call('/api/status', 'GET', cookie)).status, 200);
  assert.equal((await call('/api/status', 'GET', cookie.replace('=F', '=X'))).status, 401);
  assert.equal((await call('/api/status', 'GET', cookie, undefined, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await call('/api/logout', 'POST', cookie, {})).status, 200);
  assert.equal((await call('/api/status', 'GET', cookie)).status, 401);
  const next = await call('/api/pair', 'POST', '', { code: access.pairingCode() }); const nextCookie = next.headers['set-cookie'][0].split(';')[0];
  // Session records survive backend restart; explicit admin revoke invalidates them.
  assert.ok(new AccessControl(`${mock.directory}/access`));
  access.pairingCode(true); assert.equal((await call('/api/status', 'GET', nextCookie)).status, 401);
  const expired = access.pairingCode(); const state = JSON.parse(readFileSync(access.stateFile, 'utf8')); state.pairing.expires = Date.now() - 1;
  writeFileSync(access.stateFile, JSON.stringify(state), { mode: 0o600 });
  assert.equal((await call('/api/pair', 'POST', '', { code: expired })).status, 401);
  for (let i = 0; i < 10; i++) await call('/api/pair', 'POST', '', { code: 'wrong' });
  assert.equal((await call('/api/pair', 'POST', '', { code: 'wrong' })).status, 429);
  assert.equal(mock.calls.some(c => c.method === 'turn/start'), false);
});

test('pairing rolls forward with activity, upgrades legacy cookies, and never renews expired or revoked sessions', async t => {
  const { sealData } = await import('iron-session');
  const day = 24 * 60 * 60 * 1000, start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const mock = await mockDaemon();
  const adapter = new DaemonAdapter(new Transport(mock.socket)); await adapter.transport.connect();
  const access = new AccessControl(`${mock.directory}/access`);
  const app = createApp(adapter, 44328, { access });
  await new Promise<void>(resolve => app.server.listen(44328, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await mock.close(); });
  const state = () => JSON.parse(readFileSync(access.stateFile, 'utf8'));
  const call = (cookie: string) => fetch(app.origin + '/api/status', { headers: { Cookie: cookie } });
  const paired = await fetch(app.origin + '/api/pair', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify({ code: access.pairingCode() }) });
  assert.equal(paired.status, 200);
  const initialCookie = paired.headers.get('set-cookie')!;
  assert.match(initialCookie, /Max-Age=2591940/i); // Library expires the cookie 60s before its seal.
  let cookie = initialCookie.split(';')[0];
  assert.equal(state().sessions[0].expires, start + 30 * day);
  const recent = await call(cookie);
  assert.equal(recent.status, 200); assert.equal(recent.headers.get('set-cookie'), null);
  t.mock.timers.setTime(start + 6 * day);
  const active = await call(cookie);
  assert.equal(active.status, 200); assert.ok(active.headers.get('set-cookie'));
  cookie = active.headers.get('set-cookie')!.split(';')[0];
  assert.equal(state().sessions[0].expires, start + 36 * day);
  // This is beyond the original expiry, but the renewed cookie remains valid.
  t.mock.timers.setTime(start + 31 * day);
  const renewed = await call(cookie);
  assert.equal(renewed.status, 200);
  cookie = renewed.headers.get('set-cookie')!.split(';')[0];
  assert.equal(state().sessions[0].expires, start + 61 * day);
  // Thirty inactive days expire it; simply presenting the old cookie cannot revive it.
  t.mock.timers.setTime(start + 61 * day);
  const expired = await call(cookie);
  assert.equal(expired.status, 401); assert.equal(expired.headers.get('set-cookie'), null);
  assert.equal(state().sessions[0].expires, start + 61 * day);

  const old = state(), legacyId = 'legacy-device';
  old.sessions = [{ id: legacyId, expires: Date.now() + 7 * day }];
  writeFileSync(access.stateFile, JSON.stringify(old), { mode: 0o600 });
  const legacyCookie = 'codex-pocket-local=' + await sealData({ id: legacyId }, { password: old.password, ttl: 7 * 24 * 3600 });
  const upgraded = await call(legacyCookie);
  assert.equal(upgraded.status, 200); assert.ok(upgraded.headers.get('set-cookie'));
  assert.equal(state().sessions[0].expires, Date.now() + 30 * day);
  const upgradedCookie = upgraded.headers.get('set-cookie')!.split(';')[0];
  t.mock.timers.setTime(start + 69 * day);
  assert.equal((await call(legacyCookie)).status, 401);
  const afterOldExpiry = await call(upgradedCookie);
  assert.equal(afterOldExpiry.status, 200);
  cookie = afterOldExpiry.headers.get('set-cookie')!.split(';')[0];
  access.pairingCode(true);
  const revoked = await call(cookie);
  assert.equal(revoked.status, 401); assert.equal(revoked.headers.get('set-cookie'), null);
  assert.equal(state().sessions.length, 0);
  assert.equal(mock.calls.some(c => c.method === 'turn/start'), false);
});
