import { expect, test, type Page, type Route } from '@playwright/test';

const thread = {
  id: 'new-thread', name: 'New project chat', preview: 'First message', cwd: '/home/test/dev/new-project',
  status: { type: 'idle', activeFlags: [] }, updatedAt: 1_700_000_100, recencyAt: 1_700_000_100,
};

async function mockApp(page: Page, options: { directories?: string[]; defaultParent?: string } = {}) {
  let threads: unknown[] = [];
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true } }));
  await page.route('**/api/status', route => route.fulfill({ json: { connection: 'connected', canAttachImages: false, canBrowseHistory: false } }));
  await page.route('**/api/submissions', route => route.fulfill({ json: [] }));
  await page.route('**/api/submissions/*', route => route.fulfill({ json: { id: 'submission-1', threadId: 'new-thread', state: 'accepted', turnId: 'turn-1' } }));
  await page.route('**/api/threads', route => route.fulfill({ json: threads }));
  await page.route('**/api/new-session/*', route => route.fulfill({ status: 404, json: { error: 'not-found', message: 'not retained' } }));
  await page.route('**/api/new-session/options', route => route.fulfill({ json: { directories: options.directories ?? ['/home/test/dev', '/home/test/work'], defaultParent: options.defaultParent ?? '/home/test/dev' } }));
  await page.route('**/api/threads/*/events', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' }));
  await page.route('**/api/threads/*/history*', route => route.fulfill({ json: { thread, blocked: false, data: [], nextCursor: null } }));
  await page.goto('/');
  return { setThreads: (next: unknown[]) => { threads = next; } };
}

async function openNewChat(page: Page) {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New chat', exact: true })).toBeVisible();
  // The dialog appears before its directory suggestions finish loading.
  await expect(page.locator('#new-session-directory')).toHaveValue(/^\//);
}

async function chooseRecent(page: Page) {
  await page.locator('#new-session-directories button').first().click();
}

test('starts an existing-folder chat with exact text and persists before POST', async ({ page }) => {
  const app = await mockApp(page);
  let requestBody: Record<string, unknown> | undefined;
  let requestHeader: string | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/new-session', async route => {
    requestBody = route.request().postDataJSON(); requestHeader = route.request().headers()['x-pocket-request'];
    expect(await page.evaluate(() => localStorage.getItem('pocket-new-session-v1'))).toContain(String(requestBody?.clientRequestId));
    await gate;
    app.setThreads([thread]);
    await route.fulfill({ json: { id: requestBody!.clientRequestId, state: 'created', cwd: thread.cwd, thread, submission: { id: 'submission-1', threadId: thread.id, state: 'accepted', turnId: 'turn-1' } } });
  });
  await openNewChat(page);
  await chooseRecent(page);
  await expect(page.locator('#new-session-directory')).toHaveValue('/home/test/dev');
  await page.locator('#new-session-text').fill('  Build this exactly\n🙂  ');
  const post = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/new-session'));
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeDisabled();
  release();
  await post;
  expect(requestHeader).toBe('1');
  expect(requestBody).toMatchObject({ directory: '/home/test/dev', text: '  Build this exactly\n🙂  ' });
  expect(requestBody?.newDirectoryName).toBeUndefined();
  await expect(page.getByRole('region', { name: 'New chat', exact: true })).toBeHidden();
  await expect(page.locator('#title')).toHaveText('New project chat');
  expect(await page.evaluate(() => localStorage.getItem('pocket-new-session-v1'))).toBeNull();
});

test('new-folder selection sends one child name only on explicit send', async ({ page }) => {
  await mockApp(page, { defaultParent: '/home/test/work' });
  let body: Record<string, unknown> | undefined;
  await page.route('**/api/new-session', async route => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { id: body!.clientRequestId, state: 'failed', message: 'Directory rejected' } });
  });
  await openNewChat(page);
  await page.getByRole('button', { name: '＋ New folder', exact: true }).click();
  await expect(page.locator('#new-session-directory')).toHaveValue('/home/test/work');
  await page.locator('#new-session-folder').fill('one-child');
  await page.getByRole('button', { name: 'Use folder', exact: true }).click();
  await page.locator('#new-session-text').fill('Initial instruction');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page.getByText('Directory rejected')).toBeVisible();
  expect(body).toMatchObject({ directory: '/home/test/work', newDirectoryName: 'one-child', text: 'Initial instruction' });
  expect(await page.evaluate(() => localStorage.getItem('pocket-new-session-v1'))).toContain('one-child');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});

