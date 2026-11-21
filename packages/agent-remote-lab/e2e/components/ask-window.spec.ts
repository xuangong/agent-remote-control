import { expect, test, type Locator, type Page } from '@playwright/test';
import { activateComposerAction } from '../composer-actions';

// The Ask window of a session on builder states (fixtures/ask-window.tsx): the real SessionAsk and AskButton over a mock transport, no Relay.
// What it shows: where the window sits and how big it is, how it follows the page, the visible area and the keyboard, and how its launcher
// moves. What the Ask asks of its source, the Relay and the Controller is the Workbench's state rules (hooks/useAskConversations*.test.tsx).
test.setTimeout(40_000);
const fixture = '/e2e/fixtures/ask-window.html';
const margin = 12;

const askOf = (page: Page) => page.getByRole('dialog', { name: 'Ask', exact: true });
const launcherOf = (page: Page) => page.getByRole('button', { name: 'Ask about this session', exact: true });
const surfaceOf = (page: Page) => page.locator('.lab-ask-workspaces');

async function open(page: Page, query = 'open') {
  await page.goto(`${fixture}?${query}`);
  const ask = askOf(page);
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  return ask;
}

/** The window lies inside the surface it floats over, a margin from every edge. */
async function insideSurface(page: Page, ask: Locator, edge = margin) {
  const source = (await surfaceOf(page).boundingBox())!, box = (await ask.boundingBox())!;
  return box.x >= source.x + edge - .5 && box.y >= source.y + edge - .5 && box.x + box.width <= source.x + source.width - edge + .5 && box.y + box.height <= source.y + source.height - edge + .5;
}

