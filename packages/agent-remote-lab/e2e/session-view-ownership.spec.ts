import { expect, test, type Locator, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

const sourceView = (owner: Locator) => owner.locator(':scope > .lab-session-view');
const askView = (owner: Locator) => owner.getByRole('dialog', { name: 'Ask', exact: true });

async function send(view: Locator, text: string) {
  await view.getByTestId('prompt-input').fill(text);
  await view.getByTestId('prompt-input').press('Enter');
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

test('view menu labels apply their selection before focus leaves the trigger', async ({ page }) => {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const view = sourceView(page.locator('.lab-primary-conversation'));
  await expect(view.getByTestId('prompt-input')).toBeEnabled();
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

test('hidden global header and sidebar leave each narrow session heading usable below account actions', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Desktop global account controls.');
  const { primary, side } = await openComposition(page, false);
  const globalView = page.getByRole('button', { name: 'View options', exact: true });
  await globalView.click();
  const globalOptions = page.getByRole('region', { name: 'View options', exact: true });
  await globalOptions.getByRole('checkbox', { name: 'Header', exact: true }).uncheck();
  await globalOptions.getByRole('checkbox', { name: 'Sidebar', exact: true }).uncheck();
  await globalView.press('Escape');
  await page.evaluate(() => {
    const shell = document.querySelector('.lab-shell')!;
    const wrapper = document.createElement('div');
    wrapper.className = 'gateway-private';
    shell.before(wrapper);
    wrapper.append(shell);
    const actions = document.createElement('div');
    actions.className = 'gateway-sign-out gateway-account-actions';
    for (const label of ['Security', 'Hosts', 'Account', 'Sign out']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; actions.append(button);
    }
    wrapper.before(actions);
    shell.querySelector('.lab-primary-title')!.textContent = 'A long primary session title describing provider reconnection and restored conversation timelines';
  });
  for (const width of [1200, 1400, 1900]) {
    await page.setViewportSize({ width, height: 900 });
    for (const owner of [primary, side]) {
      const heading = sourceView(owner).locator('.lab-workbench-heading');
      const options = heading.getByRole('button', { name: 'Session view options', exact: true });
      await expectContained(options, owner);
      const title = heading.locator('.lab-primary-title, .lab-conversation-path, .lab-side-title-text').first();
      await expect(title).toBeVisible();
      await expect.poll(async () => (await title.boundingBox())!.width, { message: `Session title remains readable at ${width}px` }).toBeGreaterThan(60);
    }
    await expect.poll(async () => {
      const shell = (await page.locator('.lab-shell').boundingBox())!, owner = (await primary.boundingBox())!;
      const buttons = await page.locator('.gateway-account-actions > button').all();
      return owner.y > shell.y && (await Promise.all(buttons.map(button => button.boundingBox()))).every(box => box && box.y + box.height <= owner.y);
    }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1200) await page.screenshot({ path: testInfo.outputPath('narrow-headings-with-account-actions.png') });
  }
});

test('mobile primary heading and view menu remain inside the viewport with global chrome hidden', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'Mobile heading and page panning.');
  const { primary, select } = await openComposition(page, isMobile);
  await select(primary, 0);
  const globalView = page.getByRole('button', { name: 'View options', exact: true });
  await globalView.click();
  const globalOptions = page.getByRole('region', { name: 'View options', exact: true });
  await globalOptions.getByRole('checkbox', { name: 'Header', exact: true }).uncheck();
  await globalOptions.getByRole('checkbox', { name: 'Sidebar', exact: true }).uncheck();
  await globalView.press('Escape');
  const view = sourceView(primary);
  const heading = view.locator('.lab-workbench-heading');
  const title = heading.locator('.lab-primary-title');
  const trigger = heading.getByRole('button', { name: 'Session view options', exact: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(title).toBeVisible();
    await expect(title).toHaveText('New session');
    await expect.poll(async () => (await title.boundingBox())!.width, { message: `Primary title remains readable at ${width}px` }).toBeGreaterThan(60);
    const actions = heading.getByRole('button', { name: 'More session actions', exact: true });
    await expectContained(actions, primary);
    await actions.click();
    await expect(heading.getByRole('button', { name: 'Share session link', exact: true })).toBeVisible();
    await actions.press('Escape');
    await expect(actions).toHaveAttribute('aria-expanded', 'false');
    await expect(actions).toBeFocused();
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
});
