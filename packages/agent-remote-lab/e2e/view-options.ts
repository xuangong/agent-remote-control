import { expect, type Page } from '@playwright/test';
import { translator } from '@orchardworks/agent-client';

const PANELS = { Header: 'navigation.viewOptions.header', Sidebar: 'navigation.viewOptions.sidebar', 'Replica Inspector': 'navigation.viewOptions.replicaInspector' } as const;

/** Toggles a panel in View options; the control's names are the page's words in `locale`. */
export async function toggleViewPanel(page: Page, panel: keyof typeof PANELS, locale: 'en' | 'zh' = 'en'): Promise<void> {
  const t = translator(locale);
  const trigger = page.getByRole('button', { name: t('navigation.viewOptions.label'), exact: true });
  await trigger.click();
  const options = page.getByRole('region', { name: t('navigation.viewOptions.label'), exact: true });
  await options.getByRole('checkbox', { name: t(PANELS[panel]), exact: true }).click();
  if (await options.isVisible()) await options.press('Escape');
  await expect(options).toHaveCount(0);
}
