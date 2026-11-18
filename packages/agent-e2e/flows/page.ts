import type { Page } from '@playwright/test';

/** The page's own words and controls, so a flow reads as what a person does. Selectors live here and nowhere else. */

export const timelineEntries = (page: Page) => page.locator('.agent-timeline-entry');
export const waitForEntries = (page: Page, count: number) => page.waitForFunction(needed => document.querySelectorAll('.agent-timeline-entry').length >= needed, count);
export const showsText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => document.body.innerText.includes(needle), text, { timeout });
export const lacksText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => !document.body.innerText.includes(needle), text, { timeout });

export async function send(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="prompt-input"]').click();
  await page.keyboard.type(text);
  await page.locator('[data-testid="prompt-submit"]').click();
}

/** Turns on a panel in the View options menu of the session view (Header holds the Workbench and Trace tabs). */
export async function toggleViewPanel(page: Page, panel: 'Header' | 'Sidebar' | 'Replica Inspector'): Promise<void> {
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await options.getByRole('checkbox', { name: panel, exact: true }).click();
  await page.keyboard.press('Escape');
}

export async function showTrace(page: Page): Promise<void> {
  if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
}

/** The sidebar rail: shown at once on an empty Window, hidden when the page opened with a session until View options turns it on. */
async function showRail(page: Page): Promise<void> {
  await page.locator('.lab-shell').waitFor();
  const rail = page.locator('#lab-context');
  if (await rail.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) return;
  await toggleViewPanel(page, 'Sidebar');
  await rail.waitFor({ state: 'visible' });
}

/** Opens the Settings page from the sidebar rail, showing the rail first when a session hides it. */
export async function openSettings(page: Page): Promise<void> {
  await showRail(page);
  await page.getByRole('button', { name: 'Sidebar settings', exact: true }).click();
}

/** Opens All sessions from the sidebar rail. */
export async function openAllSessions(page: Page): Promise<void> {
  await showRail(page);
  await page.locator('#lab-context').getByRole('navigation', { name: 'Shortcuts' }).getByRole('button', { name: 'All sessions', exact: true }).click();
}