for (const running of [false, true]) test(`the Ask is a 440 px floating window from 600 px wide and a full-width overlay below it, with its composer panels inside it ${running ? 'while it works' : 'while it is idle'}`, async ({ page }, info) => {
  const ask = await open(page, `open&imageInput${running ? '&running' : ''}`);
  const input = ask.getByTestId('prompt-input');
  await input.fill('Keep this Ask draft');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(ask.locator('..')).toHaveAttribute('data-presentation', width >= 600 ? 'floating' : 'overlay');
    await expect.poll(async () => (await ask.boundingBox())!.width).toBe(width >= 600 ? 440 : width);
    if (running) await expect(ask.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    for (const [action, label] of [['Model', 'Model settings'], ['Permissions', 'Permission settings'], ['Status', 'Session status']] as const) {
      const before = (await ask.getByTestId('timeline').boundingBox())!;
      const trigger = await activateComposerAction(ask, action, true);
      const panel = ask.getByRole('region', { name: label, exact: true });
      await expect(panel).toBeVisible();
      const bounds = (await ask.boundingBox())!, menu = (await panel.boundingBox())!;
      expect(menu.x).toBeGreaterThanOrEqual(bounds.x);
      expect(menu.y).toBeGreaterThanOrEqual(bounds.y);
      expect(menu.x + menu.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect((await ask.getByTestId('timeline').boundingBox())!.height).toBe(before.height);
      await page.keyboard.press('Escape');
      await expect(ask).toBeVisible();
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    await expect(input).toContainText('Keep this Ask draft');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await ask.screenshot({ path: info.outputPath(`ask-composer-${width}.png`) });
  }
  // Minimizing keeps the draft for the next opening; Escape inside the window minimizes it.
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await expect(ask).toHaveCount(0);
  await launcherOf(page).click();
  await expect(input).toContainText('Keep this Ask draft');
  await ask.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(launcherOf(page)).toBeFocused();
});

test('Escape closes the Ask\'s own settings first and then the Ask, and leaves the session\'s open settings alone', async ({ page, isMobile }) => {
  await page.goto(`${fixture}?open`);
  const ask = askOf(page);
  const primary = page.locator('.lab-primary-conversation');
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await activateComposerAction(primary, 'Model');
  const background = primary.getByRole('region', { name: 'Model settings', exact: true, includeHidden: true });
  await expect(background).toBeVisible();
  await launcherOf(page).focus();
  await launcherOf(page).press('Enter');
  await expect(ask).toBeFocused();
  const stillOpen = async () => {
    await expect(background).toHaveJSProperty('hidden', false);
    if (!isMobile) await expect(background).toBeVisible();
  };
  await stillOpen();
  const askModel = await activateComposerAction(ask, 'Model', true);
  const own = ask.getByRole('region', { name: 'Model settings', exact: true });
  await expect(own).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(own).toBeHidden();
  await stillOpen();
  await expect(askModel).toBeFocused();
  await ask.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(background).toBeVisible();
  await expect(launcherOf(page)).toBeFocused();
});

test('the Ask stays inside a small viewport and follows the visual keyboard viewport', async ({ page }, info) => {
  const ask = await open(page);
  for (const size of [{ width: 844, height: 390 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const box = (await ask.boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
    }).toBe(true);
  }
  await page.screenshot({ path: info.outputPath('ask-small-viewport.png') });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 340 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!, input = (await ask.getByTestId('prompt-input').boundingBox())!;
    return box.y >= 0 && box.y + box.height <= 340 && input.y >= box.y && input.y + input.height <= box.y + box.height;
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

for (const rich of [false, true]) test(`on a phone the Ask keeps its heading and multiline editor ${rich ? 'with' : 'without'} image capability above a panned keyboard`, async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile') && !info.project.name.startsWith('orchard-phone'), 'A phone viewport.');
  await page.setViewportSize({ width: 390, height: 844 });
  const ask = await open(page, rich ? 'open&imageInput' : 'open');
  const input = ask.getByTestId('prompt-input');
  if (rich) await expect(input).toHaveAttribute('contenteditable', 'true');
  await input.fill(Array.from({ length: 12 }, (_, i) => `Question line ${i + 1}`).join('\n'));
  for (const viewport of [{ height: 520, offsetTop: 80 }, { height: 340, offsetTop: 160 }]) {
    await page.evaluate(value => {
      for (const [key, next] of Object.entries(value)) Object.defineProperty(window.visualViewport!, key, { configurable: true, value: next });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    }, viewport);
    await input.focus();
    await input.press('End');
    // Focus and caret reveal must not scroll the floating frame itself.
    await ask.evaluate(element => { element.scrollTop = 200; });
    await expect.poll(async () => ask.evaluate((element, visible) => {
      const frame = element.getBoundingClientRect();
      const heading = element.querySelector('.lab-workbench-heading')!.getBoundingClientRect();
      const editor = element.querySelector('[data-testid="prompt-input"]')!.getBoundingClientRect();
      const send = element.querySelector('[data-testid="prompt-submit"]')!.getBoundingClientRect();
      return {
        headingVisible: heading.top >= frame.top && heading.bottom <= frame.bottom,
        inputVisible: editor.top >= heading.bottom && editor.bottom <= frame.bottom,
        sendVisible: send.top >= heading.bottom && send.bottom <= frame.bottom,
        inViewport: frame.top >= visible.offsetTop && frame.bottom <= visible.offsetTop + visible.height,
        panelScroll: element.scrollTop,
      };
    }, viewport)).toEqual({ headingVisible: true, inputVisible: true, sendVisible: true, inViewport: true, panelScroll: 0 });
  }
  await page.screenshot({ path: info.outputPath('ask-keyboard.png') });
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!, owner = (await surfaceOf(page).boundingBox())!;
    return Math.abs(box.y + box.height - owner.y - owner.height);
  }).toBeLessThan(2);
  await expect(input).toContainText('Question line 12');
});

test('on a phone added to the home screen the Ask reconciles a keyboard viewport that arrives late, after focus and after resume', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile') && !info.project.name.startsWith('orchard-phone'), 'A phone viewport.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  const ask = await open(page);
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
  await expect.poll(async () => { const box = (await ask.boundingBox())!; return Math.round(box.y + box.height); }).toBe(480);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    window.dispatchEvent(new Event('pageshow'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!, owner = (await surfaceOf(page).boundingBox())!;
    return Math.abs(box.y + box.height - owner.y - owner.height);
  }).toBeLessThan(1);
  await expect(input).toHaveText('Standalone keyboard draft');
});

test('on a desktop the Ask floats inside the surface a margin from every edge and leaves the page navigation uncovered', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A desktop window.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ask = await open(page);
  expect(await insideSurface(page, ask)).toBe(true);
  const bar = (await page.locator('.lab-app-bar').boundingBox())!, box = (await ask.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
});

test('the source composer stays usable beside an open Ask while the page narrows, and the Ask keeps its size and its draft', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A desktop window.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ask = await open(page);
  await ask.getByTestId('prompt-input').fill('Keep the Ask draft while the source narrows');
  const widened = (await ask.boundingBox())!;
  await page.setViewportSize({ width: 1200, height: 1000 });
  await expect.poll(() => insideSurface(page, ask)).toBe(true);
  const narrowed = (await ask.boundingBox())!;
  expect(narrowed.width).toBeCloseTo(widened.width, 0);
  expect(narrowed.height).toBeCloseTo(widened.height, 0);
  expect(narrowed.width).toBeLessThan((await surfaceOf(page).boundingBox())!.width);
  const source = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await source.click({ timeout: 5_000 });
  await source.fill('The source stays interactive with the Ask open');
  await expect(source).toBeFocused();
  await expect(source).toHaveValue('The source stays interactive with the Ask open');
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toHaveText('Keep the Ask draft while the source narrows');
});

