import { expect, type Page } from '@playwright/test';

export async function toggleViewPanel(page: Page, panel: 'Header' | 'Sidebar' | 'Replica Inspector'): Promise<void> {
  const trigger = page.getByRole('button', { name: 'View options', exact: true });
  await trigger.click();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await options.getByRole('checkbox', { name: panel, exact: true }).click();
  if (await options.isVisible()) await options.press('Escape');
  await expect(options).toHaveCount(0);
}
