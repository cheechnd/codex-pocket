import { expect, test, type Page } from '@playwright/test';

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const threads = [
  { id: 'image-thread-1', name: 'Image thread one', preview: 'Synthetic image fixture', cwd: '/scratch/images', updatedAt: 1_700_000_000, recencyAt: 1_700_000_000, status: { type: 'idle', activeFlags: [] } },
  { id: 'image-thread-2', name: 'Image thread two', preview: 'Second isolated thread', cwd: '/scratch/images', updatedAt: 1_700_000_001, recencyAt: 1_700_000_001, status: { type: 'idle', activeFlags: [] } },
];

function entry(turn: number, item: Record<string, unknown>) {
  return { turnId: `image-turn-${turn}`, item: { id: `image-item-${turn}`, ...item } };
}

function history(threadId: string, data: unknown[] = []) {
  const thread = threads.find(candidate => candidate.id === threadId) ?? threads[0];
  return { thread, blocked: false, data, nextCursor: null };
}

async function installIsolatedRoutes(page: Page, options: { canAttachImages?: boolean } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let pendingSubmission: Record<string, unknown> | undefined;
  await page.route('**/api/status', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ connection: 'connected', canAttachImages: options.canAttachImages ?? true }),
  }));
  await page.route('**/api/submissions', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(pendingSubmission ? [pendingSubmission] : []) }));
  await page.route('**/api/threads', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(threads) }));
  await page.route('**/api/threads/*/history*', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(history(id, [entry(1, { type: 'agentMessage', text: 'Synthetic isolated history' })])) });
  });
  await page.route('**/api/threads/*/events', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: 'event: ready\ndata: {}\n\n',
  }));
  await page.route('**/api/submissions/*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(pendingSubmission ?? { error: 'not-found', message: 'not found' }),
    status: pendingSubmission ? 200 : 404,
  }));
  await page.route('**/api/threads/*/messages', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ url: route.request().url(), body });
    const result = { id: body.clientSubmissionId, threadId: route.request().url().split('/threads/')[1].split('/')[0], state: 'completed', turnId: `image-turn-${requests.length}` };
    pendingSubmission = result;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  return { requests, setPending: (record: Record<string, unknown>) => { pendingSubmission = record; } };
}

async function pair(page: Page, request: { get(url: string): Promise<{ text(): Promise<string> }> }) {
  await page.goto('/');
  const code = await (await request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await expect(page.getByRole('button', { name: /Image thread one/ })).toBeVisible();
}

async function openThread(page: Page, name = 'Image thread one', expectedHistory = 'Synthetic isolated history') {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByText(expectedHistory, { exact: true })).toBeVisible();
}

test('image-only file picker sends an exact image payload and text+image paste does not auto-send', async ({ page, request }) => {
  const isolated = await installIsolatedRoutes(page);
  await pair(page, request); await openThread(page);

  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach images', exact: true }).click();
  await (await picker).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: png1x1 });
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect(isolated.requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#submission-status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#submission-status')).toHaveText('');
  await expect(page.locator('#check-submission')).toBeHidden();
  expect(isolated.requests[0].body).toMatchObject({ text: '', images: [{ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }] });

  const clipboard = await page.evaluate((base64) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '  pasted exact text\n🙂  ');
    transfer.items.add(new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], 'pasted.png', { type: 'image/png' }));
    document.getElementById('draft')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
    return (document.getElementById('draft') as HTMLTextAreaElement).value;
  }, png1x1.toString('base64'));
  expect(clipboard).toBe('  pasted exact text\n🙂  ');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('  pasted exact text\n🙂  ');
  expect(isolated.requests).toHaveLength(1);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#submission-status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#submission-status')).toHaveText('');
  await expect(page.locator('#check-submission')).toBeHidden();
  expect(isolated.requests).toHaveLength(2);
  expect(isolated.requests[1].body).toMatchObject({ text: '  pasted exact text\n🙂  ', images: [{ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }] });
  expect(isolated.requests[1].body.clientSubmissionId).toEqual(expect.any(String));
});

