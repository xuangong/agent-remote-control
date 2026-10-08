import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function showDirectory(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) <= 1180) await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.getByRole('navigation', { name: 'Sidebar sections' }).getByRole('button', { name: 'Sessions', exact: true }).click();
  const directory = page.getByRole('region', { name: 'Discover sessions', exact: true });
  await directory.getByRole('button', { name: 'Refresh', exact: true }).click();
  return directory;
}

test('Discover sessions reopens linked Ask and Side native sessions from their source after reload', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const creations: unknown[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations.push(request.postDataJSON()); });
  await page.goto('/');
  await showNewSession(page);
  const creation = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByTestId('session-create').click();
  const source = await (await creation).json() as { nativeSessionId: string };
  const primary = page.locator('.lab-primary-conversation');
  const input = primary.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  const sourceUrl = page.url();
  const askCreation = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await input.fill('/ask Saved directory Ask'); await input.press('Enter');
  const askIdentity = await (await askCreation).json() as { nativeSessionId: string };
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Saved directory Ask');
  const askMessages = await ask.locator('.agent-message-user').count();
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  const sideCreation = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await input.fill('/side Saved directory Side'); await input.press('Enter');
  const sideIdentity = await (await sideCreation).json() as { nativeSessionId: string };
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Saved directory Side');
  const sideMessages = await side.locator('.agent-message-user').count();
  expect(creations).toHaveLength(3);

  const sourceKey = JSON.stringify(['local', 'recorded', source.nativeSessionId]);
  for (const [identity, kind, message, messageCount] of [[askIdentity, 'Ask', 'Saved directory Ask', askMessages], [sideIdentity, 'Side', 'Saved directory Side', sideMessages]] as const) {
    await page.goto(sourceUrl);
    await expect(input).toBeEnabled();
    const directory = await showDirectory(page);
    const sourceRow = directory.locator(`[data-session-key='${sourceKey}']`);
    await sourceRow.locator(':scope > .lab-session-branch > .lab-session-toggle').click();
    const linked = sourceRow.getByRole('list', { name: 'Related sessions for New session', exact: true });
    await expect(linked.locator('.lab-session-row')).toHaveCount(2);
    if (kind === 'Ask') await sourceRow.screenshot({ path: testInfo.outputPath('directory-relations.png') });
    const row = linked.locator('.lab-session-row').filter({ has: page.locator('small').filter({ hasText: new RegExp(`^${kind} ·`) }) });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(page).toHaveURL(url => url.searchParams.get('session') === identity.nativeSessionId);
    await expect(primary.locator('.agent-message-assistant').last()).toContainText(message);
    await expect(primary.locator('.agent-message-user')).toHaveCount(messageCount);
    expect(creations).toHaveLength(3);
  }
});
