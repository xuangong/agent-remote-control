import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function start(page: Page, enableAsk = true) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  if (enableAsk) {
    await primary.getByTestId('prompt-input').fill('/ask');
    await primary.getByTestId('prompt-input').press('Enter');
    await expect(page.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
  }
  return primary;
}

test('Ask floats over its source, preserves a minimized draft and starts fresh on Clean', async ({ page }, info) => {
  await start(page);
  const url = page.url();
  const creations: Record<string, unknown>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations.push(request.postDataJSON()); });
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  expect(creations).toHaveLength(1);
  expect(creations[0]!.sourceNativeSessionId).toBe(new URL(url).searchParams.get('session'));
  await expect(ask.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Forked sessions' })).toHaveCount(0);
  await ask.getByTestId('prompt-input').fill('Explain the choice.');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Explain the choice.');
  await ask.getByTestId('prompt-input').fill('A draft to keep');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await expect(ask).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('A draft to keep');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Explain the choice.');
  expect(creations).toHaveLength(1);
  await ask.getByRole('button', { name: 'Clean Ask' }).click();
  await expect.poll(() => creations.length).toBe(2);
  await expect(ask.getByTestId('prompt-input')).toHaveValue('');
  await expect(ask.getByTestId('timeline')).not.toContainText('Explain the choice.');
  expect(creations[1]!.sourceNativeSessionId).toBe(creations[0]!.sourceNativeSessionId);
  expect(creations[1]!.operationId).not.toBe(creations[0]!.operationId);
  expect(page.url()).toBe(url);
  const box = (await ask.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await ask.getByTestId('prompt-input').fill('What should I consider next?');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('What should I consider next?');
  await page.screenshot({ path: `../../.tmp/ask-${info.project.name}.png` });
});

test('/ask sends its question once and stays attached to the source when sessions change', async ({ page }) => {
  const primary = await start(page, false);
  const originalUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/ask Why was this approach chosen?');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Why was this approach chosen?');
  await expect(ask.locator('.agent-message-user').filter({ hasText: 'Why was this approach chosen?' })).toHaveCount(1);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect(ask.getByTestId('timeline')).not.toContainText('Why was this approach chosen?');
  await page.goto(originalUrl);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Why was this approach chosen?');
});

test('a lost Clean response keeps the old conversation and retries the same creation', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await ask.getByTestId('prompt-input').fill('Keep this answer until reset succeeds');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep this answer');
  await ask.getByTestId('prompt-input').fill('Reset this draft too');
  const operations: string[] = [];
  await page.route('**/v1/remote/create', async route => {
    operations.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (operations.length === 1) await route.fulfill({ status: 504, json: { error: 'Creation outcome is unknown. Retry to reconnect.' } });
    else await route.fulfill({ response });
  });
  await ask.getByRole('button', { name: 'Clean Ask' }).click();
  await expect(ask.getByRole('alert')).toContainText('Creation outcome is unknown');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep this answer');
  await ask.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(ask.getByRole('alert')).toHaveCount(0);
  await expect(ask.getByTestId('timeline')).not.toContainText('Keep this answer');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('');
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
});

test('Ask stays within a small viewport and follows the visual keyboard viewport', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  for (const size of [{ width: 844, height: 390 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const box = (await ask.boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
    }).toBe(true);
  }
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 340 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    const input = (await ask.getByTestId('prompt-input').boundingBox())!;
    return box.y >= 0 && box.y + box.height <= 340 && input.y >= box.y && input.y + input.height <= box.y + box.height;
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});


