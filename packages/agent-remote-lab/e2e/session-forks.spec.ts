import { showNewSession, showSessions } from './session-navigation';
import { openSessionsPage } from './all-sessions';
import { toggleViewPanel } from './view-options';
import { expect, test, type Locator, type Page } from '@playwright/test';

async function start(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByTestId('prompt-input').fill('Remember the project codename: cobalt orchard.');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(primary.locator('.agent-message-assistant').last()).toContainText('cobalt orchard');
  return primary;
}

/** A Side opens as an attached pane of the Window, beside its source, rather than as a complementary panel. */
function sideWith(page: Page, text: string): Locator {
  return page.locator('.lab-side-conversation').filter({ has: page.locator('.agent-message-user').filter({ hasText: text }) });
}

/** Closes a pane's session view from the sidebar's "In this Window" list; the agent session keeps running. */
async function closeView(page: Page, pane: Locator) {
  await page.locator(`#lab-context [data-window-view-close='${await pane.getAttribute('data-view-id')}']`).click();
}

/** Each pane's width separator is named after its title. */
async function widthSeparator(page: Page, pane: Locator) {
  return page.getByRole('separator', { name: `${await pane.getAttribute('aria-label')} width`, exact: true });
}

test('resizes a Side pane beside its source and restores its width after reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Requires two visible conversation windows.');
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/side Adjustable side');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = sideWith(page, 'Adjustable side');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Adjustable side');
  // Window panes keep their own widths; the Side's separator sits on its trailing edge.
  const divider = await widthSeparator(page, side);
  await expect(divider).toBeVisible();
  const original = (await side.boundingBox())!.width;
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await side.boundingBox())!.width).toBeGreaterThan(original + 100);
  await expect(primary).toBeVisible();
  await divider.press('Home');
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Number(await divider.getAttribute('aria-valuemin')));
  await divider.press('Enter');
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(original));
  await divider.press('Shift+ArrowRight');
  const preferredWidth = (await side.boundingBox())!.width;
  expect(preferredWidth).toBeGreaterThan(original);
  await page.reload();
  await expect(divider).toBeVisible();
  await expect.poll(async () => (await side.boundingBox())!.width).toBeCloseTo(preferredWidth, 0);
  await expect(primary).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('separator', { name: / width$/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(divider).toBeVisible();
  await expect(primary).toBeVisible();
  await expect.poll(async () => (await side.boundingBox())!.width).toBeCloseTo(preferredWidth, 0);
  await divider.dblclick();
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(original));
});

test('clicking either side-by-side conversation changes focus without moving the windows', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Requires two visible conversation windows.');
  const primary = await start(page);
  const sourceUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/side Stable side');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = sideWith(page, 'Stable side');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Stable side');
  const takeControl = side.getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await side.getByTestId('prompt-input').fill('Side draft');
  const sideUrl = page.url();
  const primaryBox = await primary.boundingBox();
  const sideBox = await side.boundingBox();

  await primary.getByTestId('prompt-input').click();
  await expect(primary.getByTestId('prompt-input')).toBeFocused();
  await expect(side).toBeVisible();
  await expect(page).toHaveURL(sourceUrl);
  expect(await primary.boundingBox()).toEqual(primaryBox);
  expect(await side.boundingBox()).toEqual(sideBox);
  await primary.getByTestId('prompt-input').fill('Main draft');

  // Non-input content selects the conversation without stealing focus into its composer.
  await side.locator('.agent-message-assistant').last().click();
  await expect(page).toHaveURL(sideUrl);
  await expect(side).toHaveAttribute('data-selected', 'true');
  await expect(side.getByTestId('prompt-input')).not.toBeFocused();
  expect(await primary.boundingBox()).toEqual(primaryBox);
  expect(await side.boundingBox()).toEqual(sideBox);
  await side.getByTestId('prompt-input').click();
  await expect(side.getByTestId('prompt-input')).toBeFocused();
  await expect(side.getByTestId('prompt-input')).toHaveText('Side draft');
  await expect(primary.getByTestId('prompt-input')).toHaveText('Main draft');

  // A nested Side opens as another pane; every pane of the Window stays in place, the source included.
  await side.getByTestId('prompt-input').fill('/side Nested side');
  await side.getByTestId('prompt-input').press('Enter');
  const nested = sideWith(page, 'Nested side');
  const parent = sideWith(page, 'Stable side');
  await expect(nested.locator('.agent-message-assistant').last()).toContainText('Nested side');
  await expect(primary).toBeVisible();
  const parentBox = await parent.boundingBox();
  const nestedBox = await nested.boundingBox();
  await parent.getByTestId('prompt-input').click();
  await expect(parent.getByTestId('prompt-input')).toBeFocused();
  await expect(page).toHaveURL(sideUrl);
  await expect(primary).toBeVisible();
  expect(await parent.boundingBox()).toEqual(parentBox);
  expect(await nested.boundingBox()).toEqual(nestedBox);
  // The parent's separator sits between it and the nested Side; narrowing the parent keeps the nested width.
  const divider = await widthSeparator(page, parent);
  const dividerBox = (await divider.boundingBox())!;
  expect(dividerBox.x).toBeGreaterThan(parentBox!.x);
  expect(Math.abs(dividerBox.x + dividerBox.width - nestedBox!.x)).toBeLessThanOrEqual(dividerBox.width);
  await divider.press('ArrowLeft');
  await expect.poll(async () => (await parent.boundingBox())!.width).toBeCloseTo(parentBox!.width - 10, 0);
  expect((await nested.boundingBox())!.width).toBeCloseTo(nestedBox!.width, 0);
});

