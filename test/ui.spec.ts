import { expect, test, type Page, type Route } from '@playwright/test';

const scratchThread = {
  id: 'thread-1',
  name: 'Scratch conversation',
  preview: 'Synthetic UI regression transcript',
  cwd: '/scratch/ui-regressions',
  updatedAt: 1_700_000_000,
  recencyAt: 1_700_000_000,
  status: { type: 'idle', activeFlags: [] },
};

const otherScratchThread = {
  id: 'thread-2',
  name: 'Other conversation',
  preview: 'Synthetic safety fixture',
  cwd: '/scratch/ui-regressions',
  updatedAt: 1_700_000_001,
  recencyAt: 1_700_000_001,
  status: { type: 'idle', activeFlags: [] },
};

function entry(turn: number, item: Record<string, unknown>) {
  return { turnId: `ui-turn-${turn}`, item: { id: `ui-item-${turn}`, ...item } };
}

function longTranscript(count = 72) {
  return Array.from({ length: count }, (_, index) => entry(index, {
    type: index % 2 ? 'agentMessage' : 'userMessage',
    text: `${index % 2 ? 'Codex' : 'You'} message ${index}: ${'reader position content '.repeat(5)}`,
  }));
}

async function pair(page: Page) {
  await page.route('**/api/threads', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([scratchThread, otherScratchThread]) }));
  await page.goto('/');
  const code = await (await page.request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  await expect(page.getByRole('button', { name: /Scratch conversation/ })).toBeVisible();
}

async function routeHistory(page: Page, responder: (threadId: string, call: number) => unknown) {
  const calls = new Map<string, number>();
  await page.route('**/api/threads', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([scratchThread, otherScratchThread]) }));
  await page.route('**/api/threads/*/history*', async (route: Route) => {
    const url = new URL(route.request().url());
    const threadId = url.pathname.split('/')[3];
    const call = (calls.get(threadId) ?? 0) + 1;
    calls.set(threadId, call);
    const body = responder(threadId, call);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

function history(thread: typeof scratchThread, data: unknown[], nextCursor: string | null = null) {
  return { thread, blocked: false, data, nextCursor };
}

test('settings reload refreshes the app without unpairing or losing text drafts', async ({ page }) => {
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, []));
  await pair(page);
  await page.getByRole('button', { name: /Other conversation/ }).click();
  const text = '  Keep my draft\nexactly 📝  ';
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByLabel('Settings', { exact: true }).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Reload app', exact: true }).click(),
  ]);
  await expect(page.getByRole('button', { name: /Other conversation/ })).toBeVisible();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(text);
});