for (const rich of [false, true]) test(`Ask keeps its heading and multiline ${rich ? 'rich editor' : 'textarea'} above a panned mobile keyboard`, async ({ page }, info) => {
  if (rich) await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      const envelope = JSON.parse(String(message));
      const frame = envelope.type === 'message' ? envelope.message : envelope;
      if (frame.type === 'agent_snapshot') frame.payload.capabilities.imageInput = {
        mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520,
      };
      route.send(JSON.stringify(envelope));
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const input = ask.getByTestId('prompt-input');
  if (rich) await expect(input).toHaveAttribute('contenteditable', 'true');
  await input.fill(Array.from({ length: 12 }, (_, i) => `Question line ${i + 1}`).join('\n'));
  for (const viewport of [{ height: 520, offsetTop: 80 }, { height: 340, offsetTop: 160 }, { height: 240, offsetTop: 220 }]) {
    await page.evaluate(value => {
      for (const [key, next] of Object.entries(value)) Object.defineProperty(window.visualViewport!, key, { configurable: true, value: next });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    }, viewport);
    await input.focus();
    await input.press('End');
    // Focus/caret reveal must not scroll the floating frame itself.
    await ask.evaluate(element => { element.scrollTop = 200; });
    await expect.poll(async () => ask.evaluate((element, visible) => {
      const window = element.getBoundingClientRect();
      const heading = element.querySelector('.lab-workbench-heading')!.getBoundingClientRect();
      const input = element.querySelector('[data-testid="prompt-input"]')!.getBoundingClientRect();
      const send = element.querySelector('[data-testid="prompt-submit"]')!.getBoundingClientRect();
      return {
        headingVisible: heading.top >= window.top && heading.bottom <= window.bottom,
        inputVisible: input.top >= heading.bottom && input.bottom <= window.bottom,
        sendVisible: send.top >= heading.bottom && send.bottom <= window.bottom,
        inViewport: window.top >= visible.offsetTop && window.bottom <= visible.offsetTop + visible.height,
        keyboardGap: Math.round(visible.offsetTop + visible.height - window.bottom),
        panelScroll: element.scrollTop,
      };
    }, viewport)).toEqual({ headingVisible: true, inputVisible: true, sendVisible: true, inViewport: true, keyboardGap: 8, panelScroll: 0 });
  }
  await page.screenshot({ path: info.outputPath('ask-keyboard.png') });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    return Math.abs(box.y + box.height / 2 - 422);
  }).toBeLessThan(2);
  if (rich) await expect(input).toContainText('Question line 12');
  else await expect(input).toHaveValue(/Question line 12/);
});

test('slash questions preserve an existing Ask draft', async ({ page }) => {
  const primary = await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await ask.getByTestId('prompt-input').fill('Keep my unfinished thought');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await primary.getByTestId('prompt-input').fill('/ask A separate question');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('A separate question');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep my unfinished thought');
});

test('changing focus to a side conversation does not reopen the primary Ask', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Two visible conversations require desktop width.');
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/side');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByTestId('prompt-input').fill('/ask Explain this conversation');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  const expand = page.getByRole('button', { name: 'Expand window 2:', exact: false });
  await expand.focus();
  await expand.press('Enter');
  await expect(ask).toHaveCount(0);
  await side.getByTestId('prompt-input').click();
  await expect(side.getByTestId('prompt-input')).toBeFocused();
});

test('a subsequent slash question keeps its uncertain delivery and retries with the same operation', async ({ page }) => {
  const attempts: string[] = [];
  let dropNext = false;
  await page.routeWebSocket(/.*/, route => {
    const server = route.connectToServer();
    route.onMessage(message => {
      const envelope = JSON.parse(String(message));
      const value = envelope.type === 'message' ? envelope.message : envelope;
      if (value.type === 'send_message') {
        attempts.push(value.payload.operationId);
        if (dropNext) { dropNext = false; route.close(); server.close(); return; }
      }
      server.send(message);
    });
  });
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/ask First question');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('First question');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  dropNext = true;
  await primary.getByTestId('prompt-input').fill('/ask Uncertain second question');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('[data-delivery-state="unconfirmed"]')).toContainText('Uncertain second question');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await ask.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Uncertain second question');
  expect(attempts).toHaveLength(3);
  expect(attempts[2]).toBe(attempts[1]);
});


test('a question queued while Ask opens survives minimizing and reload', async ({ page }) => {
  const primary = await start(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/remote/create', async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await primary.getByTestId('prompt-input').fill('/ask Keep this queued question');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  release();
  await expect(primary.getByTestId('prompt-input')).toHaveValue('');
  await expect(ask).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep this queued question');
  await expect(ask.locator('.agent-message-user').filter({ hasText: 'Keep this queued question' })).toHaveCount(1);
});

test('Ask uses a content-only window with an independent simple-view toggle', async ({ page, isMobile }) => {
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  if (isMobile) await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    return Math.abs(box.y + box.height / 2 - page.viewportSize()!.height / 2);
  }).toBeLessThan(2);
  await expect(ask.locator('.agent-reasoning, .agent-tool')).toHaveCount(0);
  const toggle = ask.getByRole('button', { name: 'Simple view', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(ask.locator('.agent-tool').first()).toBeVisible();
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(ask.locator('.agent-reasoning, .agent-tool')).toHaveCount(0);
});

test('Ask can be dragged without opening and retains its own position across reload', async ({ page }, info) => {
  await start(page);
  const button = page.getByRole('button', { name: 'Ask about this session', exact: true });
  const initial = (await button.boundingBox())!;
  const target = { x: 55, y: page.viewportSize()!.height - 70 };
  if (info.project.name.includes('mobile')) {
    const input = await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [target] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await input.detach();
  } else {
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 12 }); await page.mouse.up();
  }
  const moved = (await button.boundingBox())!;
  expect(moved.y).toBeGreaterThan(initial.y + 100); expect(moved.x).toBeLessThan(60);
  await expect(page.getByRole('dialog', { name: 'Ask', exact: true })).toHaveCount(0);
  await page.reload();
  const restored = (await button.boundingBox())!;
  expect(Math.abs(restored.x - moved.x)).toBeLessThan(2); expect(Math.abs(restored.y - moved.y)).toBeLessThan(2);
  await button.focus(); await button.press('ArrowUp');
  expect((await button.boundingBox())!.y).toBeLessThan(restored.y);
});


