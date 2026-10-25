import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { AttachmentStore } from '../src/server/attachments.js';
import { AccessControl } from '../src/server/access.js';
import { createApp } from '../src/server/app.js';
import { mockDaemon } from './mock.js';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';

const image = async () => ({ dataUrl: `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00cc00' } }).png().toBuffer()).toString('base64')}` });
test('image API stores private decoded images, exact text + localImage RPC, authenticated history and restart', async t => {
  const mock = await mockDaemon(); const adapter = new DaemonAdapter(new Transport(mock.socket, 60)); await adapter.transport.connect();
  const access = new AccessControl(`${mock.directory}/access`), store = new AttachmentStore(`${mock.directory}/images`);
  const app = createApp(adapter, 44325, { access, attachments: store }); await new Promise<void>(resolve => app.server.listen(44325, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await mock.close(); });
  const paired = await fetch(app.origin + '/api/pair', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify({ code: access.pairingCode() }) });
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const post = (body: unknown) => fetch(app.origin + '/api/threads/thread-1/messages', { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json', 'X-Pocket-Request': '1' }, body: JSON.stringify(body) });
  const text = '  screenshot\n🙂  ', images = [await image()];
  const input = { text, images, clientSubmissionId: 'image-1' };
  assert.equal((await post(input)).status, 200);
  const sent = mock.calls.find(c => c.method === 'turn/start').params;
  assert.equal(sent.input[0].text, text); assert.equal(sent.input[1].type, 'localImage');
  assert.ok(sent.input[1].path.startsWith(store.directory));
  assert.equal((await stat(sent.input[1].path)).mode & 0o777, 0o600);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await post(input)).status, 200); assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal((await post({ ...input, text: 'different' })).status, 409);
  const page = await (await fetch(app.origin + '/api/threads/thread-1/history', { headers: { Cookie: cookie } })).json() as any;
  const item = page.data.find((e: any) => e.item.clientId === 'image-1').item;
  assert.equal(item.content[0].text, text); const url = item.content[1].url; assert.match(url, /^\/api\/attachments\/[a-f0-9]{64}$/);
  assert.equal(item.content[1].width, 64); assert.equal(item.content[1].height, 64);
  assert.equal(JSON.stringify(page).includes(store.directory), false);
  assert.equal((await fetch(app.origin + url)).status, 401);
  assert.equal((await fetch(app.origin + url, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  const response = await fetch(app.origin + url, { headers: { Cookie: cookie } }); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(sent.input[1].path));
  const reopened = new AttachmentStore(store.directory);
  assert.equal((await reopened.get(url.split('/').at(-1))).mime, 'image/png');
  const restored = await reopened.history('thread-1', { data: [{ item: { type: 'userMessage', clientId: 'image-1', content: [{ type: 'localImage', path: sent.input[1].path }] } }] });
  assert.equal(restored.data[0].item.content[0].width, 64);
  assert.equal(restored.data[0].item.content[0].height, 64);
  mock.turnMode('timeout');
  const unknown = await (await post({ text: '', images, clientSubmissionId: 'image-only' })).json() as any; assert.equal(unknown.state, 'outcome-unknown');
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').at(-1).params.input.length, 1);
  assert.equal((await adapter.submission('image-only')).state, 'completed');
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 2);
  for (const bad of [[{ dataUrl: 'https://evil.example/a.png' }], [{ dataUrl: 'data:image/png;base64,aGVsbG8=' }], [{ path: '/etc/passwd' }], Array(5).fill(images[0])]) {
    assert.equal((await post({ text: '', images: bad, clientSubmissionId: 'bad' })).status, 400);
  }
  assert.equal(mock.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('storage capacity, MIME mismatch and outside local paths never expose arbitrary files', async t => {
  const mock = await mockDaemon(); t.after(() => mock.close());
  const store = new AttachmentStore(`${mock.directory}/small`, 1);
  await assert.rejects(store.prepare('thread-1', 'small', [await image()]), { code: 'capacity' });
  await assert.rejects(store.prepare('thread-1', 'mismatch', [{ dataUrl: (await image()).dataUrl.replace('image/png', 'image/jpeg') }]), { code: 'input' });
  const result = await store.history('thread-1', { data: [{ item: { type: 'userMessage', content: [{ type: 'localImage', path: '/etc/passwd' }, { type: 'image', url: 'https://evil.example/image' }] } }] });
  assert.deepEqual(result.data[0].item.content, [{ type: 'image' }, { type: 'image' }]);
  await assert.rejects(store.get('../passwd'), { code: 'not-found' });
});