test('selecting an opened side in discovery focuses its existing window', async ({ page }) => {
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/side Keep this branch');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = sideWith(page, 'Keep this branch');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep this branch');
  const takeControl = side.getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await side.getByTestId('prompt-input').fill('Keep the side draft');
  // Discovery lives on the All sessions page, which covers the Window until a session is chosen.
  const sessions = await openSessionsPage(page);
  const discovery = sessions.getByRole('region', { name: 'Discover sessions' });
  await discovery.getByRole('button', { name: 'Refresh', exact: true }).click();
  const selected = discovery.locator('.lab-session-row[aria-current="page"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toContainText('Current session');
  const attachmentRequests: string[] = [];
  page.on('request', request => { if (/\/attach$/.test(new URL(request.url()).pathname)) attachmentRequests.push(request.url()); });
  await selected.click();
  await expect(sessions).toBeHidden();
  await expect(side).toHaveCount(1);
  await expect(side).toHaveAttribute('data-selected', 'true');
  await expect(side.getByTestId('prompt-input')).toBeVisible();
  await expect(side.getByTestId('prompt-input')).toHaveText('Keep the side draft');
  expect(attachmentRequests).toEqual([]);
});

test('fork keeps the source chat, side sends independently, and references survive reload', async ({ page }, testInfo) => {
  const primary = await start(page);
  const sourceUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/fork');
  await primary.getByTestId('prompt-input').press('Enter');
  const entry = primary.getByRole('navigation', { name: 'Forked sessions' }).locator('button[aria-pressed]');
  await expect(entry).toHaveCount(1);
  expect(page.url()).toBe(sourceUrl);
  await expect(page.getByRole('complementary', { name: 'Side conversation' })).toHaveCount(0);
  await entry.click();
  const side = page.getByRole('complementary', { name: 'Side conversation', includeHidden: true });
  await expect(side.getByTestId('prompt-input')).toBeEnabled();
  await expect(side.locator('.lab-fork-reference summary')).toContainText('New session');
  const sideComposer = side.locator('.agent-composer');
  const sideBox = await sideComposer.boundingBox();
  const referenceBox = await side.locator('.lab-fork-reference').boundingBox();
  expect(referenceBox!.y + referenceBox!.height).toBeLessThanOrEqual(sideBox!.y);
  if (testInfo.project.name === 'chromium-desktop') {
    const primaryBox = await primary.locator('.agent-composer').boundingBox();
    expect(Math.abs(primaryBox!.height - sideBox!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(primaryBox!.y - sideBox!.y)).toBeLessThanOrEqual(1);
  }
  await expect(side.locator('.agent-message-user')).toHaveCount(1);
  await side.getByTestId('prompt-input').fill('Use that context in this branch.');
  await side.getByTestId('prompt-input').press('Enter');
  await expect(side.locator('.agent-message-user').last()).toContainText('Use that context in this branch.');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Use that context');
  await expect(side.getByTestId('timeline')).not.toContainText('cobalt orchard');
  await expect(primary.locator('.agent-message-user')).toHaveCount(2);
  await side.locator('.lab-fork-reference summary').click();
  await expect(side.getByText('Later source messages are not included.')).toBeVisible();
  expect((await sideComposer.boundingBox())!.height).toBe(sideBox!.height);
  await side.locator('.lab-fork-reference summary').click();
  const ids = await page.locator('textarea').evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  await side.getByTestId('prompt-input').fill('Retained side draft');
  await page.screenshot({ path: `../../.tmp/evidence/fork-side-${testInfo.project.name}.png`, fullPage: true });
  if (testInfo.project.name === 'chromium-mobile') await toggleViewPanel(page, 'Header');
  await side.getByRole('button', { name: 'Close side conversation' }).click();
  await expect(side).toHaveCount(1);
  await expect(side).toBeHidden();
  await entry.click();
  await expect(side).toBeVisible();
  await expect(side.getByTestId('prompt-input')).toHaveValue('Retained side draft');
  const sideUrl = page.url();
  await page.reload();
  await expect(side).toBeVisible();
  await expect(page).toHaveURL(sideUrl);
  await expect(side.getByTestId('prompt-input')).toHaveValue('Retained side draft');
  await expect(side.locator('.lab-fork-reference summary')).toBeVisible();
  await expect(side.locator('.agent-message-user').last()).toContainText('Use that context in this branch.');
  await expect(primary.locator('.agent-message-user')).toHaveCount(2);
  await expect(primary.getByTestId('timeline')).toContainText('cobalt orchard');
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Open source session' }).click();
  await expect(page).toHaveURL(sourceUrl);
  await expect(primary.getByRole('navigation', { name: 'Forked sessions' }).locator('button[aria-pressed]')).toBeVisible();
  await primary.getByRole('navigation', { name: 'Forked sessions' }).locator('button[aria-pressed]').click();
  await expect(side.locator('.lab-fork-reference summary')).toBeVisible();
  await expect(side.locator('.agent-message-user').last()).toContainText('Use that context in this branch.');
  const resumedControl = side.getByRole('button', { name: 'Take control', exact: true });
  if (await resumedControl.isVisible()) await resumedControl.click();
  await side.getByTestId('prompt-input').fill('A second branch message.');
  await side.getByTestId('prompt-input').press('Enter');
  await expect(side.locator('.agent-message-user')).toHaveCount(3);
  await expect(side.getByTestId('timeline')).not.toContainText('cobalt orchard');
});

test('btw aliases side and sends its arguments as the first branch message', async ({ page }) => {
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/btw Tell me about the branch');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = sideWith(page, 'Tell me about the branch');
  await expect(side.locator('.agent-message-user').last()).toContainText('Tell me about the branch');
  await expect(side.getByTestId('prompt-input')).toHaveText('');
  await expect(primary.locator('.agent-message-user')).toHaveCount(2);
  await expect(side.getByTestId('timeline')).not.toContainText('cobalt orchard');
});

test('forks a conversation with a large tool result and discloses shortened context', async ({ page }) => {
  const primary = await start(page);
  await page.route('**/timeline?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('limit') !== '20000') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entry = body.payload.entries[0];
    body.payload.entries.push({ ...entry, item: { type: 'tool_call', callId: 'verbose-output', name: 'shell', detail: { type: 'shell', command: 'build' }, status: 'completed', error: null,
      result: { content: [{ type: 'text', text: 'Build started\n' + 'x'.repeat(600_000) + '\nBuild succeeded' }], exitCode: 0 } } });
    await route.fulfill({ response, json: body });
  });
  await primary.getByTestId('prompt-input').fill('/fork Continue from that build');
  await primary.getByTestId('prompt-input').press('Enter');
  await primary.getByRole('navigation', { name: 'Forked sessions' }).locator('button[aria-pressed]').click();
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Continue from that build');
  await side.locator('.lab-fork-reference summary').click();
  await expect(side.getByText('1 tool records shortened. User and assistant messages are preserved.')).toBeVisible();
  await expect(side.getByTestId('timeline')).not.toContainText('Build started');
});