for (const width of [390, 1024]) test(`scrolling back loads earlier history once per page and keeps the reading position at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const entries = Array.from({ length: 100 }, (_, i) => entry(i, { type: 'agentMessage', text: `History message ${i}: preserved reading position` }));
  const requests: string[] = [], pending: Route[] = [];
  await page.route('**/api/threads/*/history*', async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor) { requests.push(cursor); pending.push(route); }
    else await route.fulfill({ json: history(otherScratchThread, entries.slice(60), 'page-2') });
  });
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript .message')).toHaveCount(40);
  expect(requests).toEqual([]);
  const scroller = page.locator('#message-scroll');
  await scroller.evaluate(el => { el.scrollTop = 100; });
  await expect.poll(() => requests).toEqual(['page-2']);
  const anchor = page.locator('[data-key="ui-turn-60/ui-item-60"]');
  const before = await anchor.boundingBox();
  await expect(page.getByRole('button', { name: 'Loading earlier messages…' })).toBeDisabled();
  await scroller.evaluate(el => { el.dispatchEvent(new Event('scroll')); el.dispatchEvent(new Event('scroll')); });
  expect(requests).toEqual(['page-2']);
  await pending.shift()!.fulfill({ json: history(otherScratchThread, entries.slice(30, 61), 'page-3') });
  await expect(page.locator('#transcript .message')).toHaveCount(70);
  expect(Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThan(2);
  await scroller.evaluate(el => { el.scrollTop = 100; });
  await expect.poll(() => requests).toEqual(['page-2', 'page-3']);
  const secondAnchor = page.locator('[data-key="ui-turn-30/ui-item-30"]');
  const secondBefore = await secondAnchor.boundingBox();
  await pending.shift()!.fulfill({ json: history(otherScratchThread, entries.slice(0, 31)) });
  await expect(page.locator('#transcript .message')).toHaveCount(100);
  expect(Math.abs((await secondAnchor.boundingBox())!.y - secondBefore!.y)).toBeLessThan(2);
  await expect(page.locator('#older')).toBeHidden();
  await scroller.evaluate(el => { el.scrollTop = 0; });
  expect(requests).toEqual(['page-2', 'page-3']);
  expect(await page.locator('#transcript .message').evaluateAll(nodes => nodes.map(node => node.textContent!.match(/History message (\d+):/)![1]))).toEqual(entries.map((_, i) => String(i)));
});

test('earlier-history failures wait for explicit retry and late pages cannot enter another conversation', async ({ page }) => {
  const entries = longTranscript(50);
  let calls = 0, pending: Route | undefined;
  await page.route('**/api/threads/*/history*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('thread-1/')) return route.fulfill({ json: history(scratchThread, [entry(200, { type: 'agentMessage', text: 'Different conversation' })]) });
    if (!url.searchParams.has('cursor')) return route.fulfill({ json: history(otherScratchThread, entries, 'older') });
    if (++calls === 1) return route.fulfill({ status: 503, json: { message: 'Temporary history failure' } });
    pending = route;
  });
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript .message')).toHaveCount(50);
  await page.locator('#message-scroll').evaluate(el => { el.scrollTop = 0; });
  await expect(page.getByRole('button', { name: 'Retry earlier messages' })).toBeVisible();
  await page.locator('#message-scroll').evaluate(el => { for (let i = 0; i < 5; i++) el.dispatchEvent(new Event('scroll')); });
  expect(calls).toBe(1);
  await page.getByRole('button', { name: 'Retry earlier messages' }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await pending!.fulfill({ json: history(otherScratchThread, [entry(201, { type: 'agentMessage', text: 'Stale earlier page' })]) });
  await expect(page.locator('#transcript')).toContainText('Different conversation');
  await expect(page.locator('#transcript')).not.toContainText('Stale earlier page');
});

test('a non-advancing history page stops automatic requests and can be retried', async ({ page }) => {
  const entries = longTranscript(50);
  let olderCalls = 0;
  await page.route('**/api/threads/*/history*', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) return route.fulfill({ json: history(otherScratchThread, entries, 'older') });
    olderCalls++;
    return route.fulfill({ json: olderCalls === 1 ? history(otherScratchThread, [], 'older') : history(otherScratchThread, [entry(100, { type: 'agentMessage', text: 'Recovered older history' })]) });
  });
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript .message')).toHaveCount(50);
  await page.locator('#message-scroll').evaluate(el => { el.scrollTop = 0; });
  await expect(page.getByRole('button', { name: 'Retry earlier messages' })).toBeVisible();
  await page.locator('#message-scroll').evaluate(el => el.dispatchEvent(new Event('scroll')));
  expect(olderCalls).toBe(1);
  await page.getByRole('button', { name: 'Retry earlier messages' }).click();
  await expect(page.locator('#transcript .message')).toHaveCount(51);
  await expect(page.locator('#older')).toBeHidden();
  expect(olderCalls).toBe(2);
});

test('history prepends keep decoded images mounted and do not chain on their own scroll adjustment', async ({ page }) => {
  const imagePath = `/api/attachments/${'c'.repeat(64)}`;
  const data = [entry(300, { type: 'userMessage', content: [{ type: 'image', url: imagePath }] }), ...longTranscript(50)];
  let pending: Route | undefined, olderCalls = 0;
  await page.route(`**${imagePath}`, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160"/>' }));
  await page.route('**/api/threads/*/history*', route => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.fulfill({ json: history(otherScratchThread, data, 'page-2') });
    olderCalls++; pending = route;
  });
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript .message-image')).toHaveCount(1);
  await page.locator('#message-scroll').evaluate(el => { el.scrollTop = 0; });
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect.poll(() => page.locator('.message-image').evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(160);
  await page.evaluate(() => { (window as any).__mountedHistoryImage = document.querySelector('.message-image'); });
  await pending!.fulfill({ json: history(otherScratchThread, [entry(301, { type: 'reasoning', text: 'Earlier activity' })], 'page-3') });
  await expect(page.locator('#transcript .message')).toHaveCount(52);
  expect(await page.evaluate(() => document.querySelector('.message-image') === (window as any).__mountedHistoryImage)).toBe(true);
  const before = await page.locator('.message-image').boundingBox();
  // Allow pending scroll/resize callbacks to run: the prepend itself must not
  // trigger another fetch or reflow a previously decoded image.
  await page.waitForTimeout(400);
  expect(olderCalls).toBe(1);
  expect(await page.locator('.message-image').boundingBox()).toEqual(before);
  // Another touch at the top must work even if Safari reports no scroll delta.
  await page.locator('#message-scroll').dispatchEvent('touchstart');
  await expect.poll(() => olderCalls).toBe(2);
  await pending!.fulfill({ json: history(otherScratchThread, [entry(302, { type: 'agentMessage', text: 'Next earlier page' })]) });
  await expect(page.locator('#transcript')).toContainText('Next earlier page');
});

for (const width of [390, 1024]) for (const metadata of [true, false]) test(`delayed images above the reader preserve the visible message at ${width}px (dimensions: ${metadata})`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const imagePath = `/api/attachments/${'d'.repeat(64)}`;
  let imageRoute: Route | undefined;
  await page.route(`**${imagePath}`, route => { imageRoute = route; });
  await page.route('**/api/threads/*/history*', route => {
    const older = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({ json: history(otherScratchThread, older ? [entry(200, { type: 'userMessage', content: [{ type: 'image', url: imagePath, ...(metadata ? { width: 300, height: 240 } : {}) }] })] : longTranscript(50), older ? null : 'older') });
  });
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript .message')).toHaveCount(50);
  await page.locator('#message-scroll').evaluate(el => { el.scrollTop = 0; });
  const anchor = page.locator('[data-key="ui-turn-0/ui-item-0"]');
  const before = await anchor.boundingBox();
  await expect.poll(() => Boolean(imageRoute)).toBe(true);
  await expect(page.locator('#transcript .message')).toHaveCount(51);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThan(2);
  const reservedHeight = (await page.locator('.message-image').boundingBox())!.height;
  if (metadata) expect(reservedHeight).toBeGreaterThan(150);
  await imageRoute!.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240"/>' });
  await expect.poll(() => page.locator('.message-image').evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(240);
  if (metadata) expect((await page.locator('.message-image').boundingBox())!.height).toBeCloseTo(reservedHeight, 0);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThan(2);
  await page.waitForTimeout(250);
  expect(Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThan(2);
});

test('scrolling to the top during a live refresh queues history until the refresh finishes', async ({ page }) => {
  const data = longTranscript(50);
  let latestCalls = 0, olderCalls = 0, refresh: Route | undefined;
  await page.route('**/api/threads/*/history*', route => {
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      olderCalls++;
      return route.fulfill({ json: history(scratchThread, [entry(200, { type: 'agentMessage', text: 'Queued earlier history' })]) });
    }
    if (++latestCalls === 1) return route.fulfill({ json: history(scratchThread, data, 'older') });
    refresh = route;
  });
  await pair(page); await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#transcript .message')).toHaveCount(50);
  await page.request.get('http://127.0.0.1:44319/change');
  await expect.poll(() => Boolean(refresh)).toBe(true);
  await page.locator('#message-scroll').dispatchEvent('touchstart');
  await page.locator('#message-scroll').evaluate(el => { el.scrollTop = 0; });
  // Let the scroll-idle trigger fire while the history transport is occupied.
  await page.waitForTimeout(250);
  expect(olderCalls).toBe(0);
  await refresh!.fulfill({ json: history(scratchThread, data, 'older') });
  await expect(page.locator('#transcript')).toContainText('Queued earlier history');
  expect(olderCalls).toBe(1);
});

test('mobile composer stays in the viewport with a long transcript', async ({ page }) => {
  await routeHistory(page, (threadId) => history(
    threadId === 'thread-2' ? otherScratchThread : scratchThread,
    longTranscript(),
  ));
  await pair(page);
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('message 71');

  const reader = page.locator('#message-scroll'), jump = page.locator('#new-content');
  await expect(jump).toBeHidden();
  await reader.evaluate(node => { node.scrollTop -= 20; });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  await expect.poll(() => reader.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
  await reader.evaluate(node => { node.scrollTop -= 20; });
  await expect(jump).toBeVisible();
  await reader.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(jump).toBeHidden();

  const compactHeader = await page.locator('.chat-header').boundingBox();
  expect(compactHeader!.height).toBeLessThanOrEqual(80);
  const backCircle = await page.locator('#back').boundingBox();
  expect(backCircle!.width).toBe(44);
  expect(backCircle!.height).toBe(44);
  expect(await page.locator('.chat-header').evaluate(header => getComputedStyle(header).position)).toBe('absolute');
  await expect(page.locator('#back')).toHaveText('');
  await expect(page.locator('#title').locator('..')).toHaveClass('sr-only');
  expect(await page.locator('#transcript').evaluate(el => getComputedStyle(el).gap)).toBe('6px');
  expect(await page.locator('#message-scroll').evaluate(el => getComputedStyle(el).paddingBottom)).toBe('8px');
  expect(await page.locator('.composer').evaluate(el => getComputedStyle(el).paddingTop)).toBe('4px');
  const composer = await page.locator('.composer').boundingBox();
  expect(composer).not.toBeNull();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('live refresh does not move a reader who is away from the bottom', async ({ page }) => {
  let live = false;
  await routeHistory(page, (threadId) => {
    const thread = threadId === 'thread-2' ? otherScratchThread : scratchThread;
    const data = longTranscript(42);
    if (live) data.push(entry(100, { type: 'agentMessage', text: 'Live desktop update without reader jump' }));
    return history(thread, data);
  });
  await pair(page);
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('message 41');
  const reader = page.locator('#message-scroll');
  await expect(reader).toBeVisible();
  await reader.dispatchEvent('wheel', { deltaY: -200 });
  await reader.evaluate((element) => { element.scrollTop = Math.floor(element.scrollHeight / 3); });
  const before = await reader.evaluate((element) => element.scrollTop);
  live = true;

  await page.request.get('http://127.0.0.1:44319/change');
  await expect(page.getByText('Live desktop update without reader jump', { exact: true })).toBeVisible();
  const after = await reader.evaluate((element) => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(8);
});

test('transcript renders hostile text and code as text, never executable markup', async ({ page }) => {
  await routeHistory(page, (threadId) => history(
    threadId === 'thread-2' ? otherScratchThread : scratchThread,
    [
      entry(1, {
        type: 'userMessage',
        text: '<img src=x onerror="window.__uiXss = true"> <script>window.__uiXss = true</script>',
      }),
      entry(2, {
        type: 'agentMessage',
        text: '```js\nconst literal = "<button>not a button</button>";\n```',
      }),
    ],
  ));
  await pair(page);
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('<img src=x onerror="window.__uiXss = true">');
  await expect(page.locator('#transcript')).toContainText('const literal = "<button>not a button</button>";');
  await expect(page.locator('#transcript img, #transcript script')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as Window & { __uiXss?: boolean }).__uiXss))).toBe(false);
});

test('desktop keeps the conversation sidebar visible while a chat is open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeHistory(page, (threadId) => history(
    threadId === 'thread-2' ? otherScratchThread : scratchThread,
    longTranscript(8),
  ));
  await pair(page);
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#conversation')).toBeVisible();
  await expect(page.locator('#picker')).toBeVisible();
  await expect(page.getByRole('button', { name: /Other conversation/ })).toBeVisible();
  const sidebar = await page.locator('#picker').boundingBox();
  const chat = await page.locator('#conversation').boundingBox();
  expect(sidebar).not.toBeNull();
  expect(chat).not.toBeNull();
  expect(sidebar!.width).toBeGreaterThan(0);
  expect(chat!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width - 1);
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    const pane = (await page.locator('#conversation').boundingBox())!;
    const avatar = (await page.locator('#contact-avatar').boundingBox())!;
    expect(Math.abs(avatar.x + avatar.width / 2 - pane.x - pane.width / 2)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: '.local/tablet-avatar-centered.png' });
});

test('paired shell contains no marketing or instructional banner', async ({ page }) => {
  await routeHistory(page, (threadId) => history(
    threadId === 'thread-2' ? otherScratchThread : scratchThread,
    [entry(1, { type: 'agentMessage', text: 'Ready for the conversation.' })],
  ));
  await pair(page);
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('[data-testid="marketing-banner"], .marketing-banner, .instruction-banner')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/download|install the app|get started|how it works/i);
});


test('keyboard resize and visual viewport pan keep composer and header in the visible area', async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (window as any).__keyboardViewport = viewport;
  });
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, longTranscript(40)));
  await pair(page);
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('message 39');
  // Simulate the iPhone home-indicator inset, which desktop Chromium reports as zero.
  await page.evaluate(() => document.documentElement.style.setProperty('--composer-safe-area', '34px'));
  await expect.poll(() => page.locator('.composer').evaluate(el => getComputedStyle(el).paddingBottom)).toBe('44px');
  const text = 'First line\nSecond line';
  await page.getByLabel('Message', { exact: true }).fill(text);
  // iOS may auto-scroll before its visualViewport resize/pan events arrive.
  await page.locator('#message-scroll').evaluate(node => { node.scrollTop -= 140; node.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => {
    const v = (window as any).__keyboardViewport;
    v.height = 340; v.offsetTop = 160; v.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const app = await page.locator('#app').boundingBox();
    const composer = await page.locator('.composer').boundingBox();
    const header = await page.locator('.chat-header').boundingBox();
    return !!app && !!composer && !!header && Math.abs(app.y - 160) < 2 && Math.abs(app.height - 340) < 2 && composer.y >= 160 && composer.y + composer.height <= 501 && header.y >= 160;
  }).toBe(true);
  const reader = page.locator('#message-scroll');
  await expect.poll(() => reader.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(2);
  await expect(page.locator('#new-content')).toBeHidden();
  const latestMessage = await page.locator('#transcript article').last().boundingBox();
  const composerTop = (await page.locator('.composer').boundingBox())!.y;
  expect(latestMessage!.y + latestMessage!.height).toBeLessThanOrEqual(composerTop);
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
  await expect.poll(() => page.locator('.composer').evaluate(el => getComputedStyle(el).paddingBottom)).toBe('6px');
  // Panning can arrive as a scroll event without a second resize event.
  await page.evaluate(() => { const v = (window as any).__keyboardViewport; v.offsetTop = 200; v.dispatchEvent(new Event('scroll')); });
  await expect.poll(async () => Math.round((await page.locator('#app').boundingBox())!.y)).toBe(200);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(text);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  // Deliberate reading while typing still takes priority over keyboard following.
  await reader.dispatchEvent('wheel', { deltaY: -200 });
  await reader.evaluate(node => { node.scrollTop -= 200; });
  await expect(page.locator('#new-content')).toBeVisible();
  const readingTop = await reader.evaluate(node => node.scrollTop);
  await page.evaluate(() => { const v = (window as any).__keyboardViewport; v.height = 320; v.offsetTop = 220; v.dispatchEvent(new Event('resize')); });
  await expect.poll(() => page.locator('#app').evaluate(el => el.getBoundingClientRect().height)).toBe(320);
  expect(await reader.evaluate(node => node.scrollTop)).toBeCloseTo(readingTop, 0);
  await page.getByLabel('Message', { exact: true }).blur();
  await page.evaluate(() => { const v = (window as any).__keyboardViewport; v.height = 844; v.offsetTop = 0; v.dispatchEvent(new Event('resize')); });
  await expect.poll(async () => Math.round((await page.locator('#app').boundingBox())!.height)).toBe(844);
  await expect.poll(async () => Math.round((await page.locator('#app').boundingBox())!.y)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'closed');
  await expect.poll(() => page.locator('.composer').evaluate(el => getComputedStyle(el).paddingBottom)).toBe('44px');
  // A pinch zoom should magnify normally rather than shrink/reposition the app.
  await page.evaluate(() => { const v = (window as any).__keyboardViewport; v.scale = 2; v.height = 422; v.offsetTop = 90; v.dispatchEvent(new Event('resize')); });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.locator('#app').evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(844);
});

test('Markdown formats replies without executing HTML or loading embedded images', async ({ page }) => {
  const text = '**Bold** and *italic* with `inline <code>`.\n\n- First\n- Second\n\n3. Third\n4. Fourth\n\n> Quoted text\n\n[Docs](https://example.com/docs) [unsafe](javascript:alert(1))\n\n![remote picture](https://unsafe.example.invalid/image.png)\n\n<img src=x onerror="window.__markdownXss=true">\n\n| Name | Value |\n| --- | --- |\n| one | two |\n\n```html\n<script>literal code</script>\n```';
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, [entry(1, { type: 'agentMessage', text })]));
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  const bubble = page.locator('#transcript .bubble');
  await expect(bubble.locator('strong')).toHaveText('Bold');
  await expect(bubble.locator('em')).toHaveText('italic');
  await expect(bubble.locator('p>code').first()).toHaveText('inline <code>');
  await expect(bubble.locator('ul>li')).toHaveCount(2);
  await expect(bubble.locator('ol')).toHaveAttribute('start', '3');
  await expect(bubble.locator('blockquote')).toContainText('Quoted text');
  await expect(bubble.locator('table')).toContainText('one');
  await expect(bubble.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(bubble.getByRole('link', { name: 'Docs' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(bubble.locator('a')).toHaveCount(1);
  await expect(bubble.locator('img,script,iframe')).toHaveCount(0);
  await expect(bubble.locator('.code-block code')).toHaveText('<script>literal code</script>\n');
  await expect(bubble).toContainText('<img src=x onerror="window.__markdownXss=true">');
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(resource => resource.name.includes('unsafe.example.invalid')))).toBe(false);
  expect(await page.evaluate(() => Boolean((window as any).__markdownXss))).toBe(false);
  await page.screenshot({ path: '.local/markdown-browser.png', fullPage: true });
});

test('code buttons copy only their block with exact whitespace and stable feedback', async ({ page }) => {
  const code = '  printf "<hello>"  \n\tsecond line\n\n';
  const text = `Outside text and \`inline code\`.\n\n\`\`\`sh\n${code}\`\`\`\n\n~~~\nother command\n~~~`;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (text: string) => {
        if ((window as any).__failCopy) throw new Error('denied');
        (window as any).__copiedCode = text;
      },
    } });
  });
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, [entry(1, { type: 'agentMessage', text })]));
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const buttons = page.locator('.code-copy');
    await expect(buttons).toHaveCount(2);
    const before = await buttons.first().boundingBox();
    await expect(buttons.first().locator('svg')).toBeVisible();
    await buttons.first().click();
    await expect(buttons.first()).toHaveAttribute('aria-label', 'Copied');
    expect(await page.evaluate(() => (window as any).__copiedCode)).toBe(code);
    expect(await buttons.first().boundingBox()).toEqual(before);
    await expect(buttons.first()).toHaveAttribute('aria-label', 'Copy code');
    await buttons.last().click();
    expect(await page.evaluate(() => (window as any).__copiedCode)).toBe('other command\n');
    await expect(page.getByRole('button', { name: 'Copy message', exact: true })).toHaveCount(1);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '.local/code-copy-dark.png' });
  await page.evaluate(() => { (window as any).__failCopy = true; });
  await page.locator('.code-copy').first().click();
  await expect(page.locator('.code-copy').first()).toHaveAttribute('aria-label', 'Copy failed');
  await expect(page.locator('.code-copy').first()).toHaveAttribute('aria-label', 'Copy code');
});

