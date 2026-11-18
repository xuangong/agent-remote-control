import { expect, test } from '@playwright/test';

// The attribution table of a session view (Role, Main, Source ...) sits between the heading and the timeline, in a box that is
// capped at the smaller of 30% of the viewport height and 14rem and scrolls when its rows are taller. The table itself may be taller
// than the box, so its own bounds say nothing about overlap; the box must not reach into the timeline, and every row stays reachable.
for (const colorScheme of ['light', 'dark'] as const) {
  test(`the attribution box stays above the timeline and keeps every row reachable in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/e2e/fixtures/tpm-dock.html');
    await page.getByRole('button', { name: 'TPM works', exact: true }).click();
    const list = page.getByRole('region', { name: 'TPM works', exact: true });
    await list.locator('[data-tpm-work]').filter({ hasText: 'Connection recovery' }).click();
    await list.getByRole('button', { name: 'Close TPM works' }).click();
    const window = page.getByRole('dialog', { name: 'TPM: Connection recovery' });
    const toggle = window.getByRole('button', { name: 'Show session attributions', exact: true });
    await toggle.focus(); await toggle.press('Enter');
    const table = window.getByRole('table', { name: 'Session attributions' });
    await expect(table).toBeVisible();
    // A long working directory or many attributions make the table taller than its box.
    await table.evaluate(element => { const body = element.querySelector('tbody') ?? element; for (let index = 0; index < 8; index++) body.append(body.querySelector('tr')!.cloneNode(true)); });
    const geometry = await window.evaluate(root => {
      const box = root.querySelector<HTMLElement>('.agent-session-attributions')!;
      const timeline = root.querySelector<HTMLElement>('[data-testid="timeline"]')!;
      const rows = [...box.querySelectorAll('tr')].map(row => ({ height: row.getBoundingClientRect().height, label: row.querySelector('th')!.getBoundingClientRect().width,
        detail: !!row.querySelector('td small') }));
      const cap = Math.min(innerHeight * 0.3, parseFloat(getComputedStyle(document.documentElement).fontSize) * 14);
      return { boxBottom: box.getBoundingClientRect().bottom, timelineTop: timeline.getBoundingClientRect().top, boxHeight: box.clientHeight,
        scrollable: box.scrollHeight - box.clientHeight, tableHeight: box.querySelector('table')!.getBoundingClientRect().height, cap, rows };
    });
    expect(geometry.scrollable).toBeGreaterThan(0);
    expect(geometry.boxBottom).toBeLessThanOrEqual(geometry.timelineTop + 1);
    expect(geometry.boxHeight).toBeLessThanOrEqual(geometry.cap + 1);
    // Whatever the box clips can be scrolled to.
    expect(geometry.boxHeight + geometry.scrollable).toBeGreaterThanOrEqual(geometry.tableHeight - 1);
    for (const row of geometry.rows) {
      expect(row.label).toBeLessThanOrEqual(108);
      if (!row.detail) expect(row.height).toBeLessThanOrEqual(34);
    }
  });
}
