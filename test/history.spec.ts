import { expect, test, type Page, type Route } from '@playwright/test';

const loaded = { id: 'loaded-1', name: 'Loaded chat', preview: 'Already here', cwd: '/scratch/loaded', updatedAt: 10, recencyAt: 10, status: { type: 'idle', activeFlags: [] } };
const saved = (id: string, name: string, loadedFlag = false) => ({ id, name, preview: `${name} preview`, cwd: `/scratch/${id}`, updatedAt: 10, recencyAt: 10, status: { type: 'idle', activeFlags: [] }, loaded: loadedFlag });

async function setup(page: Page, browse = true) {
  await page.route('**/api/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ connection: 'connected', canBrowseHistory: browse }) }));
  await page.route('**/api/threads', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([loaded]) }));
  await page.route('**/api/threads/*/events', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' }));
  await page.route('**/api/threads/*/history*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ thread: loaded, blocked: false, data: [], nextCursor: null }) }));
  await page.goto('/');
  const code = await (await page.request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await expect(page.getByRole('button', { name: /Loaded chat/ })).toBeVisible();
}

test('All paginates, appends without duplicate IDs, and searching resets the cursor', async ({ page }) => {
  const requests: string[] = [];
  await setup(page);
  await page.route('**/api/saved-threads*', async route => {
    const url = new URL(route.request().url()); requests.push(url.search);
    const body = url.searchParams.get('cursor') === 'next'
      ? { data: [saved('two', 'Second'), saved('one', 'Duplicate first')], nextCursor: null }
      : { data: [saved('one', 'First')], nextCursor: 'next' };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: /First/ })).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByRole('button', { name: /Second/ })).toBeVisible();
  expect(await page.locator('[data-thread-id="one"]').count()).toBe(1);
  await page.getByLabel('Search conversations in All').fill('needle');
  await expect.poll(() => requests.at(-1)).toBe('?search=needle');
  expect(requests).toEqual(['', '?cursor=next', '?search=needle']);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests.at(-1)).toBe('?search=needle');
  await expect(page.locator('.list-header, #refresh')).toHaveCount(0);
});

test('stale All-search responses cannot replace the newest query', async ({ page }) => {
  await setup(page);
  const pending = new Map<string, Route>();
  await page.route('**/api/saved-threads*', async route => {
    const query = new URL(route.request().url()).searchParams.get('search') ?? '';
    if (!query) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [saved('initial', 'Initial')], nextCursor: null }) });
    pending.set(query, route);
  });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: /Initial/ })).toBeVisible();
  await page.getByLabel('Search conversations in All').fill('old');
  await expect.poll(() => pending.has('old')).toBe(true);
  await page.getByLabel('Search conversations in All').fill('new');
  await expect.poll(() => pending.has('new')).toBe(true);
  await pending.get('new')!.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [saved('new-id', 'New result')], nextCursor: null }) });
  await expect(page.getByRole('button', { name: /New result/ })).toBeVisible();
  await pending.get('old')!.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [saved('old-id', 'Old result')], nextCursor: null }) });
  await expect(page.getByRole('button', { name: /Old result/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /New result/ })).toBeVisible();
});

test('browsing never opens an unloaded row, explicit open is once-only, and failure preserves the picker', async ({ page }) => {
  await setup(page);
  let opens = 0;
  await page.route('**/api/saved-threads*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [saved('unloaded', 'Historical chat')], nextCursor: null }) }));
  await page.route('**/api/threads/unloaded/open', async route => { opens++; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Open failed' }) }); });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: /Historical chat/ })).toBeVisible();
  expect(opens).toBe(0);
  await page.getByRole('button', { name: /Historical chat/ }).dblclick();
  await expect(page.getByRole('alert')).toHaveText('Open failed');
  expect(opens).toBe(1);
  await expect(page.getByRole('button', { name: /Historical chat/ })).toBeVisible();
  await page.getByRole('button', { name: 'Loaded', exact: true }).click();
  await page.getByRole('button', { name: 'Loaded chat' }).click();
  await expect(page.locator('#conversation')).toBeVisible();
});

test('capability absence hides history UI, while chat drafts stay with their thread', async ({ page }) => {
  await setup(page, false);
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Loaded chat' }).click();
  await page.getByLabel('Message', { exact: true }).fill('draft for loaded');
  await page.getByRole('button', { name: '← Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Loaded chat' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('draft for loaded');
});

test('a delayed open cannot replace a newer selection', async ({ page }) => {
  await setup(page);
  await page.route('**/api/saved-threads*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [saved('delayed', 'Delayed historical chat')], nextCursor: null }) }));
  let pending: Route | undefined;
  await page.route('**/api/threads/delayed/open', route => { pending = route; });
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.locator('[data-thread-id="delayed"]').click();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole('button', { name: 'Loaded', exact: true }).click();
  await page.locator('[data-thread-id="loaded-1"]').click();
  await page.locator('#draft').fill('keep this draft');
  await pending!.fulfill({ contentType: 'application/json', body: JSON.stringify(saved('delayed', 'Delayed historical chat', true)) });
  await expect(page.locator('#title')).toHaveText('Loaded chat');
  await expect(page.locator('#draft')).toHaveValue('keep this draft');
});

test('mobile All list keeps long titles, timestamps and header inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.route('**/api/saved-threads*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: Array.from({ length: 50 }, (_, i) => saved(`long-${i}`, `Pocket saved test ${'long-unbroken-title-'.repeat(15)}${i}`)), nextCursor: 'next' }) }));
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('.thread')).toHaveCount(50);
  const bounds = await page.evaluate(() => ['.shell', '.appbar', '.workspace', '#picker', '#threads', '.thread', '.thread time', '#scope', '.search', '#more-threads'].map(selector => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { selector, left: rect.left, right: rect.right, width: rect.width };
  }));
  for (const rect of bounds) { expect(rect.left, JSON.stringify(rect)).toBeGreaterThanOrEqual(0); expect(rect.right, JSON.stringify(rect)).toBeLessThanOrEqual(390); }
  await page.screenshot({ path: '.local/history-width.png' });
});
