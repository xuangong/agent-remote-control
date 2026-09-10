import { expect, test } from '@playwright/test';

async function start(page: import('@playwright/test').Page) {
  await page.goto('/');
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
  await expect(side.locator('.agent-message-user')).toHaveCount(1);
  await side.getByTestId('prompt-input').fill('Use that context in this branch.');
  await side.getByTestId('prompt-input').press('Enter');
  await expect(side.locator('.agent-message-user').last()).toContainText('Use that context in this branch.');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Use that context');
  await expect(side.getByTestId('timeline')).not.toContainText('cobalt orchard');
  await expect(primary.locator('.agent-message-user')).toHaveCount(2);
  await side.locator('.lab-fork-reference summary').click();
  await expect(side.getByText('Later source messages are not included.')).toBeVisible();
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
