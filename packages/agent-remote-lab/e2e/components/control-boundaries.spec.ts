import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from '../session-navigation';

/** Every visible bordered control matched by `selector`, with the contrast of its border against the surface it sits on. */
function boundaries(page: Page, selector: string) {
  return page.evaluate(selector => {
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    type Rgba = [number, number, number, number];
    const parse = (css: string): Rgba => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = css; canvas.fillRect(0, 0, 1, 1); const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data; return [r!, g!, b!, a! / 255]; };
    const over = (top: Rgba, bottom: Rgba): Rgba => [0, 1, 2].map(index => top[index]! * top[3] + bottom[index]! * (1 - top[3])).concat(1) as Rgba;
    const luminance = ([r, g, b]: Rgba) => [r, g, b].map(value => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    return [...document.querySelectorAll(selector)].filter(element => element.checkVisibility() && parseFloat(getComputedStyle(element).borderTopWidth) > 0).map(element => {
      const layers: Rgba[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
      }
      const surface = layers.reverse().reduce((under, layer) => over(layer, under), [255, 255, 255, 1] as Rgba);
      const border = over(parse(getComputedStyle(element).borderTopColor), surface);
      const [high, low] = [luminance(border), luminance(surface)].sort((a, b) => b - a) as [number, number];
      return { control: `${element.tagName.toLowerCase()}.${element.className}`, ratio: (high + 0.05) / (low + 0.05) };
    });
  }, selector);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('a resource button and the fields and selects of an interaction keep a three-to-one boundary', async ({ page }) => {
      await page.goto('/e2e/fixtures/view-overflow.html?view=workbench');
      await expect(page.locator('main > *')).toBeVisible();
      const measured = await boundaries(page, '.agent-resources button, .agent-interaction :is(input, select, textarea)');
      // The page holds bordered fields and selects; every one of them keeps its boundary.
      expect(measured.length).toBeGreaterThan(3);
      expect(measured.filter(item => item.ratio < 3)).toEqual([]);
    });

    test('the provider select of the new session form keeps a three-to-one boundary', async ({ page, isMobile }) => {
      test.skip(isMobile, 'The desktop sidebar opens the form as a page.');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
      await page.goto('/e2e/fixtures/session-stars.html?sidebar');
      await showNewSession(page);
      const select = page.getByTestId('provider-select');
      await expect(select).toBeVisible();
      expect((await boundaries(page, '[data-testid="provider-select"]')).map(item => item.ratio >= 3)).toEqual([true]);
    });
  });
}
