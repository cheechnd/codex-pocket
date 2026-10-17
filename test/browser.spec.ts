import { test, expect } from '@playwright/test';
test('390px local picker, safe transcript, paging, drafts, live output and reconnect', async ({ page, request }) => {
  await page.goto('/');
  const code = await (await request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click(); await expect(page.getByRole('button', { name: /Scratch conversation/ })).toBeVisible();
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.getByText('Hello from the desktop')).toBeVisible();
  await expect(page.locator('#transcript img')).toHaveCount(0);
  await expect(page.locator('#transcript')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByLabel('Message', { exact: true }).fill('  draft\n unchanged  ');
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect(page.getByText('Earlier history', { exact: true })).toBeVisible();
  await request.get('http://127.0.0.1:44319/change'); await expect(page.getByText('Live desktop update')).toBeVisible();
  await expect(page.getByText('Hello from the desktop')).toHaveCount(0);
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('  draft\n unchanged  ');
  await expect(page.locator('#transcript .agentMessage')).toHaveCount(1);
  await page.context().setOffline(true); await page.context().setOffline(false); await page.reload();
  await page.getByRole('button', { name: /Scratch conversation/ }).click(); await expect(page.getByText('Live desktop update')).toBeVisible();
  const exactText = '  browser message\n🙂 café  ';
  await page.getByLabel('Message', { exact: true }).fill(exactText);
  const outgoing = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/messages'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await outgoing).postDataJSON().text).toBe(exactText);
  await expect(page.getByText('Mock reply', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await expect(page.locator('#submission-status')).toHaveAttribute('data-state', 'completed');
  await expect(page.locator('#submission-status')).toHaveText('');
  await expect(page.locator('#check-submission')).toBeHidden();
  // Delay the first thread's HTTP response while navigating and editing another draft.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/messages', async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
  await page.getByLabel('Message', { exact: true }).fill('first thread text');
  const target = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/messages'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await target).url()).toContain('/thread-1/messages');
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('second thread draft');
  release();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('second thread draft');
  await expect(page.locator('#submission-status')).toHaveText('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});


test('unknown send survives reload, foreground return and offline reconnect without POST retry; unpair clears content', async ({ page, request }) => {
  await page.goto('/');
  const code = await (await request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#activity')).toHaveText('idle');
  await request.get('http://127.0.0.1:44319/timeout');
  const before = await (await request.get('http://127.0.0.1:44319/counts')).json();
  await page.route('**/messages', async route => {
    const response = await route.fetch();
    await request.get('http://127.0.0.1:44319/forget-items');
    await route.fulfill({ response });
  });
  await page.getByLabel('Message', { exact: true }).fill('uncertain message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#submission-status')).toContainText('Outcome unknown');
  await expect(page.locator('#check-submission')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#submission-status')).toContainText('Outcome unknown');
  await expect(page.locator('#check-submission')).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('must stay unsent');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#activity')).toHaveText('idle');
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Check send status', exact: true }).click();
  const after = await (await request.get('http://127.0.0.1:44319/counts')).json();
  expect(after.sends).toBe(before.sends + 1);
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Unpair this device', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pair this device', exact: true })).toBeVisible();
  await expect(page.locator('#transcript')).toBeEmpty();
  expect((await page.request.get('/api/threads')).status()).toBe(401);
  await request.get('http://127.0.0.1:44319/normal');
});


test('external link and reopened browser load public shell while preserving paired session', async ({ page, request, browser }) => {
  await page.goto('http://localhost:44319/launch');
  await page.getByRole('link', { name: 'Open Pocket' }).click();
  await expect(page.getByRole('button', { name: 'Pair this device', exact: true })).toBeVisible();
  const code = await (await request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await expect(page.getByRole('button', { name: /Scratch conversation/ })).toBeVisible();
  const state = await page.context().storageState();
  await page.close();
  const reopened = await browser.newContext({ storageState: state });
  try {
    const tab = await reopened.newPage();
    await tab.goto('http://localhost:44319/launch');
    const navigation = tab.waitForRequest(req => req.isNavigationRequest() && req.url() === 'http://127.0.0.1:44318/');
    await tab.getByRole('link', { name: 'Open Pocket' }).click();
    expect((await (await navigation).allHeaders())['sec-fetch-site']).toBe('cross-site');
    await expect(tab.getByRole('button', { name: /Scratch conversation/ })).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Pair this device', exact: true })).toBeHidden();
    expect((await tab.request.get('http://127.0.0.1:44318/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status()).toBe(403);
  } finally { await reopened.close(); }
});


test('blank loaded sessions are omitted and a real unnamed conversation uses its preview', async ({ page, request }) => {
  await request.get('http://127.0.0.1:44319/picker-fixture');
  await page.goto('/');
  const code = await (await request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  const real = page.getByRole('button', { name: /Real unnamed conversation/ });
  await expect(real).toBeVisible();
  await expect(page.locator('.thread[data-thread-id="thread-1"]')).toHaveCount(0);
  await expect(page.getByText('Untitled conversation', { exact: true })).toHaveCount(0);
  await real.click();
  await expect(page.locator('#title')).toHaveText('Real unnamed conversation');
});

test('Chrome reads the public install manifest before pairing', async ({ page }) => {
  await page.goto('/');
  const session = await page.context().newCDPSession(page);
  await expect.poll(async () => {
    const manifest = await session.send('Page.getAppManifest');
    return manifest.data ? JSON.parse(manifest.data).name : null;
  }).toBe('Codex Pocket');
  const manifest = await session.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  const { installabilityErrors } = await session.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
  for (const size of [192, 512]) {
    const response = await page.request.get(`/icon-${size}.png`);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toBe('image/png');
  }
  expect((await page.request.get('/api/threads')).status()).toBe(401);
});