test('code surfaces show safe language labels and syntax colors with independent horizontal scrolling', async ({ page }) => {
  const code = '"scripts": {\n  "dev": "next dev",\n  "build": "next build",\n  "start": "next start"\n}\n';
  const text = `Next scripts:\n\n\`\`\`json\n${code}\`\`\`\n\n\`\`\`unknown\n${'long command '.repeat(30)}\n\`\`\`\n\n\`\`\`html\n<img src=x onerror="window.codeXss=true">\n\`\`\``;
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, [entry(1, { type: 'agentMessage', text })]));
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('.code-language')).toHaveText(['json', 'unknown', 'html']);
  expect(await page.locator('.code-block code').first().textContent()).toBe(code);
  await expect(page.locator('.code-block .hljs-attr').first()).toHaveText('"scripts"');
  await expect(page.locator('.code-block .hljs-string').first()).toHaveText('"next dev"');
  await expect(page.locator('.code-block img')).toHaveCount(0);
  expect(await page.evaluate(() => Boolean((window as any).codeXss))).toBe(false);
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const pre = page.locator('.code-block').nth(1), copy = page.locator('.code-copy').nth(1);
    const before = await copy.boundingBox();
    expect(await pre.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await pre.evaluate(el => { el.scrollLeft = 120; });
    expect(await copy.boundingBox()).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.locator('.code-container').first().screenshot({ path: `.local/code-surface-${width}-${colorScheme}.png` });
    }
  }
});

