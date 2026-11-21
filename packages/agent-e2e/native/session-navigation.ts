import { expect, type Locator, type Page } from '@playwright/test';
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

/**
 * Opens Settings from the rail (the Me tab on a phone), then a group of its list when one is named, and returns the page. The groups
 * are General, Assistants, Computers, Privacy and data, Advanced, and Account and about.
 */
export async function openSettingsPage(page: Page, group?: string): Promise<Locator> {
  const rail = page.locator('.lab-rail'), tabs = page.locator('.lab-tab-bar');
  await expect(rail.or(tabs)).toBeVisible();
  if (await rail.isVisible()) await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  else await tabs.getByRole('button', { name: 'Me', exact: true }).click();
  const settings = page.locator('.lab-settings').first();
  await settings.waitFor({ state: 'visible' });
  if (group) {
    const back = page.locator('.lab-settings-head').getByRole('button').first();
    if (await back.isVisible()) await back.click();
    await page.locator('.lab-settings-group').filter({ has: page.locator('strong', { hasText: new RegExp(`^${group}$`) }) }).click();
  }
  return settings;
}