test('previews can be removed, image drafts stay with their thread, and files respect count/decoded/source limits', async ({ page, request }) => {
  await installIsolatedRoutes(page); await pair(page, request); await openThread(page);
  await page.getByLabel('Message', { exact: true }).fill('draft belongs to thread one');
  await page.locator('#image-input').setInputFiles({ name: 'thread-one.png', mimeType: 'image/png', buffer: png1x1 });
  await expect(page.getByRole('button', { name: 'Remove image thread-one.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove image thread-one.png', exact: true }).click();
  await expect(page.locator('#attachments img')).toHaveCount(0);
  await page.locator('#image-input').setInputFiles({ name: 'thread-one.png', mimeType: 'image/png', buffer: png1x1 });
  await page.getByRole('button', { name: '← Conversations' }).click();
  await openThread(page, 'Image thread two');
  await page.getByLabel('Message', { exact: true }).fill('draft belongs to thread two');
  await page.locator('#image-input').setInputFiles({ name: 'thread-two.png', mimeType: 'image/png', buffer: png1x1 });
  await page.getByRole('button', { name: '← Conversations' }).click();
  await openThread(page);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('draft belongs to thread one');
  await expect(page.getByRole('button', { name: 'Remove image thread-one.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Conversations' }).click(); await openThread(page, 'Image thread two');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('draft belongs to thread two');
  await expect(page.getByRole('button', { name: 'Remove image thread-two.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove image thread-two.png', exact: true }).click();

  await page.locator('#image-input').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: png1x1 }, { name: 'two.png', mimeType: 'image/png', buffer: png1x1 },
    { name: 'three.png', mimeType: 'image/png', buffer: png1x1 }, { name: 'four.png', mimeType: 'image/png', buffer: png1x1 }, { name: 'five.png', mimeType: 'image/png', buffer: png1x1 },
  ]);
  await expect(page.locator('#attachments img')).toHaveCount(0);
  await expect(page.locator('#error')).toContainText('up to 4');
  await page.locator('#image-input').setInputFiles(Array.from({ length: 4 }, (_, i) => ({ name: `valid-${i}.png`, mimeType: 'image/png', buffer: png1x1 })));
  await expect(page.locator('#attachments img')).toHaveCount(4);
  for (;;) {
    const remove = page.locator('#attachments [aria-label^="Remove image "]').first();
    if (!(await remove.count())) break;
    await remove.click();
  }
  await expect(page.locator('#attachments img')).toHaveCount(0);
  await page.locator('#image-input').setInputFiles({ name: 'over-20MiB-invalid.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(page.locator('#attachments img')).toHaveCount(0);
});

test('image attachment capability is gated by backend status', async ({ page, request }) => {
  await installIsolatedRoutes(page, { canAttachImages: false }); await pair(page, request); await openThread(page);
  const attach = page.getByRole('button', { name: 'Attach images', exact: true });
  if (await attach.count()) await expect(attach).toBeDisabled();
  const input = page.locator('#image-input');
  if (await input.count()) await expect(input).toBeHidden();
});

test('unknown image send preserves the draft and does not blindly resend; unsafe history URLs are inert', async ({ page, request }) => {
  const isolated = await installIsolatedRoutes(page);
  const unsafeHistory = 'https://unsafe.example.invalid/remote.png data:image/png;base64,AAAA file:///tmp/private.png';
  await page.route('**/api/threads/*/history*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(history('image-thread-1', [entry(1, { type: 'userMessage', content: [{ type: 'text', text: unsafeHistory }, { type: 'image', url: 'https://unsafe.example.invalid/remote.png' }, { type: 'image', url: 'data:image/png;base64,AAAA' }, { type: 'localImage', path: '/tmp/private.png' }] })])) }));
  await pair(page, request); await openThread(page, 'Image thread one', unsafeHistory);
  const initialRequests = isolated.requests.length;
  await page.getByLabel('Message', { exact: true }).fill('keep this exact with image');
  await page.locator('#image-input').setInputFiles({ name: 'unknown.png', mimeType: 'image/png', buffer: png1x1 });
  await page.route('**/api/threads/*/messages', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    isolated.setPending({
      id: body.clientSubmissionId,
      threadId: 'image-thread-1',
      state: 'outcome-unknown',
      message: 'Outcome unknown. Check send status; do not resend.',
    });
    await route.abort('failed'); // one ambiguous write, never a retry
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#submission-status')).toContainText('Outcome unknown');
  await expect(page.locator('#check-submission')).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('keep this exact with image');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await page.reload(); await openThread(page, 'Image thread one', unsafeHistory);
  await expect(page.locator('#submission-status')).toContainText('Outcome unknown');
  await expect(page.locator('#check-submission')).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('keep this exact with image');
  await expect(page.locator('#attachments img')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pocket-drafts-v1'))).not.toContain('data:image');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  expect(isolated.requests.length).toBe(initialRequests);
  await expect(page.locator('#transcript img')).toHaveCount(0);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('unsafe.example.invalid')))).toBe(false);
});

test('rejected image send keeps its draft; acceptance after navigation clears only the captured conversation', async ({ page, request }) => {
  const isolated = await installIsolatedRoutes(page); await pair(page, request); await openThread(page);
  await page.locator('#draft').fill('original exact text');
  await page.locator('#image-input').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: png1x1 });
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await page.route('**/api/threads/*/messages', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'input', message: 'Synthetic rejection' }) }));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#submission-status')).toHaveText('Synthetic rejection');
  await expect(page.locator('#draft')).toHaveValue('original exact text');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured: any;
  await page.route('**/api/threads/*/messages', async route => {
    captured = route.request().postDataJSON(); await gate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: captured.clientSubmissionId, threadId: 'image-thread-1', state: 'completed', turnId: 'captured-turn' }) });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => captured).toBeTruthy();
  await page.getByRole('button', { name: '← Conversations' }).click(); await openThread(page, 'Image thread two');
  await page.locator('#draft').fill('second thread draft');
  await page.locator('#image-input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: png1x1 });
  await expect(page.locator('#attachments img')).toHaveCount(1);
  release();
  await expect(page.locator('#draft')).toHaveValue('second thread draft');
  await expect(page.getByRole('button', { name: 'Remove image second.png', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Conversations' }).click(); await openThread(page);
  await expect(page.locator('#draft')).toHaveValue('');
  await expect(page.locator('#attachments img')).toHaveCount(0);
  expect(captured.text).toBe('original exact text'); expect(captured.images).toHaveLength(1);
  expect(isolated.requests).toHaveLength(0); // More specific routes handled these sends.
});