test('missing retained record stays locked and never retries creation', async ({ page }) => {
  await mockApp(page);
  const id = '11111111-1111-4111-8111-111111111111';
  await page.evaluate(({ id }) => localStorage.setItem('pocket-new-session-v1', JSON.stringify({ requestId: id, directory: '/home/test/dev', text: 'do not resend', state: 'creating' })), { id });
  await page.reload();
  await openNewChat(page);
  await expect(page.getByText(/status is unavailable|Creation status is unavailable/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeDisabled();
  let posts = 0;
  await page.route('**/api/new-session', route => { posts++; return route.fulfill({ status: 500, json: { message: 'must not be called' } }); });
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect.poll(() => posts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('pocket-new-session-v1'))).toContain(id);
});

test('projects are directly selectable and Change preserves the first message', async ({ page }) => {
  await mockApp(page); await openNewChat(page);
  await expect(page.locator('#new-session-text')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeDisabled();
  await chooseRecent(page);
  await page.locator('#new-session-text').fill('Keep my instruction');
  await page.getByRole('button', { name: 'Change project', exact: true }).click();
  await expect(page.locator('#new-session-directories')).toBeVisible();
  await page.locator('#new-session-directories button').nth(1).click();
  await expect(page.locator('#new-session-directory')).toHaveValue('/home/test/work');
  await expect(page.locator('#new-session-text')).toHaveValue('Keep my instruction');
  await page.keyboard.press('Escape'); await openNewChat(page);
  await expect(page.locator('#new-session-text')).toHaveValue('Keep my instruction');
  await expect(page.locator('#new-session-project-name')).toHaveText('work');
});

test('another folder exposes a manual path and new-folder location can be changed', async ({ page }) => {
  await mockApp(page); await openNewChat(page);
  await page.getByRole('button', { name: 'Use another folder…', exact: true }).click();
  await expect(page.locator('#new-session-directory')).toBeVisible();
  await page.locator('#new-session-directory').fill('/tmp/my-project');
  await page.getByRole('button', { name: 'Use folder', exact: true }).click();
  await expect(page.locator('#new-session-project-name')).toHaveText('my-project');
  await page.getByRole('button', { name: 'Change project', exact: true }).click();
  await page.getByRole('button', { name: '＋ New folder', exact: true }).click();
  await page.locator('#new-session-directory').fill('/tmp/projects');
  await expect(page.locator('#new-session-folder')).toBeVisible();
  await expect(page.locator('#new-session-directory-label')).toHaveText('Inside');
});

test('known validation failure keeps the fields and retries only after an explicit click with a new ID', async ({ page }) => {
  const app = await mockApp(page);
  const bodies: any[] = [];
  await page.route('**/api/new-session', async route => {
    const body = route.request().postDataJSON(); bodies.push(body);
    if (bodies.length === 1) return route.fulfill({ status: 400, json: { message: 'Choose an absolute directory' } });
    app.setThreads([thread]);
    return route.fulfill({ json: { id: body.clientRequestId, state: 'created', thread, submission: { id: 'first-1', threadId: thread.id, state: 'accepted', turnId: 'turn-1' } } });
  });
  await openNewChat(page); await chooseRecent(page); await page.locator('#new-session-text').fill('  Keep my first instruction\n🙂  ');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page.getByText('Choose an absolute directory', { exact: true })).toBeVisible();
  await expect(page.locator('#new-session-text')).toHaveValue('  Keep my first instruction\n🙂  ');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New chat', exact: true })).toBeHidden();
  expect(bodies.length).toBe(2); expect(bodies[0].clientRequestId).not.toBe(bodies[1].clientRequestId);
  expect(bodies[1].text).toBe(bodies[0].text);
});

for (const outcome of ['outcome-unknown', 'failed'] as const) test(`known thread with ${outcome} first message preserves text and the correct composer lock`, async ({ page }) => {
  const app = await mockApp(page); let posts = 0;
  const firstText = '  First instruction is preserved\n🙂  ';
  await page.route('**/api/new-session', route => {
    posts++; app.setThreads([thread]);
    return route.fulfill({ json: { id: route.request().postDataJSON().clientRequestId, state: 'created', thread, submission: { id: 'first-unknown', threadId: thread.id, state: outcome, message: 'Synthetic first message result' } } });
  });
  await page.route('**/api/submissions/first-unknown', route => route.fulfill({ json: { id: 'first-unknown', threadId: thread.id, state: outcome } }));
  await openNewChat(page); await chooseRecent(page); await page.locator('#new-session-text').fill(firstText);
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'New chat', exact: true })).toBeHidden();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(firstText);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ enabled: outcome === 'failed' });
  if (outcome === 'outcome-unknown') {
    await page.reload(); await page.getByRole('button', { name: /New project chat/ }).click();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue(firstText);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  }
  expect(posts).toBe(1);
});

