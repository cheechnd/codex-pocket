/** Opt-in historical activation check. All mutations are confined to one newly created scratch thread. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { chromium } from '@playwright/test';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { AccessControl } from '../src/server/access.js';
import { createApp } from '../src/server/app.js';
const socket = process.env.CODEX_DAEMON_SOCKET;
if (!socket || !isAbsolute(socket)) throw new Error('Select existing daemon socket explicitly');
await mkdir('.local', { recursive: true });
const cwd = await mkdtemp(resolve('.local/saved-sandbox-'));
await writeFile(resolve(cwd, 'AGENTS.md'), '# Isolated history test\nNo tools, file access or delegation. Reply only READY.\n');
const owner = new Transport(socket), transport = new Transport(socket), adapter = new DaemonAdapter(transport);
const access = new AccessControl(resolve(cwd, 'access'));
const app = createApp(adapter, 44324, { access, webRoot: new URL('../dist/src/web/', import.meta.url) });
let browser;
const calls: { method: string; params: any }[] = [];
const request = transport.request.bind(transport);
transport.request = ((method: string, params: object = {}, write = false) => { calls.push({ method, params }); return request(method, params, write); }) as typeof transport.request;
try {
  await owner.connect(); await transport.connect();
  const { thread } = await owner.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Isolated history integration test. No tools or delegation. Reply only READY.' });
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { owner.off('notice', notice); reject(new Error('Seed timed out')); }, 120_000);
    function notice(event: any) { if (event.method === 'turn/completed' && event.params.threadId === thread.id) { clearTimeout(timer); owner.off('notice', notice); event.params.turn.status === 'completed' ? resolve() : reject(new Error('Seed failed')); } }
    owner.on('notice', notice);
  });
  await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply READY.', text_elements: [] }] }, true); await done;
  const title = `Pocket saved test ${cwd.split('/').at(-1)}`;
  await owner.request('thread/name/set', { threadId: thread.id, name: title });
  // Force this disposable fixture into saved/unloaded state, without touching work threads.
  await owner.request('thread/archive', { threadId: thread.id });
  await owner.request('thread/unarchive', { threadId: thread.id });
  if ((await adapter.loadedIds()).includes(thread.id)) throw new Error('Isolated saved fixture still loaded');
  const saved = await adapter.saved(undefined, title);
  if (!saved.data.some(t => t.id === thread.id && !t.loaded)) throw new Error('Saved search did not find isolated unloaded fixture');
  if (calls.some(call => call.method === 'thread/resume')) throw new Error('Browsing unexpectedly loaded a conversation');
  await new Promise<void>(resolve => app.server.listen(44324, '127.0.0.1', resolve));
  browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(app.origin); await page.getByLabel('Pairing code').fill(access.pairingCode()); await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await page.locator('#scope-all').click(); await page.locator('#filter').fill(title);
  await page.locator(`.thread[data-thread-id="${thread.id}"]`).waitFor();
  if (calls.some(call => call.method === 'thread/resume')) throw new Error('UI search unexpectedly loaded a conversation');
  await page.locator(`.thread[data-thread-id="${thread.id}"]`).click();
  await page.locator('#transcript').getByText(/^READY\.?$/, { exact: true }).waitFor();
  const resumes = calls.filter(call => call.method === 'thread/resume');
  if (resumes.length !== 1 || JSON.stringify(resumes[0].params) !== JSON.stringify({ threadId: thread.id, excludeTurns: true })) throw new Error('Open did not use exactly one metadata-only ID resume');
  if (calls.some(call => /^(turn\/start|thread\/(start|fork))$/.test(call.method))) throw new Error('Historical opening started new work');
  await page.screenshot({ path: '.local/live-saved-browser.png' });
  await page.reload();
  if (calls.filter(call => call.method === 'thread/resume').length !== 1) throw new Error('Reload automatically activated a conversation');
  console.log('PASS live saved search without activation, explicit browser open, one ID-only resume, bounded original history, no new turn/fork or reload activation');
} finally { await browser?.close(); if (app.server.listening) await app.close(); else adapter.close(); owner.close(); }
