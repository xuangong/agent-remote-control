import { expect, test } from '@playwright/test';

const scenarios = [
  { category: 'model', label: 'Model', original: 'model-a', target: 'model-b', originalLabel: 'Model A', targetLabel: 'Model B', panel: 'Model settings', trigger: 'session-model-button', action: 'model' },
  { category: 'permissions', label: 'Approval policy', original: 'ask', target: 'allow', originalLabel: 'Ask', targetLabel: 'Allow', panel: 'Permission settings', trigger: 'session-permissions-button', action: 'permissions' },
] as const;

for (const scenario of scenarios) test(`${scenario.category} stays editable while pending and exposes a readable timeout in each shared view`, async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/e2e/fixtures/session-settings-pending.html');
  await page.waitForLoadState('networkidle');
  const primary = page.getByRole('region', { name: 'Primary view', exact: true });
  const shared = page.getByRole('region', { name: 'Shared view', exact: true });
  const primaryButton = primary.getByTestId(scenario.trigger);
  const sharedButton = shared.getByTestId(scenario.trigger);
  await expect(primaryButton).toContainText(scenario.originalLabel);
  await primaryButton.click();
  const select = primary.getByRole('combobox', { name: scenario.label, exact: true });
  const normalColor = await select.evaluate(element => getComputedStyle(element).backgroundColor);
  await select.selectOption(scenario.target);
  for (const button of [primaryButton, sharedButton]) {
    await expect(button).toContainText(scenario.targetLabel);
    await expect(button).toHaveAttribute('aria-label', /change pending/);
  }
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(scenario.target);
  await expect(select).not.toHaveCSS('background-color', normalColor);
  await expect(primary.getByText(`Pending. Current: ${scenario.originalLabel}.`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('native-values')).toContainText(`${scenario.label}: ${scenario.original}`);
  await page.screenshot({ path: testInfo.outputPath(`${scenario.category}-pending.png`), fullPage: true });

  await primary.getByRole('button', { name: 'Close session controls', exact: true }).click();
  await sharedButton.click();
  const sharedSelect = shared.getByRole('combobox', { name: scenario.label, exact: true });
  await expect(sharedSelect).toBeEnabled();
  await sharedSelect.selectOption(scenario.original);
  await expect(primaryButton).toContainText(scenario.originalLabel);
  await expect(primaryButton).toHaveAttribute('aria-label', /change pending/);
  await sharedSelect.selectOption(scenario.target);
  await expect(primaryButton).toContainText(scenario.targetLabel);
  await page.getByRole('button', { name: `Time out ${scenario.action}`, exact: true }).click();
  for (const button of [primaryButton, sharedButton]) {
    await expect(button).toContainText(scenario.originalLabel);
    await expect(button).not.toHaveAttribute('aria-label', /pending/);
    await expect(button).toHaveAttribute('aria-label', /unread setting error/);
    expect(await button.evaluate(element => getComputedStyle(element, '::after').content)).toBe('""');
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`${scenario.category}-timeout-unread.png`), fullPage: true });

  await primaryButton.click();
  await expect(primaryButton).not.toHaveAttribute('aria-label', /unread/);
  await expect(sharedButton).toHaveAttribute('aria-label', /unread/);
  await expect(select).toHaveValue(scenario.original);
  await expect(select).toHaveCSS('background-color', normalColor);
  const explanation = primary.getByRole('region', { name: scenario.panel }).getByText(`${scenario.label} change was not confirmed in time. Current native value was retained.`, { exact: true });
  await expect(explanation).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`${scenario.category}-timeout-explanation.png`), fullPage: true });
  await primaryButton.click();
  await primaryButton.click();
  await expect(explanation).toBeVisible();
  await expect(primaryButton).not.toHaveAttribute('aria-label', /unread/);
  await primary.getByRole('button', { name: 'Close session controls', exact: true }).click();
  await sharedButton.click();
  await expect(sharedButton).not.toHaveAttribute('aria-label', /unread/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('native confirmations replace pending values on both surfaces without an unread error', async ({ page }, testInfo) => {
  await page.goto('/e2e/fixtures/session-settings-pending.html');
  await page.waitForLoadState('networkidle');
  const primary = page.getByRole('region', { name: 'Primary view', exact: true });
  for (const scenario of scenarios) {
    await primary.getByTestId(scenario.trigger).click();
    await primary.getByRole('combobox', { name: scenario.label, exact: true }).selectOption(scenario.target);
    await page.getByRole('button', { name: `Confirm ${scenario.action}`, exact: true }).click();
    for (const name of ['Primary view', 'Shared view']) {
      const button = page.getByRole('region', { name, exact: true }).getByTestId(scenario.trigger);
      await expect(button).toContainText(scenario.targetLabel);
      await expect(button).not.toHaveAttribute('aria-label', /pending|unread/);
    }
    await expect(page.getByTestId('native-values')).toContainText(`${scenario.label}: ${scenario.target}`);
  }
  await expect(page.getByText('Same session · Task running', { exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('settings-confirmed.png'), fullPage: true });
});