test('on a wide short desktop window the Ask keeps its controls visible', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A desktop window.');
  await page.setViewportSize({ width: 1280, height: 450 });
  const ask = await open(page);
  await expect.poll(async () => { const box = (await ask.boundingBox())!; return box.y >= 0 && box.y + box.height <= 450; }).toBe(true);
  const send = (await ask.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(450);
});

test('dragging the Ask by its title keeps it inside the page at every edge, through a short window,', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Window dragging is a desktop gesture.');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const ask = await open(page);
  for (const target of [{ x: 0, y: 0 }, { x: 1280, y: 800 }]) {
    const heading = (await ask.locator('.lab-session-heading-title').boundingBox())!;
    await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
    await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 10 }); await page.mouse.up();
    expect(await insideSurface(page, ask)).toBe(true);
    await expect(ask.getByRole('button', { name: 'Minimize Ask' })).toBeInViewport();
    await expect(ask.getByTestId('prompt-submit')).toBeInViewport();
  }
  const before = (await ask.boundingBox())!;
  await page.setViewportSize({ width: 1280, height: 450 });
  await expect.poll(async () => { const box = (await ask.boundingBox())!, owner = (await surfaceOf(page).boundingBox())!; return box.y >= owner.y && box.y + box.height <= owner.y + owner.height; }).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await ask.boundingBox())!.y).toBeCloseTo(before.y, 0);
});

test('on a phone the Ask covers the page and does not move when its heading is dragged', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile') && !info.project.name.startsWith('orchard-phone'), 'A phone viewport.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const ask = await open(page);
  const before = (await ask.boundingBox())!;
  const heading = (await ask.locator('.lab-session-heading-title').boundingBox())!;
  const center = { x: heading.x + heading.width / 2, y: heading.y + heading.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down(); await page.mouse.move(center.x + 60, center.y + 96, { steps: 8 }); await page.mouse.up();
  expect(await ask.boundingBox()).toEqual(before);
  expect(before).toEqual(await surfaceOf(page).boundingBox());
});