test('reopening follows the bottom after delayed images and layout changes, while readers can scroll up', async ({ page }) => {
  const imageId = 'a'.repeat(64), imagePath = `/api/attachments/${imageId}`;
  let delayed: Route | undefined;
  const data = [...longTranscript(45), entry(90, { type: 'userMessage', content: [{ type: 'text', text: 'Late screenshot' }, { type: 'image', url: imagePath }] }), entry(91, { type: 'agentMessage', text: 'Latest reply' })];
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, data, 'older'));
  await page.route(`**${imagePath}`, route => { delayed = route; });
  await pair(page);
  await page.locator('#filter').focus();
  expect(await page.locator('#filter').evaluate(input => getComputedStyle(input).outlineStyle)).toBe('none');
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('Latest reply');
  await expect.poll(() => !!delayed).toBe(true);
  const reader = page.locator('#message-scroll');
  const gap = () => reader.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await delayed!.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="320"><rect width="300" height="320" fill="green"/></svg>' });
  await expect.poll(() => page.locator('.message-image').evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(320);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await reader.dispatchEvent('wheel', { deltaY: -200 });
  await reader.evaluate(node => { node.scrollTop = 0; });
  await expect.poll(gap).toBeGreaterThan(100);
  await page.unroute(`**${imagePath}`);
  await page.route(`**${imagePath}`, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="320"/>' }));
  await page.getByRole('button', { name: '← Conversations', exact: true }).click();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('Latest reply');
  await expect.poll(gap).toBeLessThanOrEqual(2);
});

