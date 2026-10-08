import { expect, test, type Locator, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

const sourceView = (owner: Locator) => owner.locator(':scope > .lab-session-view');
const askView = (owner: Locator) => owner.getByRole('dialog', { name: 'Ask', exact: true });

async function send(view: Locator, text: string) {
  await view.getByTestId('prompt-input').fill(text);
  await view.getByTestId('prompt-input').press('Enter');
}

async function expandSessionActions(view: Locator) {
  const expand = view.getByRole('button', { name: 'Expand session actions', exact: true });
  if (await expand.isVisible()) await expand.click();
}

async function buttonAppearance(button: Locator) {
  return button.evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor,
      shadow: style.boxShadow, outline: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
}

async function openComposition(page: Page, isMobile: boolean) {
  if (!isMobile) await page.setViewportSize({ width: 1900, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(sourceView(primary).getByTestId('prompt-input')).toBeEnabled();
  await expect(page).toHaveTitle('New session · Agent Remote Control');
  const primaryTitle = await page.title();
  await send(sourceView(primary), '/side A separately focused side conversation');
  const side = page.locator('.lab-side-conversation');
  await expect(sourceView(side).locator('.agent-message-assistant').last()).toContainText('A separately focused side conversation');
  const takeControl = sourceView(side).getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await expect(sourceView(side).getByTestId('prompt-input')).toBeEnabled();
  const select = async (owner: Locator, index: number) => {
    if (isMobile) await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index });
    else await sourceView(owner).getByTestId('prompt-input').focus();
    await expect(sourceView(owner)).toBeVisible();
  };
  return { primary, side, primaryTitle, select };
}

async function setDisplay(view: Locator, mode: string, letters: boolean) {
  await expandSessionActions(view);
  const trigger = view.getByRole('button', { name: 'Session view options', exact: true });
  await trigger.click();
  const options = view.getByRole('region', { name: 'Session view options', exact: true });
  await options.getByText(mode, { exact: true }).click();
  await expect(options.getByRole('radio', { name: mode, exact: true })).toBeChecked();
  if (await options.getByRole('checkbox', { name: 'Show letters', exact: true }).isChecked() !== letters) {
    await options.getByText('Show letters', { exact: true }).click();
  }
  await expect(options.getByRole('checkbox', { name: 'Show letters', exact: true })).toBeChecked({ checked: letters });
  await trigger.press('Escape');
  await expect(options).toBeHidden();
}

async function expectDisplay(view: Locator, mode: string, letters: boolean) {
  await expandSessionActions(view);
  const trigger = view.getByRole('button', { name: 'Session view options', exact: true });
  await trigger.click();
  const options = view.getByRole('region', { name: 'Session view options', exact: true });
  await expect(options.getByRole('radio', { name: mode, exact: true })).toBeChecked();
  await expect(options.getByRole('checkbox', { name: 'Show letters', exact: true })).toBeChecked({ checked: letters });
  await trigger.press('Escape');
}

async function expectContained(child: Locator, parent: Locator, fill = false) {
  await expect.poll(async () => {
    const outer = await parent.boundingBox(), inner = await child.boundingBox();
    if (!outer || !inner) return false;
    const edges = [inner.x - outer.x, inner.y - outer.y,
      outer.x + outer.width - inner.x - inner.width, outer.y + outer.height - inner.y - inner.height];
    return edges.every(edge => edge >= -1 && (!fill || edge <= 1));
  }).toBe(true);
}

async function setChromePanel(page: Page, panel: 'Header' | 'Sidebar', visible: boolean) {
  const trigger = page.getByRole('button', { name: 'View options', exact: true });
  const options = page.getByRole('region', { name: 'View options', exact: true });
  if (!await options.isVisible()) await trigger.click();
  if (await options.getByRole('checkbox', { name: panel, exact: true }).isChecked() !== visible) {
    await options.getByText(panel, { exact: true }).click();
  }
  if (await options.isVisible()) {
    await expect(options.getByRole('checkbox', { name: panel, exact: true })).toBeChecked({ checked: visible });
    await options.press('Escape');
  }
}

async function expectBeforeTitle(control: Locator, title: Locator) {
  await expect(control).toBeVisible();
  await expect(title).toBeVisible();
  await expect.poll(async () => {
    const a = await control.boundingBox(), b = await title.boundingBox();
    return !!a && !!b && a.x + a.width <= b.x + 1 && a.y < b.y + b.height && b.y < a.y + a.height;
  }, { message: 'View and the owning title share one row in reading order' }).toBe(true);
}

async function expectCenteredHeading(view: Locator) {
  const heading = view.locator('.lab-session-heading');
  const title = heading.locator('.lab-session-heading-title > :visible').first();
  await expect(title).toBeVisible();
  await expect.poll(async () => {
    const region = (await heading.boundingBox())!, label = (await title.boundingBox())!;
    return Math.abs(label.x + label.width / 2 - region.x - region.width / 2);
  }, { message: 'Session title is centered in its view' }).toBeLessThanOrEqual(1);
  const label = (await title.boundingBox())!;
  const leading = (await heading.locator('.lab-session-heading-leading').boundingBox())!;
  const trailing = (await heading.locator('.lab-session-heading-trailing').boundingBox())!;
  expect(label.x).toBeGreaterThanOrEqual(leading.x + leading.width);
  expect(label.x + label.width).toBeLessThanOrEqual(trailing.x);
}

async function openAccountFixture(page: Page) {
  const now = Date.now();
  await page.route('**/auth/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/status') return route.fulfill({ json: {
      basePath: '/u/' + 'a'.repeat(64) + '/', expiresAt: now + 120000,
      user: { id: 'alice', name: 'Alice Example' },
    } });
    if (path === '/auth/sessions') return route.fulfill({ json: { sessions: [], authenticatedAt: now, recentAuthentication: true } });
    if (path === '/auth/audit') return route.fulfill({ json: { events: [] } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/v1/stars', route => route.fulfill({ json: { stars: [] } }));
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html?gateway=1');
  await expect(page.locator('.lab-primary-conversation')).toBeVisible();
  const close = page.getByRole('button', { name: 'Close Context', exact: true });
  if (await close.isVisible()) await close.click();
}

test('view menu labels apply their selection before focus leaves the trigger', async ({ page }) => {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const view = sourceView(page.locator('.lab-primary-conversation'));
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expandSessionActions(view);
  const trigger = view.getByRole('button', { name: 'Session view options', exact: true });
  await trigger.click();
  const options = view.getByRole('region', { name: 'Session view options', exact: true });
  await options.getByText('Display', { exact: true }).click();
  await expect(options).toBeVisible();
  await options.getByText('Content only', { exact: true }).click();
  await expect(options.getByRole('radio', { name: 'Content only', exact: true })).toBeChecked();
  await expect(options).toBeVisible();
  await options.getByText('Show letters', { exact: true }).click();
  await expect(options.getByRole('checkbox', { name: 'Show letters', exact: true })).not.toBeChecked();
  await options.getByRole('radio', { name: 'Simple conversation', exact: true }).click();
  await expect(options.getByRole('radio', { name: 'Simple conversation', exact: true })).toBeChecked();
  await options.getByRole('checkbox', { name: 'Show letters', exact: true }).click();
  await expect(options.getByRole('checkbox', { name: 'Show letters', exact: true })).toBeChecked();
  await options.getByRole('checkbox', { name: 'Show letters', exact: true }).focus();
  await options.getByRole('checkbox', { name: 'Show letters', exact: true }).press('Tab');
  await expect(options).toBeHidden();
  await trigger.click();
  await expect(options.getByRole('radio', { name: 'Simple conversation', exact: true })).toBeChecked();
  await trigger.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await view.getByTestId('prompt-input').click();
  await expect(options).toBeHidden();
});

test('display mode and letters belong to each Session View and survive reload', async ({ page, isMobile }) => {
  const { primary, side, select } = await openComposition(page, isMobile);
  await select(primary, 0);
  await setDisplay(sourceView(primary), 'Content only', false);
  await expect(sourceView(primary).locator('.agent-tool')).toHaveCount(0);
  await select(side, 1);
  await setDisplay(sourceView(side), 'Simple conversation', true);
  await expect(sourceView(side).locator('.agent-tool').first()).toBeVisible();
  await select(primary, 0);
  await expectDisplay(sourceView(primary), 'Content only', false);
  await send(sourceView(primary), '/ask Explain the source without changing its presentation');
  const ask = askView(primary);
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Explain the source');
  await setDisplay(ask, 'Preview', true);
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await expectDisplay(sourceView(primary), 'Content only', false);
  await page.reload();
  await expect(sourceView(primary).getByTestId('prompt-input')).toBeEnabled();
  await select(primary, 0);
  await expectDisplay(sourceView(primary), 'Content only', false);
  await primary.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expectDisplay(ask, 'Preview', true);
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await select(side, 1);
  await expectDisplay(sourceView(side), 'Simple conversation', true);
});

test('each source keeps its own expanded Ask and restoration does not duplicate operations', async ({ page, isMobile }, testInfo) => {
  const creations: unknown[] = [], sends: string[] = [], attachments: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/create')) creations.push(request.postDataJSON());
    if (path.endsWith('/attach')) attachments.push(request.postDataJSON().nativeSessionId);
  });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const envelope = JSON.parse(String(payload));
    const message = envelope.type === 'message' ? envelope.message : envelope;
    if (message?.type === 'send_message') sends.push(JSON.stringify(message));
  }));
  const { primary, side, select } = await openComposition(page, isMobile);
  for (const [owner, index, label] of [[primary, 0, 'Primary'], [side, 1, 'Side']] as const) {
    await select(owner, index);
    await send(sourceView(owner), `/ask ${label} Ask answer`);
    const ask = askView(owner);
    await expect(ask.locator('.agent-message-assistant').last()).toContainText(`${label} Ask answer`);
    await ask.getByTestId('prompt-input').fill(`${label} Ask draft`);
    await expectContained(ask, owner, isMobile);
  }
  expect(creations).toHaveLength(4);
  if (!isMobile) {
    await expect(page.getByRole('dialog', { name: 'Ask', exact: true })).toHaveCount(2);
    await expect(askView(primary)).toBeVisible();
    await expect(askView(side)).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('source-owned-ask.png') });
  const sentBeforeReload = [...sends];
  await page.reload();
  await expect(askView(side).getByTestId('prompt-input')).toHaveValue('Side Ask draft');
  await select(primary, 0);
  await expect(askView(primary).getByTestId('prompt-input')).toHaveValue('Primary Ask draft');
  await expect(askView(primary).locator('.agent-message-assistant').last()).toContainText('Primary Ask answer');
  await askView(primary).getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await select(side, 1);
  await expect(askView(side)).toBeVisible();
  await expect(askView(side).getByTestId('prompt-input')).toHaveValue('Side Ask draft');
  expect(creations).toHaveLength(4);
  expect(sends).toEqual(sentBeforeReload);
  await expect.poll(() => new Set(attachments).size).toBe(4);
  await page.reload();
  await select(primary, 0);
  await expect(askView(primary)).toHaveCount(0);
  await expect(primary.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
  await select(side, 1);
  await expect(askView(side).getByTestId('prompt-input')).toHaveValue('Side Ask draft');
});

