import { expect, type Page } from '@playwright/test';

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) <= 430;

/** Chooses the device's default process display in Settings > Assistants, then returns to Windows. */
export async function chooseDeviceProcessMode(page: Page, mode: 'Concise' | 'Process' | 'Full'): Promise<void> {
  await (phone(page) ? page.locator('.lab-tab-bar .lab-tab').last() : page.locator('.lab-rail').getByRole('button', { name: 'Settings', exact: true })).click();
  await page.locator('.lab-settings-group', { has: page.locator('strong', { hasText: /^Assistants$/ }) }).click();
  const choice = page.getByRole('group', { name: 'Default process display' }).getByRole('button', { name: mode, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await (phone(page) ? page.locator('.lab-tab-bar') : page.locator('.lab-rail')).getByRole('button', { name: 'Windows', exact: true }).click();
  await layoutSettled(page);
}

/** Back in Windows the conversation lays out again within a few frames; a click during that shift lands between two elements. */
async function layoutSettled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    const area = () => document.querySelector('[data-testid=timeline]')?.scrollHeight ?? 0;
    let last = -1; let still = 0;
    const frame = () => {
      const now = area();
      still = now === last && now > 0 ? still + 1 : 0; last = now;
      if (still >= 15) resolve(); else requestAnimationFrame(frame);
    };
    frame();
  }));
}
