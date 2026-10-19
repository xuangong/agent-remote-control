import { expect, type Locator, type Page } from '@playwright/test';

export async function showSessionAction(scope: Locator | Page, name: string): Promise<Locator> {
  const action = scope.getByRole('button', { name, exact: true, includeHidden: true });
  const toolbar = action.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lab-timeline-tools " )][1]');
  if (await toolbar.count()) {
    const expand = toolbar.getByRole('button', { name: 'Expand session actions', exact: true });
    if (await expand.isVisible()) await expand.click();
  }
  if (!await action.isVisible()) {
    const menu = action.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lab-session-heading-actions ")][1]');
    await menu.getByRole('button', { name: 'More session actions', exact: true }).click();
  }
  await expect(action).toBeVisible();
  return action;
}

export async function clickSessionAction(scope: Locator | Page, name: string): Promise<void> {
  await (await showSessionAction(scope, name)).click();
}
