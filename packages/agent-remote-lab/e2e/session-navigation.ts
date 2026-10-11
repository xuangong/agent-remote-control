import { expect, type Page } from '@playwright/test';
import { toggleViewPanel } from './view-options';

export async function showSessions(page: Page): Promise<void> {
  await expect(page.locator('.lab-shell')).toBeVisible();
  if (await page.locator('#lab-context').isVisible()) return;
  if ((page.viewportSize()?.width ?? 1280) > 1180) await toggleViewPanel(page, 'Sidebar');
  else await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
}

export async function showNewSession(page: Page): Promise<void> {
  await expect(page.locator('.lab-shell')).toBeVisible();
  const create = page.getByTestId('session-create');
  if (await create.isVisible()) return;
  await showSessions(page);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
}
