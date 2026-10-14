import { expect, test } from '@playwright/test';

for (const width of [320, 390, 1440]) {
  test(`shows the Team main session below tracked titles at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'source', title: 'Controller reliability and cross-platform deployment diagnostics' };
    const team = { id: 'team', operationId: 'create', revision: 1, title: 'Diagnostics', status: 'active', source, createdAt: 1, updatedAt: 1, messages: [], members: [
      { id: 'leader', name: 'Leader', role: 'leader', hostId: 'mac', providerId: 'codex', nativeSessionId: 'leader', creation: 'ready', activity: 'idle', responsibility: '', summary: '', updatedAt: 1 },
      { id: 'member', name: 'Windows validation', role: 'member', hostId: 'win', providerId: 'codex', nativeSessionId: 'member', creation: 'ready', activity: 'idle', responsibility: '', summary: '', updatedAt: 1 },
    ] };
    await page.route('**/v1/remote/teams', route => route.fulfill({ json: { teams: [team] } }));
    await page.goto('/e2e/fixtures/team.html?tracking');
    await page.getByRole('button', { name: 'Tracked sessions', exact: true }).click();
    const rows = page.locator('.lab-tracked-row');
    await expect(rows).toHaveCount(3);
    for (const row of [rows.nth(0), rows.nth(1)]) {
      const subtitle = row.locator('.lab-tracked-main');
      await expect(subtitle).toHaveText(`Main: ${source.title}`);
      const titleBox = (await row.locator('strong').boundingBox())!, subtitleBox = (await subtitle.boundingBox())!;
      expect(subtitleBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await expect(rows.nth(2).locator('.lab-tracked-main')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('tracked-team.png') });
  });
}
