import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let script = '', css = '', url = '', browser: Browser;
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});

beforeAll(async () => {
  // Every primitive on its own and inside the containers whose button rules are strongest today.
  const source = `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import './session-view-styles.ts';
    import { Button } from './ui/Button.tsx'; import { IconButton } from './ui/IconButton.tsx';
    import { SegmentedControl } from './ui/SegmentedControl.tsx'; import { ListRow } from './ui/ListRow.tsx';
    import { StatusBadge } from './ui/StatusBadge.tsx';
    // A fixed-width box, so full-width rows and segments measure the same in both places.
    const set = <div style={{ width: 400 }}>
      <Button data-test="secondary">Secondary</Button><Button data-test="primary" variant="primary">Primary</Button>
      <Button data-test="small" size="small">Small</Button><IconButton data-test="icon" icon="gear" label="Settings" />
      <SegmentedControl label="Mode" value="a" onChange={() => {}} options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }]} />
      <ListRow data-test="row" title="Current" selected /><ListRow data-test="other-row" title="Other" />
      <StatusBadge status={{ kind: 'unread' }} />
    </div>;
    createRoot(document.getElementById('root')).render(<>
      <div id="plain">{set}</div>
      <main className="lab-shell" style={{ display: 'block' }}><div className="agent-remote-surface"><div className="agent-composer" id="contained">{set}</div></div></main>
    </>);`;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

const PRIMITIVES = {
  secondary: '[data-test="secondary"]', primary: '[data-test="primary"]', small: '[data-test="small"]', icon: '[data-test="icon"]',
  pressed: '.ui-segmented > [aria-pressed="true"]', unpressed: '.ui-segmented > [aria-pressed="false"]', segmented: '.ui-segmented',
  row: '[data-test="row"]', 'other-row': '[data-test="other-row"]', unread: '.ui-status[data-kind="unread"]',
} as const;
type Primitive = keyof typeof PRIMITIVES;

const styles = (page: Page, scope: string, primitive: Primitive) => page.$eval(`${scope} ${PRIMITIVES[primitive]}`, (element, primitive) => {
  const s = getComputedStyle(element);
  return {
    // The segmented track holds no text of its own: its font is inherited from where it sits; its segments set theirs.
    ...(primitive === 'segmented' ? {} : { font: s.font }),
    padding: s.padding, margin: s.margin, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, radius: s.borderRadius,
    minWidth: s.minWidth, minHeight: s.minHeight, height: s.height, width: s.width, color: s.color, background: s.backgroundColor,
    boxShadow: s.boxShadow, opacity: s.opacity, transform: s.transform };
}, primitive);

const ring = (page: Page, selector: string) => page.$eval(selector, element => {
  const s = getComputedStyle(element);
  return { focused: element.matches(':focus-visible'), width: s.outlineWidth, style: s.outlineStyle, offset: s.outlineOffset, color: s.outlineColor };
});

async function open(page: Page) {
  await page.goto(url);
  await page.locator('#contained [data-test="icon"]').waitFor();
}

it('renders the primitives the same inside the Lab containers as on their own', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await open(page);
  for (const primitive of Object.keys(PRIMITIVES) as Primitive[]) {
    expect.soft(await styles(page, '#contained', primitive), primitive).toEqual(await styles(page, '#plain', primitive));
  }
  await page.close();
});

it('draws a 3px focus ring with a 1px offset on the buttons inside and outside the containers', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await open(page);
  // A key press first, so a programmatic focus is shown as keyboard focus.
  await page.keyboard.press('Tab');
  for (const primitive of ['secondary', 'primary', 'small', 'icon', 'pressed'] as const) {
    const rings = [];
    for (const scope of ['#plain', '#contained']) {
      const selector = `${scope} ${PRIMITIVES[primitive]}`;
      await page.locator(selector).focus();
      rings.push(await ring(page, selector));
    }
    expect(rings[0], primitive).toEqual({ focused: true, width: '3px', style: 'solid', offset: '1px', color: rings[0]!.color });
    expect(rings[0]!.color, `${primitive} ring color`).not.toBe('rgba(0, 0, 0, 0)');
    expect(rings[1], primitive).toEqual(rings[0]);
  }
  await page.close();
});

it('keeps 44px touch targets in the containers on a coarse pointer', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await open(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a coarse pointer').toBe(true);
  for (const primitive of Object.keys(PRIMITIVES) as Primitive[]) {
    expect.soft(await styles(page, '#contained', primitive), `coarse ${primitive}`).toEqual(await styles(page, '#plain', primitive));
  }
  for (const scope of ['#plain', '#contained']) {
    for (const primitive of ['secondary', 'primary', 'small', 'icon', 'pressed', 'unpressed', 'row'] as const) {
      const box = await page.locator(`${scope} ${PRIMITIVES[primitive]}`).boundingBox();
      expect(box!.height, `${scope} ${primitive} height`).toBeGreaterThanOrEqual(44);
      if (primitive === 'icon') expect(box!.width, `${scope} icon width`).toBeGreaterThanOrEqual(44);
    }
  }
  await context.close();
});

it('keeps the pressed segment, the current row and the unread dot visible in forced colors', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, forcedColors: 'active' });
  await open(page);
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), 'forced colors').toBe(true);
  for (const scope of ['#plain', '#contained']) {
    const colors = await page.evaluate(([scope, selectors]) => {
      const bg = (selector: string) => getComputedStyle(document.querySelector(`${scope} ${selector}`)!).backgroundColor;
      return { pressed: bg(selectors.pressed), unpressed: bg(selectors.unpressed), row: bg(selectors.row), otherRow: bg(selectors['other-row']),
        canvas: getComputedStyle(document.body).backgroundColor, dot: bg(selectors.unread) };
    }, [scope, PRIMITIVES] as const);
    expect(colors.pressed, `${scope} pressed segment`).not.toBe(colors.unpressed);
    expect(colors.row, `${scope} current row`).not.toBe(colors.otherRow);
    expect(colors.row, `${scope} current row`).not.toBe(colors.canvas);
    expect(colors.dot, `${scope} unread dot`).not.toBe(colors.canvas);
  }
  await page.close();
});
