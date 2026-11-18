import { expect, type Page } from '@playwright/test';
import { toggleViewPanel } from './view-options';

export async function showSessions(page: Page): Promise<void> {
  await expect(page.locator('.lab-shell')).toBeVisible();
  if (await page.locator('#lab-context').isVisible()) return;
  if ((page.viewportSize()?.width ?? 1280) > 1180) await toggleViewPanel(page, 'Sidebar');
  else await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
}

/** Shows the new-session form: on desktop the New menu's "New session" opens it as a page, on compact layouts the drawer's footer button. */
export async function showNewSession(page: Page): Promise<void> {
  await expect(page.locator('.lab-shell')).toBeVisible();
  const create = page.getByTestId('session-create');
  if (await create.isVisible()) return;
  await showSessions(page);
  const rail = page.locator('#lab-context');
  if ((page.viewportSize()?.width ?? 1280) > 1180) {
    await rail.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menu', { name: 'New', exact: true }).getByRole('menuitem', { name: 'New session', exact: true }).click();
  } else await rail.getByRole('button', { name: 'New session', exact: true }).click();
}