/** The launcher's centre, which a drag moves. */
const centerOf = async (button: Locator) => { const box = (await button.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };

test('the floating Ask launcher moves freely without snapping, opens only on a click, keeps its place after reload and moves by keys', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A mouse drag; the touch drag is the phone project below.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${fixture}?floating`);
  const launcher = launcherOf(page), ask = askOf(page);
  await expect(launcher).toBeEnabled();
  const start = await centerOf(launcher);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x - 300, start.y + 90, { steps: 5 });
  await page.mouse.up();
  const moved = (await launcher.boundingBox())!;
  expect(moved.y + moved.height / 2).toBeCloseTo(start.y + 90, 0);
  expect(moved.x + moved.width / 2).toBeCloseTo(start.x - 300, 0);
  await expect(ask).toHaveCount(0);
  await launcher.click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.reload();
  const restored = (await launcher.boundingBox())!;
  expect(Math.max(Math.abs(restored.x - moved.x), Math.abs(restored.y - moved.y))).toBeLessThan(1);
  await launcher.focus();
  await launcher.press('ArrowLeft');
  await launcher.press('Shift+ArrowDown');
  await expect.poll(async () => { const box = (await launcher.boundingBox())!; return [Math.round(box.x - moved.x), Math.round(box.y - moved.y)]; }).toEqual([-10, 40]);
  await expect(launcher).toBeFocused();
});

test('the floating Ask launcher stays inside the viewport across resizing and opens from the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'A desktop window.');
  await page.goto(`${fixture}?floating`);
  const launcher = launcherOf(page);
  for (const width of [1440, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => { const box = (await launcher.boundingBox())!; return box.x >= margin && box.y >= margin && box.x + box.width <= width - margin && box.y + box.height <= 900 - margin; }).toBe(true);
  }
  await launcher.focus();
  await launcher.press('Enter');
  await expect(askOf(page)).toBeVisible();
});

test('the Ask launcher shows what the Ask is doing and pulses on a change, and holds still under reduced motion', async ({ page }) => {
  await page.goto(`${fixture}?floating`);
  const launcher = launcherOf(page), root = page.locator('.lab-ask-floating');
  const observe = (activity: string, attention?: string) => page.evaluate(value => (window as unknown as { setAskObservation(v: unknown): void }).setAskObservation(value), { connection: 'ready', activity, ...(attention ? { attention } : {}) });
  const color = () => launcher.evaluate(element => getComputedStyle(element).backgroundColor);
  await observe('idle');
  await expect(root).toHaveAttribute('data-status', 'idle');
  const idle = await color();
  await observe('running');
  await expect(root).toHaveAttribute('data-status', 'working');
  const working = await color();
  expect(working).not.toBe(idle);
  await observe('waiting', 'pending');
  await expect(root).toHaveAttribute('data-alert', 'pending');
  await expect(launcher).toHaveCSS('animation-name', 'lab-tracking-pending-pulse');
  await observe('idle', 'idle');
  await expect(root).toHaveAttribute('data-alert', 'idle');
  await expect(launcher).toHaveCSS('animation-name', 'lab-tracking-idle-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(launcher).toHaveCSS('animation-name', 'none');
});

test('on a phone the floating Ask launcher follows a finger without snapping and does not open when dragged', async ({ page }, info) => {
  test.skip(!info.project.name.includes('mobile') && !info.project.name.startsWith('orchard-phone'), 'A phone viewport.');
  test.skip(info.project.name.includes('webkit'), 'CDP touch input is Chromium only; the mouse drag above runs in WebKit.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?floating`);
  const launcher = launcherOf(page);
  const start = await centerOf(launcher), target = { x: start.x - 60, y: start.y + 120 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 4; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (target.x - start.x) * step / 4, y: start.y + (target.y - start.y) * step / 4, id: 1 }] });
  await expect.poll(async () => { const now = await centerOf(launcher); return Math.hypot(now.x - target.x, now.y - target.y); }).toBeLessThan(1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(askOf(page)).toHaveCount(0);
  const final = await centerOf(launcher);
  expect(Math.hypot(final.x - target.x, final.y - target.y)).toBeLessThan(1);
});

test('a file opened from the Ask previews in the page\'s workspace above the Ask, keeps the Ask inside its surface, and returns focus to the file on close', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop previews share the non-modal workspace.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ask = await open(page, 'open&resources');
  const file = ask.getByRole('button', { name: 'lab-proof.txt', exact: true });
  await file.click();
  const preview = page.getByRole('dialog', { name: 'File preview', exact: true });
  await expect(preview).toBeVisible();
  await expect(page.locator('.agent-preview-workspace')).toHaveCount(1);
  await expect.poll(() => preview.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  expect(await insideSurface(page, ask)).toBe(true);
  await preview.getByRole('button', { name: 'Close file preview' }).click();
  await expect(preview).toBeHidden();
  await expect(ask).toBeVisible();
  await expect(file).toBeFocused();
});

for (const side of ['left', 'right'] as const) test(`an Ask opened beside the ${side} launcher covers neither the launcher nor the controls at that edge, and keeps its draft while they are used`, async ({ page, isMobile }) => {
  test.skip(isMobile, 'A desktop window.');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixture}?floating`);
  const launcher = launcherOf(page), ask = askOf(page);
  if (side === 'left') {
    const start = await centerOf(launcher);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(60, start.y, { steps: 6 }); await page.mouse.up();
  }
  await launcher.click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByTestId('prompt-input').fill('Keep this question while using page controls');
  const apart = async () => {
    const a = (await ask.boundingBox())!, l = (await launcher.boundingBox())!;
    const clear = a.x + a.width <= l.x || l.x + l.width <= a.x || a.y + a.height <= l.y || l.y + l.height <= a.y;
    const hit = await launcher.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
    return clear && hit;
  };
  await expect.poll(apart).toBe(true);
  // Using the page's own controls does not touch the draft.
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await page.getByRole('button', { name: 'Close Windows', exact: true }).click();
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toContainText('Keep this question while using page controls');
});