test('rejects a delayed fork input after the main conversation changes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Exercises simultaneous desktop session controls.');
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/fork');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(primary.getByRole('navigation', { name: 'Forked sessions' }).locator('button[aria-pressed]')).toHaveCount(1);
  await showSessions(page);
  await page.getByRole('region', { name: 'Discover sessions' }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('region', { name: 'Discover sessions' }).getByRole('button').filter({ has: page.getByText('Fork of New session', { exact: true }) }).click();
  await expect(primary.locator('.lab-fork-reference summary')).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.includes(':record:'))!;
    void navigator.locks.request(key, () => new Promise<void>((resolve) => {
      (window as unknown as { releaseFork: () => void; forkLocked: boolean }).releaseFork = resolve;
      (window as unknown as { forkLocked: boolean }).forkLocked = true;
    }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { forkLocked?: boolean }).forkLocked)).toBe(true);
  await primary.getByTestId('prompt-input').fill('This must stay in the fork.');
  await primary.getByTestId('prompt-input').press('Enter');
  await primary.locator('.lab-fork-reference summary').click();
  await primary.getByRole('button', { name: 'Open source session' }).click();
  await expect(primary.locator('.lab-fork-reference')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseFork: () => void }).releaseFork());
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((key) => key.includes(':record:'))!)!).delivery)).toBe('pending');
  await expect(primary.getByTestId('timeline')).not.toContainText('This must stay in the fork.');
});

