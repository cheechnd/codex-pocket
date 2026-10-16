import { AccessControl } from '../src/server/access.js';
/** Explicit opt-in: creates one disposable thread and one seed model turn. */
import { mkdir, writeFile, mkdtemp, access as fileExists, rm } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { Transport } from '../src/daemon/transport.js';
import { DaemonAdapter } from '../src/daemon/adapter.js';
import { createApp } from '../src/server/app.js';
import { chromium } from '@playwright/test';

const socket = process.env.CODEX_DAEMON_SOCKET;
if (!socket || !isAbsolute(socket)) throw new Error('Select CODEX_DAEMON_SOCKET explicitly');
await mkdir('.local', { recursive: true });
const cwd = await mkdtemp(resolve('.local/live-sandbox-'));
await rm('.local/live-cli-ready', { force: true });
await writeFile(resolve(cwd, 'AGENTS.md'), '# Disposable Codex Pocket test\nNever use tools, read files, change files, or delegate. Reply only with the exact requested marker.\n');
const owner = new Transport(socket); const adapter = new DaemonAdapter(new Transport(socket));
const access = new AccessControl(resolve(cwd, 'access'));
const app = createApp(adapter, 44320, { access });
let browser;
try {
  await owner.connect(); await adapter.transport.connect();
  const { thread } = await owner.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Disposable connectivity test. No tools or delegation. Reply only with requested marker.' });
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { owner.off('notice', handler); reject(new Error('Seed turn timed out')); }, 120_000);
    function handler(event: any) { if (event.method === 'turn/completed' && event.params.threadId === thread.id) { clearTimeout(timer); owner.off('notice', handler); event.params.turn.status === 'completed' ? resolve() : reject(new Error('Seed failed')); } }
    owner.on('notice', handler);
  });
  await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply exactly POCKET_LOCAL_READY. Do not use tools.', text_elements: [] }] }, true);
  await done;
  await new Promise<void>(resolve => app.server.listen(44320, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(app.origin);
  await page.getByLabel('Pairing code').fill(access.pairingCode());
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await page.waitForFunction(id => document.querySelectorAll('.thread').length > 0, thread.id);
  // Choose by loaded ID via adapter metadata, then filter the rendered picker by unique sandbox cwd.
  await page.locator('#filter').fill(cwd);
  await page.locator(`.thread[data-thread-id="${thread.id}"]`).click();
  await page.getByText('POCKET_LOCAL_READY', { exact: true }).waitFor();
  await page.screenshot({ path: '.local/live-browser.png', fullPage: true });
  console.log(`PASS live browser: bounded scratch history, 390px UI, subscription to ${thread.id}`);
  await writeFile('.local/live-thread.json', JSON.stringify({ id: thread.id, cwd }));
  if (process.env.POCKET_WAIT_FOR_CLI === '1') {
    console.log('Waiting for CLI attachment; create .local/live-cli-ready once the scratch CLI is idle (120 seconds)');
    const deadline = Date.now() + 120_000;
    while (true) {
      try { await fileExists('.local/live-cli-ready'); break; } catch { /* Wait for test driver. */ }
      if (Date.now() > deadline) throw new Error('CLI attach timeout');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const webText = '  Reply exactly POCKET_WEB_SEND.\nDo not use tools.  ';
  const webComplete = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { owner.off('notice', handler); reject(new Error('Web turn timeout')); }, 120_000);
    function handler(event: any) { if (event.method === 'turn/completed' && event.params.threadId === thread.id) { clearTimeout(timer); owner.off('notice', handler); event.params.turn.status === 'completed' ? resolve() : reject(new Error('Web turn failed')); } }
    owner.on('notice', handler);
  });
  await page.locator('#draft').fill(webText);
  const response = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/messages'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const accepted = await (await response).json();
  if (!accepted.turnId) throw new Error(`Web submission not accepted: ${accepted.state ?? accepted.error}`);
  // Drop the browser during work; never resubmit on reconnect.
  await page.reload(); await page.locator('#filter').fill(cwd);
  await page.locator(`.thread[data-thread-id="${thread.id}"]`).click();
  await webComplete;
  await page.getByText('POCKET_WEB_SEND', { exact: true }).waitFor();
  const history = await adapter.history(thread.id);
  const submitted = history.data.filter(e => e.item.type === 'userMessage' && e.item.clientId === accepted.id);
  if (submitted.length !== 1 || submitted[0].item.content?.[0]?.text !== webText) throw new Error('Exact-text/client-ID history correlation failed');
  if ((await adapter.submission(accepted.id)).state !== 'completed') throw new Error('Submission ledger did not complete');
  console.log('PASS browser send, exact multiline text, shared owner completion, reload without duplicate, client-ID correlation');
  if (process.env.POCKET_WAIT_FOR_CLI === '1') {
    console.log('Waiting for disposable CLI turn POCKET_CLI_NEXT (120 seconds)');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { adapter.off('event', handler); reject(new Error('CLI turn timeout')); }, 120_000);
      function handler(event: any) {
        if (event.method === 'item/completed' && event.params.threadId === thread.id && event.params.item?.type === 'agentMessage' && event.params.item.text?.includes('POCKET_CLI_NEXT')) {
          clearTimeout(timer); adapter.off('event', handler); resolve();
        }
      }
      adapter.on('event', handler);
    });
    await page.getByText('POCKET_CLI_NEXT', { exact: true }).waitFor();
    console.log('PASS live CLI turn appears in browser on same thread');
    await browser.close(); browser = undefined; await app.close();
    const { thread: read } = await owner.request('thread/read', { threadId: thread.id });
    if (read.status.type !== 'idle') throw new Error('Scratch thread did not remain idle after web disconnect');
    console.log('PASS browser/backend shutdown leaves original client usable and thread idle');
  }
  console.log('PASS local send acceptance under user-approved single-device assumption');
} finally {
  await browser?.close(); if (app.server.listening) await app.close(); else adapter.close(); owner.close();
}
