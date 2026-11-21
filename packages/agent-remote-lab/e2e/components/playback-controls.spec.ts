import { expect, test } from '@playwright/test';

// A command's feedback is the only word that says it ran. On a compact layout the composer's own status notes are visually hidden
// (they are said by the activity line), but the feedback of the scenario controls sits outside the composer and must stay seen.
test('the feedback of a scenario command stays visible, with a size, on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The feedback rule is about the compact layout.');
  await page.goto('/e2e/fixtures/playback-controls.html');
  for (const [control, words] of [['Advance semantic fixture', 'Recorded observation advanced.'], ['Rehydrate Timeline', 'Recorded Timeline rehydrated.'], ['Stop resource reader', 'Provider resource reader stopped.']] as const) {
    await page.getByRole('button', { name: control, exact: true }).click();
    const feedback = page.getByText(words, { exact: true });
    await expect(feedback).toBeVisible();
    const bounds = (await feedback.boundingBox())!;
    expect(bounds.width).toBeGreaterThan(40);
    expect(bounds.height).toBeGreaterThan(10);
    expect(await feedback.evaluate(node => node.getBoundingClientRect().right <= innerWidth)).toBe(true);
  }
});
