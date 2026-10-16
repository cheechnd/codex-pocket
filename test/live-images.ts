/** Opt-in vision integration: only a newly created isolated conversation and synthetic image. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import sharp from 'sharp';
import { chromium } from '@playwright/test';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { AccessControl } from '../src/server/access.js';
import { AttachmentStore } from '../src/server/attachments.js';
import { createApp } from '../src/server/app.js';
const socket = process.env.CODEX_DAEMON_SOCKET;
if (!socket || !isAbsolute(socket)) throw new Error('Explicit daemon socket required');
await mkdir('.local', { recursive: true });
const cwd = await mkdtemp(resolve('.local/image-sandbox-'));
await writeFile(resolve(cwd, 'AGENTS.md'), '# Disposable image test\nNever use tools or delegate. Answer only the visual question.\n');
const owner = new Transport(socket), adapter = new DaemonAdapter(new Transport(socket));
const access = new AccessControl(resolve(cwd, 'access'));
const app = createApp(adapter, 44322, { access, attachments: new AttachmentStore(resolve(cwd, 'images')), webRoot: new URL('../dist/src/web/', import.meta.url) });
let browser;
function completion(threadId: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { owner.off('notice', notice); reject(new Error('Isolated turn timeout')); }, 120_000);
    function notice(event: any) { if (event.method === 'turn/completed' && event.params.threadId === threadId) { clearTimeout(timer); owner.off('notice', notice); event.params.turn.status === 'completed' ? resolve() : reject(new Error('Isolated turn failed')); } }
    owner.on('notice', notice);
  });
}
try {
  await owner.connect(); await adapter.transport.connect();
  const { thread } = await owner.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Isolated visual input test. No tools, file access or delegation. Answer only the requested question.' });
  let done = completion(thread.id);
  await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply READY.', text_elements: [] }] }, true); await done;
  await new Promise<void>(resolve => app.server.listen(44322, '127.0.0.1', resolve));
  browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(app.origin); await page.getByLabel('Pairing code').fill(access.pairingCode()); await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await page.locator('#filter').fill(cwd); await page.locator(`.thread[data-thread-id="${thread.id}"]`).click();
  const buffer = await sharp({ create: { width: 1179, height: 2556, channels: 3, background: '#00cc00' } }).png().toBuffer();
  await page.locator('#image-input').setInputFiles({ name: 'synthetic-phone-screenshot.png', mimeType: 'image/png', buffer });
  await page.locator('#attachments img').waitFor();
  await page.locator('#draft').fill('What is the dominant color of the attached image? Reply with only the color name.');
  done = completion(thread.id);
  const response = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/messages'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const accepted = await (await response).json(); if (!accepted.turnId) throw new Error('Image submission was not accepted');
  await done;
  const history = await adapter.history(thread.id);
  const reply = history.data.find(e => e.turnId === accepted.turnId && e.item.type === 'agentMessage');
  if (!/^green[.!]?$/i.test(reply?.item.text?.trim() ?? '')) throw new Error('Vision response did not identify synthetic color');
  const user = history.data.find(e => e.item.clientId === accepted.id);
  const kinds = user?.item.content?.map(c => c.type) ?? [];
  console.log(JSON.stringify({ check: 'live-image', vision: 'pass', contentKinds: kinds, frameBytes: JSON.stringify(user).length }));
  await page.reload(); await page.locator('#filter').fill(cwd); await page.locator(`.thread[data-thread-id="${thread.id}"]`).click();
  await page.locator('#transcript .message-image').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('#transcript .message-image')].every(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: '.local/live-image-browser.png' });
  console.log('PASS authenticated browser upload, phone-size screenshot, actual vision response, reload image history');
} finally { await browser?.close(); if (app.server.listening) await app.close(); else adapter.close(); owner.close(); }
