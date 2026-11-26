// Component projects: orchard-phone-webkit
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installLifecycle } from '@orchardworks/agent-e2e/lifecycle';
import { contrastFailures } from './contrast.js';

// The Orchard primitives on their fixture page, in both themes, at desktop and phone width: contrast, the theme override,
// motion, touch targets and the phone layout. Screenshots are artifacts for review, not compared by pixels.

const themes = [
  { name: 'light', query: 'light', colorScheme: 'light' },
  { name: 'dark', query: 'dark', colorScheme: 'dark' },
  { name: 'system-dark', query: 'system', colorScheme: 'dark' },
] as const;

async function open(page: Page, query: string) {
  await page.goto(`/e2e/fixtures/orchard-primitives.html?${query}`);
  await page.locator('[data-section="legacy"]').waitFor();
}

for (const theme of themes) {
  test.describe(`${theme.name} theme`, () => {
    test.use({ colorScheme: theme.colorScheme });

    test('every text node passes WCAG AA', async ({ page }, testInfo) => {
      await open(page, `theme=${theme.query}&motion=off`);
      expect(await page.evaluate(() => document.documentElement.dataset.theme ?? 'system')).toBe(theme.query);
      await page.getByTestId('open-sheet').click();
      await expect(page.getByRole('dialog', { name: 'Chief' })).toBeVisible();
      expect(await contrastFailures(page)).toEqual([]);
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: '翻了 3 个文件，写好了 notes.md' }).click();
      expect(await contrastFailures(page)).toEqual([]);
      for (const section of ['conversation', 'controls', 'avatars', 'brand']) {
        await page.locator(`[data-section="${section}"]`).screenshot({ path: join(testInfo.project.outputDir, 'orchard-screens', `${testInfo.project.name}-${theme.name}-${section}.png`), animations: 'disabled' });
      }
    });
  });
}

test.describe('theme override', () => {
  test.use({ colorScheme: 'dark' });

  test('pins light over a dark system, and follows the system again without a reload', async ({ page }) => {
    await open(page, 'theme=light&motion=off');
    const colours = () => page.evaluate(() => ({
      ground: getComputedStyle(document.body).backgroundColor,
      legacy: getComputedStyle(document.querySelector('[data-testid="legacy"]')!).backgroundColor,
      bubble: getComputedStyle(document.querySelector('.orchard-bubble-row[data-from="theirs"] .orchard-bubble')!).backgroundColor,
    }));
    expect(await colours()).toEqual({ ground: 'rgb(243, 239, 233)', legacy: 'rgb(255, 255, 255)', bubble: 'rgb(244, 244, 246)' });
    await page.evaluate(() => (window as unknown as { orchardAppearance: { set(next: string): void } }).orchardAppearance.set('system'));
    expect(await colours()).toEqual({ ground: 'rgb(21, 21, 23)', legacy: 'rgb(28, 28, 30)', bubble: 'rgb(47, 47, 52)' });
    // System is the default: the device keeps no pinned theme.
    expect(await page.evaluate(() => localStorage.getItem('agent-remote:appearance'))).toBeNull();
  });

  test('keeps the choice across a reload', async ({ page }) => {
    await open(page, 'theme=light&motion=off');
    await page.goto('/e2e/fixtures/orchard-primitives.html?motion=off');
    await page.locator('[data-section="legacy"]').waitFor();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(243, 239, 233)');
  });
});

