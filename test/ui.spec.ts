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