test('outside touch dismisses Settings without opening or focusing the control underneath', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, longTranscript(10)));
    await pair(page);
    const settings = page.getByLabel('Settings', { exact: true }), menu = page.locator('#settings');
    await settings.tap(); await expect(menu).toHaveAttribute('open', '');
    await page.locator('.settings-panel strong').tap(); await expect(menu).toHaveAttribute('open', '');
    const conversation = page.getByRole('button', { name: /Other conversation/ });
    const originalBackground = await conversation.evaluate(row => getComputedStyle(row).backgroundColor);
    await conversation.tap(); await expect(menu).not.toHaveAttribute('open');
    await expect(page.locator('#conversation')).toBeHidden();
    await expect(page.locator('#picker')).toBeVisible();
    // Mobile browsers may retain an emulated :hover state after a touch.
    await conversation.hover();
    await expect.poll(() => conversation.evaluate(row => getComputedStyle(row).backgroundColor)).toBe(originalBackground);
    await expect(conversation).not.toBeFocused();
    await expect(conversation).toHaveAttribute('aria-current', 'false');
    await settings.tap(); await page.locator('#filter').tap({ position: { x: 4, y: 10 } });
    await expect(menu).not.toHaveAttribute('open');
    await expect(page.locator('#filter')).not.toBeFocused();
    await conversation.tap(); await expect(page.locator('#conversation')).toBeVisible();
  } finally { await context.close(); }
});

