import type { Page } from '@playwright/test';

export async function showNewSession(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) > 1180) {
    if (!await page.getByTestId('session-create').isVisible()) await page.getByRole('button', { name: 'New session', exact: true }).click();
    return;
  }
  const create = page.getByTestId('session-create');
  if (await create.isVisible()) return;
  if (!await page.getByRole('dialog', { name: 'Context', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  }
  await page.getByRole('button', { name: 'New session', exact: true }).click();
}
