import type { Page } from '@playwright/test';

/** Every visible text run whose contrast is below WCAG AA, with the selector, colours and ratio. */
export function contrastFailures(page: Page) {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    // Any other colour form (color(srgb …), oklab(…) from color-mix) is drawn on a canvas, which gives its sRGB bytes.
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const parse = (css: string): Rgba => {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(css);
      if (match) return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = css;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
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