test('Ask observes activity while minimized, signals changes itself, and switches subscriptions on Clean', async ({ page }) => {
  const activity = new Map<number, { agentId: string; emit(status: string): void }>();
  const content = new Map<number, string>();
  let activityChannels = 0;
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    const isActivity = new URL(route.url()).searchParams.get('observation') === 'activity';
    if (isActivity) activityChannels++;
    route.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'subscribe') {
        if (isActivity) activity.set(frame.subscriptionId, { agentId: frame.agentId, emit: status => route.send(JSON.stringify({
          protocolVersion: '1.5.0', type: 'message', subscriptionId: frame.subscriptionId,
          message: { protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: frame.agentId, status } },
        })) });
        else content.set(frame.subscriptionId, frame.agentId);
      }
      if (frame.type === 'unsubscribe') (isActivity ? activity : content).delete(frame.subscriptionId);
      server.send(message);
    });
  });
  await start(page);
  const primaryAgent = new URL(page.url()).searchParams.get('agent');
  const button = page.getByRole('button', { name: 'Ask about this session', exact: true });
  const floating = page.locator('.lab-ask-floating');
  await button.click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect.poll(() => activity.size).toBe(2);
  const first = [...activity.values()].find(item => item.agentId !== primaryAgent)!;
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await expect.poll(() => [...content.values()].includes(first.agentId)).toBe(false);
  expect([...activity.values()]).toContain(first);
  await expect(floating).toHaveAttribute('data-status', 'idle');
  const idleColor = await button.evaluate(element => getComputedStyle(element).backgroundColor);
  first.emit('running');
  await expect(floating).toHaveAttribute('data-status', 'working');
  const workingColor = await button.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(workingColor).not.toBe(idleColor);
  first.emit('waiting');
  await expect(floating).toHaveAttribute('data-alert', 'pending');
  await expect(button).toHaveCSS('animation-name', 'lab-tracking-pending-pulse');
  await button.click();
  await expect(floating).not.toHaveAttribute('data-alert');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await expect(floating).toHaveAttribute('data-status', 'pending');
  await expect(button).toHaveCSS('animation-name', 'none');
  const pendingColor = await button.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(pendingColor).not.toBe(workingColor); expect(pendingColor).not.toBe(idleColor);
  first.emit('running'); first.emit('idle');
  await expect(floating).toHaveAttribute('data-alert', 'idle');
  await expect(button).toHaveCSS('animation-name', 'lab-tracking-idle-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(button).toHaveCSS('animation-name', 'none');
  await button.click();
  await ask.getByRole('button', { name: 'Clean Ask' }).click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect.poll(() => [...activity.values()].some(item => item.agentId === first.agentId)).toBe(false);
  expect(activity.size).toBe(2); expect(activityChannels).toBe(1);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await expect(floating).toHaveAttribute('data-status', 'idle');
  await expect(floating).not.toHaveAttribute('data-alert');
  first.emit('waiting');
  await expect(floating).toHaveAttribute('data-status', 'idle');
  await page.reload();
  await expect(floating).toHaveAttribute('data-status', 'idle');
  await expect(ask).toHaveCount(0);
});


test('Ask reconciles a delayed standalone keyboard viewport after focus and resume', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const input = ask.getByTestId('prompt-input');
  await input.fill('Standalone keyboard draft');
  await page.evaluate(() => {
    document.dispatchEvent(new Event('focusin', { bubbles: true }));
    // Standalone WebKit can publish the final dimensions after its event.
    setTimeout(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 360 });
      Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 120 });
      Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, value: 1.0000001 });
    }, 100);
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    return Math.round(box.y + box.height);
  }).toBe(472);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    return Math.round(box.y + box.height / 2);
  }).toBe(422);
  await expect(input).toHaveValue('Standalone keyboard draft');
});