test('a small desktop pane overlays only its own source and expands into a floating Ask when space returns', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Uses two visible desktop containers.');
  const { primary, side, select } = await openComposition(page, false);
  await select(primary, 0);
  await send(sourceView(primary), '/ask A container-scoped overlay');
  const ask = askView(primary);
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect(ask.getByRole('button', { name: 'Resize Ask', exact: true })).toBeVisible();
  await expectContained(ask, primary);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await expect(ask.getByRole('button', { name: 'Resize Ask', exact: true })).toBeHidden();
  await expectContained(ask, primary, true);
  await sourceView(side).getByTestId('prompt-input').fill('The sibling view remains interactive');
  await expect(ask).toBeVisible();
  await expect(sourceView(side).getByTestId('prompt-input')).toHaveValue('The sibling view remains interactive');
  await page.screenshot({ path: testInfo.outputPath('narrow-source-overlay.png') });
  await page.setViewportSize({ width: 1900, height: 1000 });
  await expect(ask.getByRole('button', { name: 'Resize Ask', exact: true })).toBeVisible();
  await expectContained(ask, primary);
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  const edge = (await primary.getByRole('button', { name: 'Ask about this session', exact: true }).boundingBox())!;
  const owner = (await primary.boundingBox())!;
  expect(edge.x + edge.width).toBeCloseTo(owner.x + owner.width, 0);
});

