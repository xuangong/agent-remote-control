import { expect, type Locator, type Page } from '@playwright/test';
import { showSessions } from './session-navigation';
import { toggleViewPanel } from './view-options';

/** Opens a sessions page on desktop (All sessions, Favorites or Settings), showing the sidebar first if it is hidden, and returns the page; on compact layouts the panels stay in the Context dialog. */
export async function openSessionsPage(page: Page, entry: 'All sessions' | 'Favorites' | 'Settings' = 'All sessions'): Promise<Locator> {
  const rail = page.locator('#lab-context');
  await expect(page.locator('.lab-shell')).toBeVisible();
  // The sidebar starts hidden when the page opens with a session (opening one later keeps it); show it, and retry until it is visible.
  await expect(async () => {
    if (!await rail.isVisible()) await toggleViewPanel(page, 'Sidebar');
    await expect(rail).toBeVisible({ timeout: 1000 });
  }).toPass();
  if (entry === 'Settings') await rail.getByRole('button', { name: 'Sidebar settings', exact: true }).click();
  else await rail.getByRole('navigation', { name: 'Shortcuts' }).getByRole('button', { name: entry, exact: true }).click();
  const sessions = page.locator('#lab-sessions-page');
  await sessions.waitFor({ state: 'visible' });
  return sessions;
}

/** Shows the session list on any layout: the All sessions page on desktop, the Context dialog's Sessions tab on compact layouts. Returns what holds it. */
export async function showAllSessions(page: Page): Promise<Locator> {
  if ((page.viewportSize()?.width ?? 1280) > 1180) return openSessionsPage(page);
  await showSessions(page);
  await page.getByRole('navigation', { name: 'Sidebar sections' }).getByRole('button', { name: 'Sessions', exact: true }).click();
  return page.getByRole('dialog', { name: 'Context' });
}

/** Chooses the Host new sessions use. The desktop sidebar no longer holds the Host selector, so a wide page opens All sessions for it first. */
export async function selectConnectedHost(page: Page, hostId: string): Promise<void> {
  const select = page.getByLabel('Connected Host');
  if ((page.viewportSize()?.width ?? 1280) > 1180 && !await select.isVisible()) await openSessionsPage(page);
  await select.selectOption(hostId);
}

/** Adds an empty session view to the Window's dock. On desktop that opens All sessions to choose its session; this goes back to the Window instead. */
export async function addSessionView(page: Page): Promise<void> {
  await page.locator('.lab-session-dock-add').click();
  if ((page.viewportSize()?.width ?? 1280) <= 1180) return;
  const sessions = page.locator('#lab-sessions-page');
  await expect(sessions).toHaveAttribute('aria-label', 'All sessions');
  await expect(sessions).toBeVisible();
  await sessions.getByRole('button', { name: 'Back to Window', exact: true }).click();
  await expect(sessions).toBeHidden();
}
