import { expect, test, type Locator, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';
import { toggleViewPanel } from './view-options';

const sourceView = (owner: Locator) => owner.locator('.lab-session-view');
const sourceIdentities = new WeakMap<Locator, string>();
const askTrigger = (page: Page) => page.getByRole('button', { name: 'Ask about this session', exact: true });
function askView(owner: Locator) {
  const source = sourceIdentities.get(owner);
  if (!source) throw new Error('The source session identity has not been captured.');
  return owner.page().locator(`.lab-ask-workspaces [data-ask-source=${JSON.stringify(source)}]`)
    .getByRole('dialog', { name: 'Ask', exact: true });
}

function createdSession(page: Page) {
  return page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'))
    .then(async response => {
      expect(response.ok(), await response.text()).toBe(true);
      const { nativeSessionId } = await response.json() as { nativeSessionId: string };
      const { providerId } = response.request().postDataJSON() as { providerId: string };
      return { nativeSessionId, key: JSON.stringify(['local', providerId, nativeSessionId]) };
    });
}

async function send(view: Locator, text: string) {
  await view.getByTestId('prompt-input').fill(text);
  await expect(view.getByTestId('prompt-submit')).toBeEnabled();
  await view.getByTestId('prompt-input').press('Enter');
}

async function expandSessionActions(view: Locator) {
  await expect(view).toBeVisible();
  const expand = view.getByRole('button', { name: 'Expand session actions', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(view.getByRole('button', { name: 'Session view options', exact: true })).toBeVisible();
}

async function openComposition(page: Page, isMobile: boolean) {
  if (!isMobile) await page.setViewportSize({ width: 1900, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await showNewSession(page);
  const primaryCreated = createdSession(page);
  await page.getByTestId('session-create').click();
  const primaryIdentity = await primaryCreated;
  const primary = page.locator('[data-workbench-mode="window"] .lab-primary-conversation');
  sourceIdentities.set(primary, primaryIdentity.key);
  await expect(sourceView(primary).getByTestId('prompt-input')).toBeEnabled();
  await expect(page).toHaveTitle('New session · Orchard');
  const primaryTitle = await page.title();
  const sideCreated = createdSession(page);
  await send(sourceView(primary), '/side A separately focused side conversation');
  const sideIdentity = await sideCreated;
  const side = page.locator('[data-workbench-mode="window"] .lab-side-conversation');
  sourceIdentities.set(side, sideIdentity.key);
  await expect(sourceView(side).locator('.agent-message-assistant').last()).toContainText('A separately focused side conversation');
  const takeControl = sourceView(side).getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await expect(sourceView(side).getByTestId('prompt-input')).toBeEnabled();
  const select = async (owner: Locator, index: number) => {
    if (isMobile) await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index });
    else await sourceView(owner).getByTestId('prompt-input').focus();
    await expect(sourceView(owner)).toBeVisible();
  };
  return { primary, side, primaryTitle, primaryIdentity, sideIdentity, select };
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
  const { primary, side, primaryIdentity, sideIdentity, select } = await openComposition(page, isMobile);
  const askIdentities: string[] = [];
  for (const [owner, index, label] of [[primary, 0, 'Primary'], [side, 1, 'Side']] as const) {
    await select(owner, index);
    const askCreated = createdSession(page);
    await send(sourceView(owner), `/ask ${label} Ask answer`);
    askIdentities.push((await askCreated).nativeSessionId);
    const ask = askView(owner);
    await expect(ask.locator('.agent-message-assistant').last()).toContainText(`${label} Ask answer`);
    await ask.getByTestId('prompt-input').fill(`${label} Ask draft`);
    await expectContained(ask, page.locator('.lab-ask-workspaces'), isMobile);
  }
  expect(creations).toHaveLength(4);
  expect(creations[2]).toMatchObject({ sourceNativeSessionId: primaryIdentity.nativeSessionId });
  expect(creations[3]).toMatchObject({ sourceNativeSessionId: sideIdentity.nativeSessionId });
  await expect(askTrigger(page)).toHaveCount(1);
  if (!isMobile) {
    await expect(page.getByRole('dialog', { name: 'Ask', exact: true })).toHaveCount(2);
    await expect(askView(primary)).toBeVisible();
    await expect(askView(side)).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('source-owned-ask.png') });
  const sentBeforeReload = [...sends];
  await page.reload();
  await expect(askView(side).getByTestId('prompt-input')).toHaveText('Side Ask draft');
  await select(primary, 0);
  if (isMobile) await askTrigger(page).click();
  await askView(primary).getByTestId('prompt-input').focus();
  await expect(askView(primary).getByTestId('prompt-input')).toHaveText('Primary Ask draft');
  await expect(askView(primary).locator('.agent-message-assistant').last()).toContainText('Primary Ask answer');
  await askView(primary).getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await select(side, 1);
  if (isMobile) await askTrigger(page).click();
  await expect(askView(side)).toBeVisible();
  await expect(askView(side).getByTestId('prompt-input')).toHaveText('Side Ask draft');
  expect(creations).toHaveLength(4);
  expect(sends).toEqual(sentBeforeReload);
  await expect.poll(() => new Set(attachments)).toEqual(new Set([primaryIdentity.nativeSessionId, sideIdentity.nativeSessionId, ...askIdentities]));
  await page.reload();
  await select(primary, 0);
  await expect(askView(primary)).toHaveCount(0);
  await expect(askTrigger(page)).toBeVisible();
  await expect(askTrigger(page)).toHaveCount(1);
  await select(side, 1);
  if (isMobile) await askTrigger(page).click();
  await expect(askView(side).getByTestId('prompt-input')).toHaveText('Side Ask draft');
  expect(creations).toHaveLength(4);
  expect(sends).toEqual(sentBeforeReload);
});

test('Ask stays floating over the page while source panes resize and remain interactive', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Uses two visible desktop containers.');
  const { primary, side, select } = await openComposition(page, false);
  // The Ask capsule floats over the page only while the desktop sidebar is hidden; the sidebar holds it as a Shortcuts row otherwise.
  await toggleViewPanel(page, 'Sidebar');
  await expect(page.locator('#lab-context')).toBeHidden();
  await select(primary, 0);
  await send(sourceView(primary), '/ask A source-bound global floating conversation');
  const ask = askView(primary);
  const workspace = page.locator('.lab-ask-workspaces');
  const resize = ask.getByRole('button', { name: 'Resize Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect(resize).toBeVisible();
  await expectContained(ask, workspace);
  const originalSourceWidth = (await primary.boundingBox())!.width;
  const originalAsk = (await ask.boundingBox())!;
  const sourceResize = page.getByRole('separator', { name: 'New session width', exact: true });
  await ask.getByTestId('prompt-input').fill('Keep the Ask draft while resizing its source');
  await sourceResize.press('Home');
  await expect.poll(async () => (await primary.boundingBox())!.width).toBeLessThan(originalSourceWidth);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await expect(resize).toBeVisible();
  await expectContained(ask, workspace);
  const narrowAsk = (await ask.boundingBox())!;
  expect(narrowAsk.width).toBeCloseTo(originalAsk.width, 0);
  expect(narrowAsk.height).toBeCloseTo(originalAsk.height, 0);
  expect(narrowAsk.width).toBeLessThan((await workspace.boundingBox())!.width);
  for (const [owner, label] of [[primary, 'Source'], [side, 'Sibling']] as const) {
    const input = sourceView(owner).getByTestId('prompt-input');
    await input.click();
    await input.fill(`${label} remains interactive with Ask open`);
    await expect(input).toBeFocused();
    await expect(input).toHaveText(`${label} remains interactive with Ask open`);
    await expect(ask).toBeVisible();
  }
  await expect(ask.getByTestId('prompt-input')).toHaveText('Keep the Ask draft while resizing its source');
  await page.screenshot({ path: testInfo.outputPath('global-ask-narrow-sources.png') });
  await page.setViewportSize({ width: 1900, height: 1000 });
  await sourceResize.press('Enter');
  await expect.poll(async () => (await primary.boundingBox())!.width).toBeGreaterThan(240);
  await expect(resize).toBeVisible();
  await expectContained(ask, workspace);
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await expect(ask).toHaveCount(0);
  await select(primary, 0);
  const launcher = askTrigger(page);
  await expect(launcher).toHaveCount(1);
  await expect(launcher).toBeEnabled();
  await expectContained(launcher, workspace);
  const floating = (await launcher.boundingBox())!;
  await launcher.press('ArrowLeft');
  await expect.poll(async () => (await launcher.boundingBox())!.x).toBeCloseTo(floating.x - 10, 0);
  expect((await launcher.boundingBox())!.y).toBeCloseTo(floating.y, 0);
  await expectContained(launcher, workspace);
});

test('mobile navigation keeps one title and session tools beside search with global chrome hidden', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Mobile heading and page panning.');
  test.skip(test.info().project.name === 'webkit-ask-mobile', 'Fails on the iPhone profile and no run has diagnosed it (open item O32); it passes on Chromium with a Pixel 7.');
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
    await options.getByText('Content only', { exact: true }).click();
    await expect(options.getByRole('radio', { name: 'Content only', exact: true })).toBeChecked();
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