test('keeps a tree of side panes with independent drafts and reopens a closed one from its source', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Keeps five Window panes visible side by side.');
  const primary = await start(page);
  async function branch(pane: Locator, text: string) {
    await pane.getByTestId('prompt-input').fill(`/side ${text}`);
    await pane.getByTestId('prompt-input').press('Enter');
    const result = sideWith(page, text);
    await expect(result).toBeVisible();
    await expect(result.locator('.agent-message-assistant').last()).toContainText(text);
    const takeControl = result.getByRole('button', { name: 'Take control', exact: true });
    if (await takeControl.isVisible()) await takeControl.click();
    return result;
  }
  // Every Side, nested or not, is its own pane in the Window; its source stays visible.
  const b = await branch(primary, 'Branch B');
  const d = await branch(b, 'Branch D');
  await expect(primary).toBeVisible(); await expect(b).toBeVisible();
  await d.getByTestId('prompt-input').fill('Draft on D');
  const c = await branch(primary, 'Branch C');
  const e = await branch(c, 'Branch E');
  await e.getByTestId('prompt-input').fill('Draft on E');
  await expect(page.locator('.lab-side-conversation')).toHaveCount(4);
  for (const pane of [primary, b, c, d, e]) await expect(pane).toBeVisible();
  // A source's Side list selects that Side's pane without changing the others or their drafts.
  const sideB = primary.getByRole('button', { name: 'Side 1 · Branch B', exact: true });
  await sideB.click();
  await expect(sideB).toHaveAttribute('aria-pressed', 'true');
  await expect(b).toHaveAttribute('data-selected', 'true');
  await expect(d.getByTestId('prompt-input')).toHaveText('Draft on D');
  await expect(e.getByTestId('prompt-input')).toHaveText('Draft on E');
  await primary.getByRole('button', { name: 'Side 2 · Branch C', exact: true }).click();
  await expect(c).toHaveAttribute('data-selected', 'true');
  await expect(b).not.toHaveAttribute('data-selected', 'true');
  await c.getByRole('button', { name: 'Side 1 · Branch E', exact: true }).click();
  await expect(e).toHaveAttribute('data-selected', 'true');
  await expect(e.getByTestId('prompt-input')).toHaveText('Draft on E');
  // Closing E's view keeps its source C; C's Side list reopens E's session in a new view. Drafts belong to views
  // (docs/superpowers/specs/2026-10-15-window-workspaces-design.md), so the new view starts with an empty draft.
  await closeView(page, e);
  await expect(e).toHaveCount(0);
  await expect(c).toBeVisible();
  await c.getByRole('button', { name: 'Side 1 · Branch E', exact: true }).click();
  await expect(e.locator('.agent-message-assistant').last()).toContainText('Branch E');
  await expect(e).toHaveAttribute('data-selected', 'true');
  await expect(e.getByTestId('prompt-input')).toHaveText('');
  await expect(d.getByTestId('prompt-input')).toHaveText('Draft on D');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `../../.tmp/evidence/side-tree-${testInfo.project.name}.png`, fullPage: true });
});