test('browser back returns to Messages, forward restores a draft, and the app back button adds no extra entry', async ({ page }) => {
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, longTranscript(25)));
  await pair(page);
  const originalLength = await page.evaluate(() => history.length);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('message 24');
  await page.locator('#draft').fill('  preserve my swipe-back draft\n🙂  ');
  expect(await page.evaluate(() => history.length)).toBe(originalLength + 1);
  await page.goBack();
  await expect(page.locator('#picker')).toBeVisible();
  await expect(page.locator('#conversation')).toBeHidden();
  await page.goForward();
  await expect(page.locator('#conversation')).toBeVisible();
  await expect(page.locator('#draft')).toHaveValue('  preserve my swipe-back draft\n🙂  ');
  await page.getByRole('button', { name: '← Conversations', exact: true }).click();
  await expect(page.locator('#conversation')).toBeHidden();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#conversation')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(originalLength + 1);
  expect(writes).toEqual([]);
});

test('working dots are accessible, respect reduced motion, and yield to CLI-action and idle states', async ({ page }) => {
  let working = true, blocked = false;
  await routeHistory(page, id => history({ ...(id === 'thread-2' ? otherScratchThread : scratchThread), status: { type: working ? 'active' : 'idle', activeFlags: [] } }, longTranscript(10)));
  // Keep the blocking flag in the same authoritative history response.
  await page.route('**/api/threads/*/history*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...history({ ...scratchThread, status: { type: working ? 'active' : 'idle', activeFlags: [] } }, longTranscript(10)), blocked }) }));
  await pair(page); await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.locator('#activity .working-dots>span')).toHaveCount(3);
  await expect(page.locator('#activity')).toContainText('Working');
  await expect(page.locator('#activity .working-dots')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('.working-dots>span').first().evaluate(dot => getComputedStyle(dot).animationName)).toBe('pocket-dot');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  expect(await page.locator('.working-dots>span').first().evaluate(dot => getComputedStyle(dot).animationName)).toBe('none');
  await page.screenshot({ path: '.local/working-dots-dark.png' });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.screenshot({ path: '.local/floating-header-light.png' });
  blocked = true;
  await page.request.get('http://127.0.0.1:44319/change');
  await expect(page.locator('#activity')).toHaveText('Needs action in Codex CLI');
  await expect(page.locator('.working-dots')).toHaveCount(0);
  blocked = false; working = false;
  await page.request.get('http://127.0.0.1:44319/change');
  await expect(page.locator('#activity')).toBeHidden();
});

test('green marks newly completed unseen work, survives reload, and clears only after viewing latest', async ({ page }) => {
  let latest = { id: 'finished-before-pocket', status: 'completed' };
  const thread = () => ({ ...otherScratchThread, latestTurn: latest, status: { type: latest.status === 'inProgress' ? 'active' : 'idle', activeFlags: [] } });
  await page.route('**/api/threads', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([thread()]) }));
  await page.route('**/api/threads/thread-2/history*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(history(thread(), [{ turnId: latest.id, item: { id: 'latest-reply', type: 'agentMessage', text: 'Latest finished work' } }])) }));
  await page.goto('/');
  const code = await (await page.request.get('http://127.0.0.1:44319/code')).text();
  await page.getByLabel('Pairing code').fill(code); await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
  const row = page.locator('[data-thread-id="thread-2"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.thread-state')).toHaveCount(0); // Old untouched history is the baseline.
  latest = { id: 'new-work', status: 'inProgress' };
  await page.getByRole('button', { name: 'Loaded', exact: true }).click();
  await expect(row.locator('.thread-state')).toHaveAttribute('aria-label', 'Working');
  latest = { id: 'new-work', status: 'completed' };
  // The visible list also polls activity without requiring a scope tap or visiting the chat.
  await expect(row.locator('.thread-state.unread')).toBeVisible({ timeout: 8000 });
  await expect(row.locator('.thread-state.unread')).toHaveAttribute('aria-label', 'Finished — not viewed');
  await page.reload();
  await expect(row.locator('.thread-state.unread')).toBeVisible();
  await row.click(); await expect(page.locator('#transcript')).toContainText('Latest finished work');
  await page.getByRole('button', { name: '← Conversations', exact: true }).click();
  await expect(row.locator('.thread-state')).toHaveCount(0);
  await page.reload(); await expect(row).toBeVisible();
  await expect(row.locator('.thread-state')).toHaveCount(0);
  const receipts = await page.evaluate(() => localStorage.getItem('pocket-read-v1'));
  expect(receipts).not.toContain('Latest finished work');
});