test('unpairing during creation closes and clears the form and ignores its late response', async ({ page }) => {
  await mockApp(page); let pending: Route | undefined;
  await page.route('**/api/new-session', route => { pending = route; });
  await page.route('**/api/logout', route => route.fulfill({ json: { authenticated: false } }));
  await openNewChat(page); await chooseRecent(page); await page.locator('#new-session-text').fill('Clear this on unpair');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.locator('#new-session-close').click();
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Unpair this device', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pair this device', exact: true })).toBeVisible();
  await pending!.fulfill({ json: { id: pending!.request().postDataJSON().clientRequestId, state: 'created', thread, submission: { id: 'late-1', threadId: thread.id, state: 'accepted', turnId: 'turn-1' } } });
  await expect(page.locator('#new-session-text')).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('pocket-new-session-v1'))).toBeNull();
  await expect(page.locator('#conversation')).toBeHidden();
});

for (const width of [390, 1024]) test(`new-chat pane fits at ${width}px and Escape preserves its fields`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: width === 390 ? 'light' : 'dark' });
  await mockApp(page); await openNewChat(page);
  await page.screenshot({ path: `.local/new-session-chooser-${width}.png` });
  await page.getByRole('button', { name: '＋ New folder', exact: true }).click();
  await page.locator('#new-session-folder').fill('my-new-project');
  await page.getByRole('button', { name: 'Use folder', exact: true }).click();
  await page.locator('#new-session-text').fill('Help me build a useful app.');
  const bounds = (await page.getByRole('region', { name: 'New chat', exact: true }).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: `.local/new-session-${width}.png` });
  await page.keyboard.press('Escape'); await openNewChat(page);
  await expect(page.locator('#new-session-folder')).toHaveValue('my-new-project');
  await expect(page.locator('#new-session-text')).toHaveValue('Help me build a useful app.');
});

test('new-chat draft survives refresh and project selection never sends or opens an editor', async ({ page }) => {
  await mockApp(page); await openNewChat(page);
  let posts = 0;
  await page.route('**/api/new-session', route => { posts++; return route.fulfill({ status: 500 }); });
  await page.locator('#new-session-text').fill('  Draft before choosing\n🙂  ');
  await chooseRecent(page);
  await expect(page.locator('#new-session-change')).toBeFocused();
  await page.reload(); await openNewChat(page);
  await expect(page.locator('#new-session-text')).toHaveValue('  Draft before choosing\n🙂  ');
  await expect(page.locator('#new-session-project-name')).toHaveText('dev');
  expect(posts).toBe(0);
});

test('late options do not steal focus or overwrite a manually entered path', async ({ page }) => {
  await mockApp(page);
  let pending: Route | undefined;
  await page.route('**/api/new-session/options', route => { pending = route; });
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Use another folder…', exact: true }).click();
  await page.locator('#new-session-directory').fill('/tmp/typed-path');
  await expect.poll(() => Boolean(pending)).toBe(true);
  await pending!.fulfill({ json: { directories: ['/tmp/recent'], defaultParent: '/tmp/default' } });
  await expect(page.locator('#new-session-directories button')).toHaveCount(1);
  await expect(page.locator('#new-session-directory')).toHaveValue('/tmp/typed-path');
  await expect(page.locator('#new-session-directory')).toBeFocused();
});

test('leaving during creation does not navigate away when the result arrives', async ({ page }) => {
  const app = await mockApp(page); let pending: Route | undefined;
  await page.route('**/api/new-session', route => { pending = route; });
  await openNewChat(page); await chooseRecent(page);
  await page.locator('#new-session-text').fill('Start only once');
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'list');
  app.setThreads([thread]);
  await pending!.fulfill({ json: { id: pending!.request().postDataJSON().clientRequestId, state: 'created', thread, submission: { id: 'later-1', threadId: thread.id, state: 'accepted', turnId: 'turn-1' } } });
  await expect(page.getByRole('button', { name: /New project chat/ })).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'list');
  expect(await page.evaluate(() => localStorage.getItem('pocket-new-session-v1'))).toBeNull();
});

test('folder editing and the composer stay inside a reduced keyboard viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 450 });
  await mockApp(page); await openNewChat(page);
  await page.getByRole('button', { name: '＋ New folder', exact: true }).click();
  await page.locator('#new-session-folder').fill('keyboard-project');
  await page.locator('#new-session-directory').fill('/tmp/projects');
  const editor = await page.locator('#new-session-folder-editor').boundingBox();
  expect(editor?.width).toBeLessThanOrEqual(390);
  const input = (await page.locator('.new-chat-input').boundingBox())!;
  expect(input.y + input.height).toBeLessThanOrEqual(450);
  await page.getByRole('button', { name: 'Use folder', exact: true }).click();
  await page.locator('#new-session-text').fill('Keyboard draft');
  const send = (await page.locator('#new-session-start').boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(450);
});
