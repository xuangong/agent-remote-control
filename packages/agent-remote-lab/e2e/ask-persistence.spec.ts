import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function openAsk(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation > .lab-session-view').getByTestId('prompt-input');
  await expect(primary).toBeEnabled();
  await primary.fill('/ask');
  await primary.press('Enter');
  const creations: unknown[] = [];
  const attachments: { nativeSessionId: string }[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/create')) creations.push(request.postDataJSON());
    if (path.endsWith('/attach')) attachments.push(request.postDataJSON());
  });
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const identity = await (await created).json() as { nativeSessionId: string };
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByTestId('prompt-input').fill('Keep the recorded Ask answer across reload');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  await ask.getByTestId('prompt-input').fill('Keep the unsent Ask draft');
  return { ask, identity, creations, attachments };
}

test('reload restores an expanded Ask with the same native conversation and draft', async ({ page }) => {
  const { ask, identity, creations, attachments } = await openAsk(page);
  await page.reload();
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  expect(attachments.filter(item => item.nativeSessionId === identity.nativeSessionId)).toHaveLength(1);
  expect(creations).toHaveLength(1);
});

test('an unavailable Ask restoration preserves its draft and retries the existing native identity', async ({ page }) => {
  const { ask, identity, creations, attachments } = await openAsk(page);
  let unavailable = true;
  await page.route('**/v1/remote/attach', async route => {
    if (unavailable && route.request().postDataJSON().nativeSessionId === identity.nativeSessionId) {
      await route.fulfill({ status: 503, json: { error: 'Recorded reconnect unavailable' } });
    } else await route.continue();
  });
  await page.reload();
  await expect(ask.getByRole('alert')).toContainText('Recorded reconnect unavailable');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  expect(creations).toHaveLength(1);
  expect(attachments.filter(item => item.nativeSessionId === identity.nativeSessionId)).toHaveLength(1);
  unavailable = false;
  await ask.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(ask.getByRole('alert')).toHaveCount(0);
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  expect(attachments.filter(item => item.nativeSessionId === identity.nativeSessionId)).toHaveLength(2);
  expect(creations).toHaveLength(1);
});

test('reload keeps a minimized Ask closed and reopens its saved conversation and draft', async ({ page }) => {
  const { ask, identity, creations, attachments } = await openAsk(page);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.reload();
  const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await expect(trigger).toBeEnabled();
  await expect(ask).toHaveCount(0);
  await trigger.click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the unsent Ask draft');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep the recorded Ask answer across reload');
  expect(attachments.some(item => item.nativeSessionId === identity.nativeSessionId)).toBe(true);
  expect(creations).toHaveLength(1);
});
