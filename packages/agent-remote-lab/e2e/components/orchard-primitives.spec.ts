import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

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

/** Every visible text run whose contrast is below WCAG AA, with the selector, colours and ratio. */
function contrastFailures(page: Page) {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (css: string): Rgba => {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(css);
      if (!match) throw new Error(`Unexpected computed colour ${css}`);
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map(index => top[index]! * top[3] + bottom[index]! * (1 - top[3])).concat(1) as Rgba;
    const luminance = ([r, g, b]: Rgba) => [r, g, b].map(value => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (a: Rgba, b: Rgba) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (high + 0.05) / (low + 0.05); };
    /** The opaque colour behind an element: its own and its ancestors' backgrounds composited down to the root's. */
    const background = (element: Element | null): Rgba => {
      const layers: Rgba[] = [];
      for (let node = element; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
      }
      return layers.reverse().reduce((under, layer) => over(layer, under), [255, 255, 255, 1] as Rgba);
    };
    const describe = (element: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = element; node && parts.length < 3; node = node.parentElement) {
        parts.unshift(node.tagName.toLowerCase() + (node.className && typeof node.className === 'string' ? `.${node.className.trim().split(/\s+/).join('.')}` : ''));
      }
      return parts.join(' > ');
    };
    const failures: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const element = text.parentElement;
      if (!element || !text.textContent?.trim() || element.closest('svg, [aria-hidden="true"]')) continue;
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const style = getComputedStyle(element);
      const size = parseFloat(style.fontSize), weight = Number(style.fontWeight);
      const minimum = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
      const behind = background(element);
      const color = over(parse(style.color), behind);
      const measured = ratio(color, behind);
      if (measured < minimum) failures.push(`${describe(element)} "${text.textContent.trim().slice(0, 30)}": ${style.color} on rgb(${behind.slice(0, 3).map(Math.round).join(', ')}) = ${measured.toFixed(2)} < ${minimum}`);
    }
    return failures;
  });
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
    expect(await page.evaluate(() => localStorage.getItem('agent-remote:appearance'))).toBe('system');
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

  test('a hidden page runs no avatar or mark animation, and a visible one resumes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, 'theme=light&motion=on');
    const running = await page.locator('animate').count();
    expect(running).toBeGreaterThan(0);
    const setVisibility = (state: 'hidden' | 'visible') => page.evaluate(next => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await setVisibility('hidden');
    await expect(page.locator('animate')).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelectorAll('.orchard-mark-glance, .orchard-mark-sway, .orchard-avatar[data-bob]').length)).toBe(0);
    await setVisibility('visible');
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
