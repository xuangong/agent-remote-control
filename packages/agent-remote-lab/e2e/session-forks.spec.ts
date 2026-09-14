import { showNewSession } from './session-navigation';
import { expect, test } from '@playwright/test';

async function start(page: import('@playwright/test').Page) {
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

test('fork keeps the source chat, side sends independently, and references survive reload', async ({ page }, testInfo) => {
  const primary = await start(page);
  const sourceUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/fork');
  await primary.getByTestId('prompt-input').press('Enter');
  const entry = primary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button');
  await expect(entry).toHaveCount(1);
  expect(page.url()).toBe(sourceUrl);
  await expect(page.getByRole('complementary', { name: 'Side conversation' })).toHaveCount(0);
  await entry.click();
  const side = page.getByRole('complementary', { name: 'Side conversation' });
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
  await side.getByRole('button', { name: 'Close side conversation' }).click();
  await expect(side).toHaveCount(0);
  await entry.click();
  await expect(side.getByTestId('prompt-input')).toHaveValue('Retained side draft');
  await page.reload();
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button').click();
  await expect(side.locator('.lab-fork-reference summary')).toBeVisible();
  await expect(side.locator('.agent-message-user').last()).toContainText('Use that context in this branch.');
  await side.getByTestId('prompt-input').fill('A second branch message.');
  await side.getByTestId('prompt-input').press('Enter');
  await expect(side.locator('.agent-message-user')).toHaveCount(3);
  await expect(side.getByTestId('timeline')).not.toContainText('cobalt orchard');
});

test('btw aliases side and sends its arguments as the first branch message', async ({ page }) => {
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/btw Tell me about the branch');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.locator('.agent-message-user').last()).toContainText('Tell me about the branch');
  await expect(side.getByTestId('prompt-input')).toHaveValue('');
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
  await primary.getByTestId('prompt-input').fill('/side Continue from that build');
  await primary.getByTestId('prompt-input').press('Enter');
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
  await expect(primary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button')).toHaveCount(1);
  await page.getByRole('region', { name: 'Opened sessions' }).getByRole('button').filter({ has: page.getByText('Fork of New session', { exact: true }) }).click();
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

test('keeps a tree of side routes with stacked ancestors and independent drafts', async ({ page }, testInfo) => {
  const primary = await start(page);
  const sides = page.locator('.lab-side-conversation');
  async function branch(pane: import('@playwright/test').Locator, text: string) {
    await pane.getByTestId('prompt-input').fill(`/side ${text}`);
    await pane.getByTestId('prompt-input').press('Enter');
    const result = sides.filter({ has: page.locator('.agent-message-user').filter({ hasText: text }) });
    await expect(result).toBeVisible();
    await expect(result.locator('.agent-message-assistant').last()).toContainText(text);
    return result;
  }
  const b = await branch(primary, 'Branch B');
  const d = await branch(b, 'Branch D');
  await expect(primary).toBeHidden();
  await d.getByTestId('prompt-input').fill('Draft on D');
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 0 });
  else await page.getByRole('button', { name: 'Expand window 1:', exact: false }).click();
  await expect(primary).toBeVisible();
  const c = await branch(primary, 'Branch C');
  const e = await branch(c, 'Branch E');
  await e.getByTestId('prompt-input').fill('Draft on E');
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 0 });
  else await page.getByRole('button', { name: 'Expand window 1:', exact: false }).click();
  await primary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button', { name: 'Side 1 · Branch B', exact: true }).click();
  await expect(b).toBeVisible();
  await expect(d).toBeHidden();
  await expect(d.getByTestId('prompt-input')).toHaveValue('Draft on D');
  await expect(e).toBeHidden();
  if (testInfo.project.name === 'chromium-desktop') await expect(primary).toBeVisible();
  await expect(b.getByTestId('prompt-input')).toBeFocused();
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 2 });
  else await page.getByRole('navigation', { name: 'Later windows' }).getByRole('button', { name: 'Expand window 3:', exact: false }).click();
  await expect(d).toBeVisible();
  await expect(d.getByTestId('prompt-input')).toHaveValue('Draft on D');
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 0 });
  else await page.getByRole('button', { name: 'Expand window 1:', exact: false }).click();
  await expect(primary.getByRole('button', { name: 'Side 1 · Branch B', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await primary.getByRole('button', { name: 'Side 2 · Branch C', exact: true }).click();
  await expect(c).toBeVisible();
  await expect(e).toBeHidden();
  if (testInfo.project.name === 'chromium-desktop') await expect(primary).toBeVisible();
  await c.getByRole('button', { name: 'Side 1 · Branch E', exact: true }).click();
  await expect(e).toBeVisible();
  if (testInfo.project.name === 'chromium-desktop') await expect(c).toBeVisible();
  await expect(e.getByTestId('prompt-input')).toHaveValue('Draft on E');
  await e.getByRole('button', { name: 'Close side conversation', exact: false }).click();
  await expect(c).toBeVisible();
  await expect(e).toBeHidden();
  await c.getByRole('button', { name: 'Side 1 · Branch E', exact: true }).click();
  await expect(e.getByTestId('prompt-input')).toHaveValue('Draft on E');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `../../.tmp/evidence/side-tree-${testInfo.project.name}.png`, fullPage: true });
});

test('a slow sibling attachment does not override the latest side selection', async ({ page }) => {
  const primary = await start(page);
  for (const name of ['First branch', 'Second branch']) {
    await primary.getByTestId('prompt-input').fill(`/fork ${name}`);
    await primary.getByTestId('prompt-input').press('Enter');
    await expect(primary.getByRole('button', { name: new RegExp(name) })).toBeVisible();
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