test('desktop Ask opens beside its moved button and flips above near the bottom', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop anchored overlay.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await start(page);
  const button = page.getByRole('button', { name: 'Ask about this session', exact: true });
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  for (const target of [{ x: 600, y: 120 }, { x: 1300, y: 910 }]) {
    const before = (await button.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 8 }); await page.mouse.up();
    const anchor = (await button.boundingBox())!;
    await button.click();
    await expect(ask.getByTestId('prompt-input')).toBeEnabled();
    await expect.poll(async () => {
      const box = (await ask.boundingBox())!;
      const expectedTop = target.y < 500 ? anchor.y + anchor.height + 8 : anchor.y - box.height - 8;
      return Math.abs(box.y - expectedTop);
    }).toBeLessThan(2);
    const box = (await ask.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(1428);
    await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  }
});


test('desktop Ask keeps its controls visible in a wide short window', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop anchored overlay.');
  await page.setViewportSize({ width: 1280, height: 450 });
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    return box.y >= 0 && box.y + box.height <= 450;
  }).toBe(true);
  const send = (await ask.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(450);
});


test('desktop Ask title dragging shares the button position and survives minimize and reload', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop window dragging.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  let creations = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations++; });
  const button = page.getByRole('button', { name: 'Ask about this session', exact: true });
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const floating = page.locator('.lab-ask-floating');
  const anchor = (await button.boundingBox())!;
  await button.click();
  await ask.getByTestId('prompt-input').fill('Keep my question');
  const before = (await ask.boundingBox())!;
  const heading = (await ask.locator('.lab-workbench-heading').boundingBox())!;
  await page.mouse.move(heading.x + 60, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x - 240, heading.y + heading.height / 2 + 90, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await ask.boundingBox())!.x).toBeCloseTo(before.x - 300, 0);
  const moved = (await ask.boundingBox())!;
  expect(moved.x).toBeCloseTo(before.x - 300, 0);
  expect(moved.y).toBeCloseTo(before.y + 90, 0);
  await expect.poll(async () => (await floating.boundingBox())!.x).toBeCloseTo(anchor.x - 300, 0);
  const movedAnchor = (await floating.boundingBox())!;
  expect(movedAnchor.x).toBeCloseTo(anchor.x - 300, 0);
  expect(movedAnchor.y).toBeCloseTo(anchor.y + 90, 0);
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep my question');
  expect(creations).toBe(1);
  await ask.getByRole('button', { name: 'Simple view' }).click();
  expect((await ask.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await button.click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep my question');
  expect((await ask.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  expect((await ask.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  await page.reload();
  await button.click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  expect((await ask.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  expect((await ask.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  expect(creations).toBe(1);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  const restored = (await button.boundingBox())!;
  await page.mouse.move(restored.x + 30, restored.y + 20);
  await page.mouse.down(); await page.mouse.move(330, 140, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await button.boundingBox())!.x).toBeCloseTo(300, 0);
  const newAnchor = (await button.boundingBox())!;
  await button.click();
  await expect.poll(async () => (await ask.boundingBox())!.y).toBeCloseTo(newAnchor.y + newAnchor.height + 8, 0);
});

test('desktop Ask title dragging keeps controls inside the viewport at every edge', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop window dragging.');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  for (const target of [{ x: 0, y: 0 }, { x: 1280, y: 800 }]) {
    const heading = (await ask.locator('.lab-workbench-heading').boundingBox())!;
    await page.mouse.move(heading.x + 60, heading.y + 24);
    await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 10 }); await page.mouse.up();
    const box = (await ask.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(12);
    expect(box.y).toBeGreaterThanOrEqual(12);
    expect(box.x + box.width).toBeLessThanOrEqual(1268);
    expect(box.y + box.height).toBeLessThanOrEqual(788);
    await expect(ask.getByRole('button', { name: 'Minimize Ask' })).toBeInViewport();
    await expect(ask.getByTestId('prompt-submit')).toBeInViewport();
  }
  const before = (await ask.boundingBox())!;
  await page.setViewportSize({ width: 1280, height: 450 });
  await expect.poll(async () => { const box = (await ask.boundingBox())!; return box.y + box.height <= 438; }).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await ask.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await ask.getByRole('button', { name: 'Clean Ask' }).click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  expect((await ask.boundingBox())!.x).toBeCloseTo(before.x, 0);
});

test('mobile Ask stays centered when its heading is dragged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  const before = (await ask.boundingBox())!;
  const heading = (await ask.locator('.lab-workbench-heading').boundingBox())!;
  await page.mouse.move(heading.x + 60, heading.y + 24);
  await page.mouse.down(); await page.mouse.move(heading.x + 120, heading.y + 120, { steps: 8 }); await page.mouse.up();
  expect(await ask.boundingBox()).toEqual(before);
  expect(before.y + before.height / 2).toBeCloseTo(422, 0);
});


test('/ask is off by default and toggles UI and subscriptions without losing the conversation', async ({ page }) => {
  const activity = new Map<number, string>();
  const content = new Map<number, string>();
  let creations = 0;
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    const subscriptions = new URL(route.url()).searchParams.get('observation') === 'activity' ? activity : content;
    route.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'subscribe') subscriptions.set(frame.subscriptionId, frame.agentId);
      if (frame.type === 'unsubscribe') subscriptions.delete(frame.subscriptionId);
      server.send(message);
    });
  });
  const primary = await start(page, false);
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations++; });
  const button = page.getByRole('button', { name: 'Ask about this session', exact: true });
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const toggle = async () => {
    await primary.getByTestId('prompt-input').fill('/ask');
    await primary.getByTestId('prompt-input').press('Enter');
    await expect(primary.getByTestId('prompt-input')).toHaveValue('');
  };
  await expect(button).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect.poll(() => activity.size).toBe(1);
  await expect.poll(() => content.size).toBe(1);
  await toggle();
  await expect(button).toBeVisible();
  await expect(ask).toHaveCount(0);
  expect(creations).toBe(0);
  await button.click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect.poll(() => activity.size).toBe(2);
  await expect.poll(() => content.size).toBe(2);
  await ask.getByTestId('prompt-input').fill('Remember this answer');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Remember this answer');
  await ask.getByTestId('prompt-input').fill('Preserve this draft while disabled');
  await toggle();
  await expect(button).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect.poll(() => activity.size).toBe(1);
  await expect.poll(() => content.size).toBe(1);
  await page.reload();
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(button).toHaveCount(0);
  await toggle();
  await expect(button).toBeVisible();
  await expect(ask).toHaveCount(0);
  await button.click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Preserve this draft while disabled');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Remember this answer');
  expect(creations).toBe(1);
  await ask.getByTestId('prompt-input').fill('/ask');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(button).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  await expect.poll(() => activity.size).toBe(1);
  await expect.poll(() => content.size).toBe(1);
});