test('async question enables an exact reply during work, survives reload, and clears after acceptance', async ({ page }) => {
  const question = { itemId: 'async-q', turnId: 'active-turn' };
  let answered = false;
  const thread = () => ({ ...otherScratchThread, status: { type: 'active', activeFlags: [] }, latestTurn: { id: 'active-turn', status: 'inProgress' } });
  await page.route('**/api/threads/*/history*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...history(thread(), [{ turnId: 'active-turn', item: { id: 'async-q', type: 'agentMessage', delivery: 'async', questions: [{ title: 'Which color?', options: ['Blue', 'Green'] }], text: '' } }]), question: answered ? null : question }) }));
  // Pocket's original accepted turn must not prevent a question reply in that turn.
  await page.route('**/api/submissions', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'original-send', threadId: 'thread-2', turnId: 'active-turn', state: 'accepted' }]) }));
  await page.route('**/api/submissions/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'original-send', threadId: 'thread-2', turnId: 'active-turn', state: 'accepted' }) }));
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('Which color?');
  await page.reload(); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#draft')).toHaveAttribute('placeholder', 'Reply to question');
  const exact = '  Green\nplease  ';
  await page.getByLabel('Message', { exact: true }).fill(exact);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  let payload: any;
  await page.route('**/api/threads/thread-2/messages', async route => {
    payload = route.request().postDataJSON(); answered = true;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: payload.clientSubmissionId, threadId: 'thread-2', turnId: 'active-turn', state: 'accepted' }) });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  expect(payload.text).toBe(exact); expect(payload.question).toEqual(question);
  await expect(page.locator('#draft')).toHaveAttribute('placeholder', 'Follow-up');
  await page.getByLabel('Message', { exact: true }).fill('Do something else');
  await expect(page.locator('#draft')).toHaveAttribute('placeholder', 'Follow-up');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('working follow-up captures the active turn and preserves draft when that turn ends before send', async ({ page }) => {
  const activeThread = { ...otherScratchThread, status: { type: 'active', activeFlags: [] }, latestTurn: { id: 'active-follow', status: 'inProgress' } };
  await routeHistory(page, () => history(activeThread, longTranscript(12)));
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#draft')).toHaveAttribute('placeholder', 'Follow-up');
  const text = '  Also test this\non the phone  ';
  await page.getByLabel('Message', { exact: true }).fill(text);
  let payload: any;
  await page.route('**/api/threads/thread-2/messages', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'conflict', message: 'The active turn changed or finished. Refresh and send again.' }) });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(payload.text).toBe(text); expect(payload.expectedTurnId).toBe('active-follow'); expect(payload.question).toBeUndefined();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(text);
  await expect(page.locator('#submission-status')).toContainText('active turn changed');
});


test.describe('touch rotation', () => {
  test.use({ hasTouch: true });
  test('portrait landscape portrait preserves type sizing and composer tap focus', async ({ page }) => {
    await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, longTranscript(40)));
    await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
    await expect(page.locator('#transcript')).toContainText('message 39');
    const draft = page.getByLabel('Message', { exact: true });
    for (const width of [390, 844, 390, 844, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 390 });
      await expect.poll(() => draft.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
      await expect.poll(() => page.locator('#filter').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
      const box = (await draft.boundingBox())!;
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, point)).toBe('draft');
      await page.touchscreen.tap(point.x, point.y);
      await expect(draft).toBeFocused();
      await page.keyboard.type('x');
      await draft.blur();
      expect(await page.locator('#transcript .bubble').last().evaluate(el => getComputedStyle(el).fontSize)).toBe(width === 390 ? '16px' : '15px');
    }
    await expect(draft).toHaveValue('xxxxx');
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewportMeta).not.toMatch(/maximum-scale|user-scalable=no/);
  });
});

test('recovers actual document scroll after rotation without resetting transcript position or keyboard pan', async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 812, width: 402, scale: 1 });
    Object.defineProperty(viewport, 'offsetTop', { get: () => (window as any).__keyboardPan ?? window.scrollY });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (window as any).__rotationViewport = viewport;
  });
  await page.setViewportSize({ width: 402, height: 812 });
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, longTranscript(40)));
  await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.locator('#transcript')).toContainText('message 39');
  const reader = page.locator('#message-scroll');
  await reader.dispatchEvent('wheel', { deltaY: -200 });
  await reader.evaluate(el => { el.scrollTop -= 200; });
  await expect(page.locator('#new-content')).toBeVisible();
  const readingTop = await reader.evaluate(el => el.scrollTop);
  // Permit the root scroll that iOS creates despite a fixed body. It is separate
  // from the transcript scroll and must be reset, not compensated with CSS top.
  await page.evaluate(() => { const root = document.documentElement; root.style.setProperty('overflow-y', 'scroll', 'important'); const spacer = document.createElement('div'); spacer.style.height = '1000px'; spacer.style.pointerEvents = 'none'; root.append(spacer); });
  await page.evaluate(() => window.scrollTo(0, 62));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect.poll(() => page.locator('#app').evaluate(el => el.style.getPropertyValue('--app-top') || getComputedStyle(el).top)).toBe('0px');
  expect(await reader.evaluate(el => el.scrollTop)).toBe(readingTop);
  const draft = page.getByLabel('Message', { exact: true });
  await draft.click(); await expect(draft).toBeFocused();
  await page.evaluate(() => { (window as any).__keyboardPan = 396; const v = (window as any).__rotationViewport; v.height = 416; v.dispatchEvent(new Event('resize')); });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open');
  await expect.poll(() => page.locator('#app').evaluate(el => getComputedStyle(el).top)).toBe('396px');
  await page.evaluate(() => window.scrollTo(0, 62));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await page.evaluate(() => scrollY)).toBe(62);
});

test('document-scroll recovery does not loop if the browser refuses the reset', async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 62, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 62 });
    (window as any).__scrollResets = 0;
    window.scrollTo = () => { (window as any).__scrollResets++; };
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => (window as any).__scrollResets)).toBe(1);
  await page.evaluate(() => new Promise(resolve => { let frames = 20; const tick = () => { if (--frames) requestAnimationFrame(tick); else resolve(null); }; requestAnimationFrame(tick); }));
  expect(await page.evaluate(() => (window as any).__scrollResets)).toBe(1);
});