test('a slow sibling attachment does not override the latest side selection', async ({ page }) => {
  const primary = await start(page);
  for (const name of ['First branch', 'Second branch']) {
    await primary.getByTestId('prompt-input').fill(`/fork ${name}`);
    await primary.getByTestId('prompt-input').press('Enter');
    await expect(primary.getByRole('button', { name: new RegExp(`^Side \\d+ · ${name}`) })).toBeVisible();
    await expect(primary.getByTestId('prompt-input')).toHaveValue('');
  }
  const firstTarget = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes(':record:'))
    .map((key) => JSON.parse(localStorage.getItem(key)!)).find((fork) => fork.firstInput === 'First branch').target.nativeSessionId);
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/v1/remote/attach', async (route) => {
    if (route.request().postDataJSON().nativeSessionId !== firstTarget) return route.continue();
    const response = await route.fetch();
    entered = true;
    await gate;
    await route.fulfill({ response });
  });
  await primary.getByRole('button', { name: 'Side 1 · First branch', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await primary.getByRole('button', { name: 'Side 2 · Second branch', exact: true }).click();
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.locator('.lab-side-title')).toContainText('Second branch');
  const finished = page.waitForResponse((response) => response.url().endsWith('/attach') && response.request().postDataJSON().nativeSessionId === firstTarget);
  release();
  await finished;
  await expect(side.locator('.lab-side-title')).toContainText('Second branch');
  await side.getByTestId('prompt-input').fill('Still in the selected branch');
  await expect(side.getByTestId('prompt-input')).toHaveValue('Still in the selected branch');
});


test('side creates a lightweight source reference without capturing source history', async ({ page }) => {
  const primary = await start(page);
  const captures: string[] = [];
  const creations: Record<string, unknown>[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/timeline') && url.searchParams.get('limit') === '20000') captures.push(request.url());
    if (url.pathname.endsWith('/create') && request.method() === 'POST') creations.push(request.postDataJSON());
  });
  await primary.getByTestId('prompt-input').fill('/side Read background only when needed');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = sideWith(page, 'Read background only when needed');
  await expect(side.locator('.agent-message-user').last()).toContainText('Read background only when needed');
  expect(captures).toEqual([]);
  expect(creations).toHaveLength(1);
  expect(creations[0]?.sourceNativeSessionId).toBeTruthy();
  await side.locator('.lab-fork-reference summary').click();
  await expect(side.getByText('Source reference · Read on demand. New source messages may be read.')).toBeVisible();
  await expect(side.getByTestId('timeline')).not.toContainText('source-session-reference');
  const records = await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes(':record:')).map(key => JSON.parse(localStorage.getItem(key)!)));
  expect(records).toHaveLength(1);
  expect(records[0].mode).toBe('reference');
  expect(records[0].text).toBeUndefined();
  const sideUrl = page.url();
  await page.reload();
  await expect(side).toBeVisible();
  await expect(page).toHaveURL(sideUrl);
  await expect(side.locator('.lab-fork-reference summary')).toBeVisible();
  await expect(side.locator('.agent-message-user').last()).toContainText('Read background only when needed');
  await expect(primary.getByTestId('timeline')).toContainText('cobalt orchard');
  await side.locator('.lab-fork-reference summary').click();
  await expect(side.getByText('Source reference · Read on demand. New source messages may be read.')).toBeVisible();
  expect(captures).toEqual([]);
  expect(creations).toHaveLength(1);
});
