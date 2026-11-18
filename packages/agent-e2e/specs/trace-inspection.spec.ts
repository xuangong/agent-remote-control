import { expect, test } from '@playwright/test';
import { toggleViewPanel } from './view-options';
import { showNewSession } from './session-navigation';

test('returns to the root conversation from trace while nested side sessions are expanded', async ({ page }) => {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByTestId('prompt-input').fill('Find the cobalt orchard answer.');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(primary.locator('.agent-message-assistant').last()).toContainText('cobalt orchard');
  let pane = primary;
  for (const text of ['First trace branch', 'Second trace branch']) {
    await pane.getByTestId('prompt-input').fill(`/side ${text}`);
    await pane.getByTestId('prompt-input').press('Enter');
    pane = page.locator('.lab-side-conversation').filter({ has: page.locator('.agent-message-user').filter({ hasText: text }) });
    await expect(pane.locator('.agent-message-assistant').last()).toContainText(text);
  }
  // Sides are attached Window panes: the root stays visible beside them while the newest Side is selected.
  await expect(primary).toBeVisible();
  await expect(pane).toHaveAttribute('data-selected', 'true');
  if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  const row = page.locator('[data-trace-entry-key]').filter({ hasText: 'cobalt orchard' }).last();
  const key = await row.getAttribute('data-trace-entry-key');
  await row.click();
  await page.getByRole('button', { name: 'Show in Conversation', exact: true }).click();
  await expect(primary).toBeVisible();
  const selected = primary.locator('[data-inspected="true"]');
  await expect(selected).toHaveAttribute('data-entry-key', key!);
  await expect(selected).toBeFocused();
  await expect(selected).toBeInViewport();
});