for (const reopenEarly of [false, true]) test(`Ask handles disable during creation and reopens ${reopenEarly ? 'before' : 'after'} the response`, async ({ page }) => {
  const frames: { type: string; agentId?: string }[] = [];
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    route.onMessage(message => { frames.push(JSON.parse(String(message))); server.send(message); });
  });
  const primary = await start(page);
  const primaryAgent = new URL(page.url()).searchParams.get('agent');
  let release!: () => void;
  let held = false;
  let responded = false;
  let creations = 0;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/remote/create', async route => {
    creations++;
    const response = await route.fetch();
    held = true;
    await responseGate;
    await route.fulfill({ response });
    responded = true;
  });
  const button = page.getByRole('button', { name: 'Ask about this session', exact: true });
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await button.click();
  await expect.poll(() => held).toBe(true);
  await primary.getByTestId('prompt-input').fill('/ask');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(button).toHaveCount(0);
  await expect(ask).toHaveCount(0);
  if (reopenEarly) {
    await primary.getByTestId('prompt-input').fill('/ask');
    await primary.getByTestId('prompt-input').press('Enter');
    await button.click();
    await expect(ask).toBeVisible();
  }
  release();
  await expect.poll(() => responded).toBe(true);
  await expect(primary.getByTestId('prompt-input')).toHaveValue('');
  if (!reopenEarly) {
    await expect(button).toHaveCount(0);
    await expect(ask).toHaveCount(0);
    expect(frames.filter(frame => frame.type === 'subscribe' && frame.agentId !== primaryAgent)).toHaveLength(0);
    await primary.getByTestId('prompt-input').fill('/ask');
    await primary.getByTestId('prompt-input').press('Enter');
    await button.click();
  }
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  expect(creations).toBe(1);
});