test.describe('motion', () => {
  test('nothing moves under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'theme=light&motion=on');
    expect(await page.locator('animate').count()).toBe(0);
    // The Lab's reduced-motion rule turns every transition into a 0.01 ms one, which WebKit still lists for a frame after the theme applies.
    await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 2000 }).toBe(0);
    expect(await page.evaluate(() => document.querySelectorAll('.orchard-mark-glance, .orchard-mark-sway').length)).toBe(0);
  });

  test('avatars of 24 px and above flow unless resting, smaller ones never, a working one bobs and the 64 px mark moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, 'theme=light&motion=on');
    const avatars = await page.locator('.orchard-avatar').evaluateAll(elements => elements.map(element => ({
      size: element.querySelector('svg')!.width.baseVal.value, mood: (element as HTMLElement).dataset.mood, animates: element.querySelectorAll('animate').length,
    })));
    expect(avatars.length).toBeGreaterThan(60);
    const wrong = avatars.filter(({ size, mood, animates }) => animates !== (size >= 24 && mood !== 'resting' ? 1 : 0));
    expect(wrong).toEqual([]);
    expect(await page.locator('[data-mood-row="working"] .orchard-avatar[data-bob]').first().evaluate(element =>
      element.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
    expect(await page.locator('svg[aria-label="Orchard 64"]').evaluate(mark => mark.getAnimations({ subtree: true }).length)).toBe(2);
    expect(await page.locator('svg[aria-label="Orchard 32"]').evaluate(mark => mark.getAnimations({ subtree: true }).length)).toBe(0);
  });

  test('the four avatar shapes paint about the same area at 40 px', async ({ page }) => {
    await open(page, 'theme=light&motion=off');
    const painted: Record<string, number> = {};
    for (const shape of ['circle', 'squircle', 'triangle', 'sideways']) {
      const avatar = page.locator(`[data-testid="avatar-grid"] .orchard-avatar[data-shape="${shape}"]`).first();
      await avatar.scrollIntoViewIfNeeded();
      const png = (await avatar.screenshot({ animations: 'disabled' })).toString('base64');
      // Pixels that differ from the corner's background colour (the shape and its eyes, the same eyes in each shape).
      painted[shape] = await page.evaluate(async source => {
        const image = new Image();
        image.src = `data:image/png;base64,${source}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        let count = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (Math.abs(data[index]! - data[0]!) + Math.abs(data[index + 1]! - data[1]!) + Math.abs(data[index + 2]! - data[2]!) > 60) count++;
        }
        return count;
      }, png);
    }
    const areas = Object.values(painted);
    expect(Math.min(...areas), JSON.stringify(painted)).toBeGreaterThan(0);
    expect(Math.max(...areas) / Math.min(...areas), JSON.stringify(painted)).toBeLessThan(1.1);
  });

  test('a hidden page runs no avatar or mark animation, and a visible one resumes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const lifecycle = await installLifecycle(page);
    await open(page, 'theme=light&motion=on');
    const running = await page.locator('animate').count();
    expect(running).toBeGreaterThan(0);
    await lifecycle.hide();
    await expect(page.locator('animate')).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelectorAll('.orchard-mark-glance, .orchard-mark-sway, .orchard-avatar[data-bob]').length)).toBe(0);
    await lifecycle.show();
    await expect(page.locator('animate')).toHaveCount(running);
    // A phone that freezes the page in the background and wakes it ten minutes later: still the same motion, none while away.
    await lifecycle.suspend();
    await expect(page.locator('animate')).toHaveCount(0);
    await lifecycle.resume({ afterMs: 600_000 });
    await expect(page.locator('animate')).toHaveCount(running);
  });
});

test.describe('phone', () => {
  test('every interactive element is at least 44 x 44', async ({ page, hasTouch }) => {
    test.skip(!hasTouch, 'The touch minimum applies to coarse pointers.');
    await open(page, 'theme=light&motion=off');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.getByTestId('open-sheet').click();
    await expect(page.getByRole('dialog', { name: 'Chief' })).toBeVisible();
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, [role="switch"], [role="radio"], a[href], input')]
      .filter(element => element.checkVisibility())
      .map(element => ({ name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ name, box }) => `${name}: ${box.width.toFixed(1)} x ${box.height.toFixed(1)}`));
    expect(small).toEqual([]);
  });

  test('fits the width, draws the panel edge to edge and clears the home indicator in the sheet', async ({ page }) => {
    const width = page.viewportSize()!.width;
    test.skip(width > 760, 'The phone layout applies at 760 px and below.');
    await open(page, 'theme=light&motion=off');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const panel = await page.locator('.orchard-panel').evaluate(element => ({ width: element.getBoundingClientRect().width, radius: getComputedStyle(element).borderTopLeftRadius }));
    expect(panel).toEqual({ width, radius: '0px' });
    // Emulate a 34 px home indicator through the safe-area variable that env() fills on a device.
    await page.evaluate(() => document.documentElement.style.setProperty('--orchard-safe-area-bottom', '34px'));
    await page.getByTestId('open-sheet').click();
    const padding = await page.locator('.orchard-sheet-body').evaluate(element => getComputedStyle(element).paddingBottom);
    expect(padding).toBe('48px');
  });
});