test('browser tab title identifies the business primary session while Side and Ask receive focus', async ({ page, isMobile }) => {
  const { primary, side, primaryTitle, select } = await openComposition(page, isMobile);
  expect(primaryTitle).toBe('New session · Agent Remote Control');
  await select(side, 1);
  await expect(page).toHaveTitle(primaryTitle);
  await send(sourceView(side), '/ask Inspect the side without changing the browser title');
  await expect(askView(side).getByTestId('prompt-input')).toBeEnabled();
  await askView(side).getByTestId('prompt-input').focus();
  await expect(page).toHaveTitle(primaryTitle);
  await page.reload();
  await expect(askView(side).getByTestId('prompt-input')).toBeEnabled();
  await expect(page).toHaveTitle(primaryTitle);
  await select(primary, 0);
  await expect(page).toHaveTitle(primaryTitle);
});

test('account actions belong to the Header and View follows the visible owning title', async ({ page, isMobile }, testInfo) => {
  if (!isMobile) await page.setViewportSize({ width: 1400, height: 900 });
  await openAccountFixture(page);
  const primary = page.locator('.lab-primary-conversation');
  const draft = sourceView(primary).getByTestId('prompt-input');
  await draft.fill('Preserve this draft while moving the shell controls');
  const header = page.locator('.lab-app-bar');
  const globalView = page.getByRole('button', { name: 'View options', exact: true });
  const identity = page.getByLabel('Gateway account', { exact: true });
  const security = page.getByRole('button', { name: 'Security', exact: true });
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(header).toBeHidden();
  await expect(identity).toBeHidden();
  await expect(security).toBeHidden();
  await expect(signOut).toBeHidden();
  await setChromePanel(page, 'Header', true);
  await expect(header).toBeVisible();
  await expect(header.getByLabel('Gateway account', { exact: true })).toHaveText('◉ Alice Example');
  await expect(header.getByRole('button', { name: 'Security', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expectBeforeTitle(globalView, header.locator('.lab-brand h1'));
  await security.click();
  await expect(page.getByRole('main', { name: 'Security', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(security).toBeFocused();
  await setChromePanel(page, 'Header', false);
  await expect(header).toBeHidden();
  await expect(identity).toBeHidden();
  await expect(security).toBeHidden();
  await expect(signOut).toBeHidden();
  if (!isMobile) {
    await expectBeforeTitle(globalView, page.locator('#lab-context .lab-rail-heading').getByText('Workspace', { exact: true }));
    await setChromePanel(page, 'Sidebar', false);
  }
  const heading = isMobile ? page.locator('.lab-mobile-navigation') : sourceView(primary).locator('.lab-workbench-heading');
  const title = isMobile ? heading.locator('.lab-favorites-title') : heading.locator('.lab-primary-title');
  for (const width of isMobile ? [320, 402] : [1200, 1400]) {
    await page.setViewportSize({ width, height: isMobile ? 874 : 900 });
    await expect(globalView).toHaveCount(1);
    await expectBeforeTitle(globalView, title);
    await expectContained(globalView, heading);
    if (!isMobile) {
      await expect.poll(async () => Math.abs((await heading.boundingBox())!.y - (await page.locator('.lab-shell').boundingBox())!.y))
        .toBeLessThanOrEqual(1);
    }
    await globalView.click();
    const options = page.getByRole('region', { name: 'View options', exact: true });
    await expectContained(options, page.locator('.lab-shell'));
    await options.getByText('Panels', { exact: true }).click();
    await expect(options).toBeVisible();
    await options.press('Escape');
    await expect(globalView).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await setChromePanel(page, 'Header', true);
  await expect(security).toBeVisible();
  await expectBeforeTitle(globalView, header.locator('.lab-brand h1'));
  await expect(draft).toHaveValue('Preserve this draft while moving the shell controls');
  await page.screenshot({ path: testInfo.outputPath('header-owned-account-actions.png') });
});

test('hidden global chrome keeps View in the primary heading without duplicating Side or Ask controls', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Uses simultaneously visible desktop Session Views.');
  const { primary, side, select } = await openComposition(page, false);
  await setChromePanel(page, 'Header', false);
  await setChromePanel(page, 'Sidebar', false);
  const globalView = page.getByRole('button', { name: 'View options', exact: true });
  for (const width of [1200, 1400, 1900]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(globalView).toHaveCount(1);
    await expectBeforeTitle(globalView, sourceView(primary).locator('.lab-primary-title'));
    for (const owner of [primary, side]) {
      await expectCenteredHeading(sourceView(owner));
      const heading = sourceView(owner).locator('.lab-workbench-heading');
      const options = heading.getByRole('button', { name: 'Session view options', exact: true });
      await expectContained(options, owner);
      const title = heading.locator('.lab-primary-title, .lab-conversation-path, .lab-side-title-text').first();
      await expect(title).toBeVisible();
      await expect.poll(async () => (await title.boundingBox())!.width, { message: `Session title remains readable at ${width}px` }).toBeGreaterThan(60);
    }
    await expect(sourceView(side).getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
    await expect.poll(async () => Math.abs((await primary.boundingBox())!.y - (await page.locator('.lab-shell').boundingBox())!.y))
      .toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1200) await page.screenshot({ path: testInfo.outputPath('narrow-headings-with-inline-view.png') });
  }
  await select(side, 1);
  await send(sourceView(side), '/ask Keep the Ask controls local to this view');
  const ask = askView(side);
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expectCenteredHeading(ask);
  await expect(ask.getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
  await setDisplay(ask, 'Simple conversation', true);
  await expect(globalView).toHaveCount(1);
  await expectBeforeTitle(globalView, sourceView(primary).locator('.lab-primary-title'));
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await expectDisplay(sourceView(primary), 'Preview', true);
  await expectDisplay(sourceView(side), 'Preview', true);
});

test('mobile navigation keeps one title and session tools beside search with global chrome hidden', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Mobile heading and page panning.');
  const { primary, side, select } = await openComposition(page, isMobile);
  await select(primary, 0);
  const globalView = page.getByRole('button', { name: 'View options', exact: true });
  await setChromePanel(page, 'Header', false);
  await setChromePanel(page, 'Sidebar', false);
  const view = sourceView(primary);
  await expandSessionActions(view);
  const heading = view.locator('.lab-workbench-heading');
  const navigation = page.locator('.lab-mobile-navigation');
  const title = navigation.getByRole('combobox', { name: 'Side path' });
  const trigger = view.getByRole('button', { name: 'Session view options', exact: true });
  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(title).toBeVisible();
    await expect(title.locator('option:checked')).toHaveText('Root · New session');
    await expect(heading).toBeHidden();
    await expect(globalView).toHaveCount(1);
    await expectBeforeTitle(globalView, title);
    await expectContained(globalView, navigation);
    await expect.poll(async () => (await title.boundingBox())!.width, { message: `Primary title remains readable at ${width}px` }).toBeGreaterThan(60);
    const tools = view.getByRole('toolbar', { name: 'Session actions', exact: true });
    await expect(tools.getByRole('button', { name: 'More session actions', exact: true })).toHaveCount(0);
    await expect(tools.locator('.lab-vscode-workspace')).toHaveCount(0);
    for (const name of ['Share session link', 'Back to previous conversation', 'Forward to next conversation']) {
      await expectContained(tools.getByRole('button', { name, exact: true }), primary);
    }
    const search = view.getByRole('button', { name: 'Search this session', exact: true });
    await expectContained(search, primary);
    const searchBounds = (await search.boundingBox())!, modeBounds = (await trigger.boundingBox())!;
    expect(Math.abs(searchBounds.y + searchBounds.height / 2 - modeBounds.y - modeBounds.height / 2)).toBeLessThanOrEqual(1);
    expect(modeBounds.x + modeBounds.width).toBeLessThanOrEqual(searchBounds.x);
    await search.click();
    await expect(view.getByRole('searchbox')).toBeVisible();
    await view.getByRole('searchbox').press('Escape');
    await expect(search).toBeVisible();
    await expectContained(trigger, primary);
    await trigger.click();
    const options = view.getByRole('region', { name: 'Session view options', exact: true });
    await expect(options).toBeVisible();
    await expectContained(options, primary);
    await options.getByRole('radio', { name: 'Content only', exact: true }).check();
    await expect.poll(() => page.evaluate(() => ({ left: window.scrollX, width: document.documentElement.scrollWidth })))
      .toEqual({ left: 0, width });
    await expect.poll(async () => (await primary.boundingBox())!.x).toBe(0);
    await expectContained(trigger, primary);
    await page.screenshot({ path: testInfo.outputPath(`mobile-heading-${width}.png`) });
    await trigger.press('Escape');
    await expect(options).toBeHidden();
  }
  await select(side, 1);
  await expectBeforeTitle(globalView, title);
  await expect(sourceView(side).locator('.lab-workbench-heading')).toBeHidden();
  await expect(sourceView(primary).getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
  await setChromePanel(page, 'Header', true);
  await expectBeforeTitle(globalView, page.locator('.lab-app-bar .lab-brand h1'));
  await setChromePanel(page, 'Header', false);
  await expectBeforeTitle(globalView, title);
  await expectDisplay(sourceView(side), 'Preview', true);
  await send(sourceView(side), '/ask Keep the narrow session title centered');
  const ask = askView(side);
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 844 });
    await expectCenteredHeading(ask);
    await setDisplay(ask, 'Simple conversation', true);
    await expectContained(ask.getByRole('button', { name: 'Minimize Ask', exact: true }), ask);
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-ask-centered.png') });
});

test('mobile session actions start collapsed and toggle without moving the reading position', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Uses the mobile Session View toolbar.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  const view = sourceView(primary);
  const input = view.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  const message = Array.from({ length: 24 }, (_, index) => `Reading line ${index + 1}: keep this conversation in place when hiding its actions.`).join('\n');
  await send(view, message);
  await expect(view.locator('.agent-message-assistant').last()).toContainText('Reading line 24');
  await input.fill('Keep this unsent draft');
  const timeline = view.getByTestId('timeline');
  const tools = view.getByRole('toolbar', { name: 'Session actions', exact: true });
  const collapse = tools.getByRole('button', { name: 'Collapse session actions', exact: true });
  const expand = tools.getByRole('button', { name: 'Expand session actions', exact: true });
  const controls = [
    view.getByRole('button', { name: 'Session view options', exact: true }),
    view.getByRole('button', { name: 'Search this session', exact: true }),
    view.getByRole('button', { name: 'Share session link', exact: true }),
    view.getByRole('button', { name: 'Back to previous conversation', exact: true }),
    view.getByRole('button', { name: 'Forward to next conversation', exact: true }),
  ] as const;
  await expect(tools.getByRole('button', { name: 'More session actions', exact: true })).toHaveCount(0);
  await expect(tools.locator('.lab-vscode-workspace')).toHaveCount(0);
  await expect(expand).toBeVisible();
  await expect(collapse).toBeHidden();
  await expect(tools.getByRole('button')).toHaveCount(1);
  for (const control of controls) await expect(control).toBeHidden();
  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 844 });
    await expandSessionActions(view);
    await expect(collapse).toBeVisible();
    await expect(expand).toBeHidden();
    for (const control of controls) await expect(control).toBeVisible();
    await timeline.focus();
    await timeline.evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -180, bubbles: true }));
      element.scrollTop = -180;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect.poll(() => timeline.evaluate(element => element.scrollTop)).toBe(-180);
    const readingTop = await timeline.evaluate(element => element.scrollTop);
    const viewport = (await timeline.boundingBox())!;
    const originalTools = await Promise.all(controls.map(async control => ({ element: (await control.elementHandle())!, box: (await control.boundingBox())! })));
    await collapse.click();
    await expect(expand).toBeVisible();
    for (const control of controls) await expect(control).toBeHidden();
    for (const { element, box } of originalTools) {
      expect(await element.evaluate((node, point) => {
        const target = document.elementFromPoint(point.x, point.y);
        (node as HTMLElement).focus();
        return { focused: document.activeElement === node, clickable: target !== null && node.contains(target) };
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toEqual({ focused: false, clickable: false });
    }
    await expand.focus();
    await expand.press('Tab');
    for (const { element } of originalTools) expect(await element.evaluate(node => document.activeElement === node)).toBe(false);
    await expectContained(expand, primary);
    await expect.poll(async () => {
      const owner = (await primary.boundingBox())!, button = (await expand.boundingBox())!;
      return owner.x + owner.width - button.x - button.width;
    }, { message: 'Collapsed actions stay against the right edge of their Session View' }).toBeLessThanOrEqual(12);
    expect(await timeline.boundingBox()).toEqual(viewport);
    await expect.poll(() => timeline.evaluate(element => element.scrollTop)).toBe(readingTop);
    await expect(input).toHaveValue('Keep this unsent draft');
    expect(await page.evaluate(() => ({ left: scrollX, width: document.documentElement.scrollWidth }))).toEqual({ left: 0, width });
    await page.screenshot({ path: testInfo.outputPath(`mobile-session-actions-collapsed-${width}.png`) });
    await expand.click();
    await expect(collapse).toBeVisible();
    for (const control of controls) await expect(control).toBeVisible();
    expect(await timeline.boundingBox()).toEqual(viewport);
    await expect.poll(() => timeline.evaluate(element => element.scrollTop)).toBe(readingTop);
    await expectDisplay(view, 'Preview', true);
    await controls[1].click();
    await expect(view.getByRole('searchbox')).toBeVisible();
    await view.getByRole('searchbox').press('Escape');
    await controls[2].click();
    const share = page.getByRole('dialog', { name: 'Share session', exact: true });
    await expect(share).toBeVisible();
    await share.getByRole('button', { name: 'Close session link', exact: true }).click();
    await expect(controls[2]).toBeFocused();
    await collapse.click();
    await expect(expand).toBeVisible();
    await timeline.focus();
    await timeline.press('Control+f');
    await expect(view.getByRole('searchbox')).toBeVisible();
    await expect(collapse).toBeVisible();
    await view.getByRole('searchbox').press('Escape');
    await expect(controls[1]).toBeVisible();
    await expect(controls[1]).toBeFocused();
    await expect(input).toHaveValue('Keep this unsent draft');
    expect(await page.evaluate(() => ({ left: scrollX, width: document.documentElement.scrollWidth }))).toEqual({ left: 0, width });
    await page.screenshot({ path: testInfo.outputPath(`mobile-session-actions-expanded-${width}.png`) });
    for (const { element } of originalTools) await element.dispose();
  }
});