test('consecutive activity stays grouped and expanded details survive live refresh', async ({ page }) => {
  const data = [
    entry(1, { type: 'userMessage', text: 'Please inspect this scratch project' }),
    entry(2, { type: 'reasoning', text: 'Synthetic reasoning detail' }),
    { turnId: 'ui-turn-2', item: { id: 'tool-a', type: 'commandExecution', status: 'completed', command: 'synthetic command detail' } },
    entry(3, { type: 'agentMessage', text: 'Inspection complete' }),
    entry(4, { type: 'commandExecution', status: 'inProgress', command: 'separate activity detail' }),
  ];
  let loads = 0;
  await routeHistory(page, () => { loads++; return history(scratchThread, data); });
  await pair(page); await page.getByRole('button', { name: /Scratch conversation/ }).click();
  const groups = page.locator('#transcript article.activity');
  await expect(groups).toHaveCount(2);
  const first = groups.first();
  await expect(first.locator(':scope > details > summary')).toHaveText('Activity · 2');
  await first.locator(':scope > details > summary').click();
  await first.getByText('Terminal · Done', { exact: true }).click();
  await expect(first.locator('pre').last()).toBeVisible();
  const previousLoads = loads;
  await page.request.get('http://127.0.0.1:44319/change');
  await expect.poll(() => loads).toBeGreaterThan(previousLoads);
  await expect(first.locator(':scope > details')).toHaveAttribute('open', '');
  await expect(first.locator('pre').last()).toBeVisible();
  await expect(page.locator('.userMessage .copy-button')).toHaveCount(0);
  await expect(page.locator('.agentMessage .copy-button')).toHaveCount(1);
});

test('text drafts survive refresh per conversation and clear only after a confirmed send', async ({ page }) => {
  await routeHistory(page, id => history(id === 'thread-2' ? otherScratchThread : scratchThread, longTranscript(4)));
  await page.route('**/api/submissions', route => route.fulfill({ json: [] }));
  let sends = 0;
  await page.route('**/api/threads/*/messages', route => {
    sends++;
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { id: body.clientSubmissionId, threadId: 'thread-2', turnId: 'confirmed-turn', state: 'completed' } });
  });
  await pair(page);
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  const exact = '  Unsent draft\nwith whitespace 📝  ';
  await page.getByLabel('Message', { exact: true }).fill(exact);
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await page.getByLabel('Message', { exact: true }).fill('Other draft');
  await page.reload();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Other draft');
  expect(sends).toBe(0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await page.reload();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '← Conversations' }).click();
  await page.getByRole('button', { name: /Scratch conversation/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(exact);
  expect(sends).toBe(1);
});

for (const edited of [false, true]) {
  test(`confirmation restored after refresh ${edited ? 'preserves newer edits' : 'clears the captured draft'} without resending`, async ({ page }) => {
    await routeHistory(page, () => history(otherScratchThread, longTranscript(4)));
    let pending: any, sends = 0;
    await page.route('**/api/submissions', route => route.fulfill({ json: pending ? [pending] : [] }));
    await page.route('**/api/submissions/*', route => route.fulfill({ json: pending }));
    await page.route('**/api/threads/thread-2/messages', route => {
      sends++;
      pending = { id: route.request().postDataJSON().clientSubmissionId, threadId: 'thread-2', state: 'outcome-unknown', message: 'Outcome unknown' };
      return route.fulfill({ json: pending });
    });
    await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
    await page.getByLabel('Message', { exact: true }).fill('Captured text');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#submission-status')).toContainText('Outcome unknown');
    if (edited) await page.getByLabel('Message', { exact: true }).fill('Newer unsent edits');
    pending = { ...pending, state: 'completed', turnId: 'confirmed-turn' };
    await page.reload(); await page.getByRole('button', { name: /Other conversation/ }).click();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue(edited ? 'Newer unsent edits' : '');
    const storage = await page.evaluate(() => localStorage.getItem('pocket-drafts-v1'));
    expect(storage ?? '').not.toContain('Captured text');
    expect(sends).toBe(1);
  });
}

for (const storage of ['malformed', 'unavailable']) {
  test(`${storage} draft storage keeps the composer usable`, async ({ page }) => {
    await page.addInitScript(mode => {
      if (mode === 'malformed') localStorage.setItem('pocket-drafts-v1', '{');
      else Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('Storage blocked', 'SecurityError'); } });
    }, storage);
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    await routeHistory(page, () => history(otherScratchThread, longTranscript(4)));
    await page.route('**/api/submissions', route => route.fulfill({ json: [] }));
    await pair(page); await page.getByRole('button', { name: /Other conversation/ }).click();
    await page.getByLabel('Message', { exact: true }).fill('Memory fallback');
    await page.getByRole('button', { name: '← Conversations' }).click();
    await page.getByRole('button', { name: /Other conversation/ }).click();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Memory fallback');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test('existing session drafts migrate to persistent storage without losing text', async ({ page }) => {
  await page.goto('/');
  await pair(page);
  await page.evaluate(() => sessionStorage.setItem('pocket-drafts-v1', JSON.stringify({ version: 1, drafts: [['thread-2', 'Earlier session draft']], pending: [] })));
  await page.reload();
  await page.getByRole('button', { name: /Other conversation/ }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Earlier session draft');
  expect(await page.evaluate(() => sessionStorage.getItem('pocket-drafts-v1'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('pocket-drafts-v1'))).toContain('Earlier session draft');
});