test('mobile action taps settle to a neutral appearance with normal motion', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Uses real touch input for the floating session actions.');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  const view = sourceView(primary);
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  const timeline = view.getByTestId('timeline');
  const tools = view.getByRole('toolbar', { name: 'Session actions', exact: true });
  const expand = tools.getByRole('button', { name: 'Expand session actions', exact: true });
  const collapse = tools.getByRole('button', { name: 'Collapse session actions', exact: true });
  const mode = tools.getByRole('button', { name: 'Session view options', exact: true });
  const share = tools.getByRole('button', { name: 'Share session link', exact: true });
  const search = tools.getByRole('button', { name: 'Search this session', exact: true });
  const options = view.getByRole('region', { name: 'Session view options', exact: true });
  const settleTools = () => expect.poll(() => tools.evaluate(element =>
    element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  for (const width of [320, 402]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(expand).toBeVisible();
    await expect(tools.getByRole('button')).toHaveCount(1);
    const idleCollapsed = await buttonAppearance(expand);
    const before = await timeline.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, y: element.getBoundingClientRect().y }));
    await tools.evaluate(element => {
      (element.querySelector('.lab-timeline-tools-toggle') as HTMLButtonElement).click();
      (element.querySelector('.lab-session-view-options-trigger') as HTMLButtonElement).click();
    });
    await expect(options).toBeVisible();
    const menuOffsets = await options.evaluate(async element => {
      const content = element.closest('.lab-timeline-tools-content')!;
      const offsets = [];
      const started = performance.now();
      do {
        offsets.push(element.getBoundingClientRect().right - content.getBoundingClientRect().right);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      } while (performance.now() - started < 360);
      return offsets;
    });
    expect(Math.max(...menuOffsets) - Math.min(...menuOffsets), 'The menu keeps its anchor while the toolbar finishes expanding').toBeLessThan(1);
    await expectContained(options, primary);
    await mode.tap();
    await expect(options).toBeHidden();
    await collapse.tap();
    await settleTools();
    await expand.tap();
    const frames = await timeline.evaluate(async element => {
      const samples = [];
      const started = performance.now();
      do {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push({ top: element.scrollTop, height: element.clientHeight, y: element.getBoundingClientRect().y,
          pageLeft: scrollX, pageWidth: document.documentElement.scrollWidth });
      } while (performance.now() - started < 360);
      return samples;
    });
    for (const frame of frames) expect(frame).toEqual({ ...before, pageLeft: 0, pageWidth: width });
    await expect(collapse).toBeVisible();
    await expect(mode).toBeVisible();
    await expect(share).toBeVisible();
    await expect(search).toBeVisible();
    await expect(tools.getByRole('button', { name: 'More session actions', exact: true })).toHaveCount(0);
    await expect(tools.locator('.lab-vscode-workspace')).toHaveCount(0);
    const idleMode = await buttonAppearance(mode);
    await mode.tap();
    await expect(options).toBeVisible();
    await expectContained(options, primary);
    await mode.tap();
    await expect(options).toBeHidden();
    await expect.poll(() => buttonAppearance(mode)).toEqual(idleMode);
    const idleShare = await buttonAppearance(share);
    await share.tap();
    const dialog = page.getByRole('dialog', { name: 'Share session', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close session link', exact: true }).tap();
    await expect(dialog).toBeHidden();
    await expect.poll(() => buttonAppearance(share)).toEqual(idleShare);
    const idleSearch = await buttonAppearance(search);
    await search.tap();
    await expect(view.getByRole('searchbox')).toBeVisible();
    await view.getByRole('button', { name: 'Close session search', exact: true }).tap();
    await expect(view.getByRole('searchbox')).toBeHidden();
    await expect.poll(() => buttonAppearance(search)).toEqual(idleSearch);
    await settleTools();
    await page.screenshot({ path: testInfo.outputPath(`mobile-actions-touch-expanded-${width}.png`) });
    await collapse.tap();
    await expect(expand).toBeVisible();
    await expect(tools.getByRole('button')).toHaveCount(1);
    await expect.poll(() => buttonAppearance(expand)).toEqual(idleCollapsed);
    expect(await expand.evaluate(element => element.matches(':focus-visible'))).toBe(false);
    await settleTools();
    await expect(tools.locator('.lab-timeline-tools-content')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`mobile-actions-touch-collapsed-${width}.png`) });
  }
});

test('desktop standalone search does not gain the mobile action toggle', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Uses the desktop inline Session View heading.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const view = sourceView(page.locator('.lab-primary-conversation'));
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
  await expect(view.getByRole('button', { name: 'Collapse session actions', exact: true })).toHaveCount(0);
  await expect(view.getByRole('button', { name: 'Expand session actions', exact: true })).toHaveCount(0);
  const search = view.getByRole('button', { name: 'Search this session', exact: true });
  await expect(search).toBeVisible();
  await search.click();
  await expect(view.getByRole('searchbox')).toBeVisible();
  await view.getByRole('searchbox').press('Escape');
  await expect(search).toBeVisible();
});
