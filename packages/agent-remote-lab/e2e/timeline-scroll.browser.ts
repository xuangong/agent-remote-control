import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

let url = '';
let script = '';
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? script : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>');
});
beforeAll(async () => {
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useTimelineScroll } from '../../agent-remote-web/src/react/useTimelineScroll.ts';
    import { captureReadingText, readingTextTop } from '../../agent-remote-web/src/react/reading-text-anchor.ts';
    const positions = new Map();
    const count = Number(new URLSearchParams(location.search).get('count') || 1200);
    const shape = new URLSearchParams(location.search).get('shape');
    window.readAnchor = () => positions.get('long')?.anchor;
    window.capture = () => {
      const viewport = document.querySelector('#viewport');
      return captureReadingText(document.querySelector('[data-entry-key]'), viewport.getBoundingClientRect());
    };
    window.anchorTop = anchor => readingTextTop(document.querySelector('[data-entry-key]'), anchor);
    function Fixture() {
      const scroll = useTimelineScroll('long', true, positions, undefined, undefined, count, 'bottom');
      return <div id="viewport" ref={scroll.viewportRef} onScroll={scroll.onScroll} onWheel={scroll.onWheel}
        style={{ height: '600px', overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse', font: '16px/1.5 sans-serif' }}>
        <div ref={scroll.contentRef} style={{ flex: 'none' }}><article data-entry-key="message"><div className="agent-markdown" style={{ padding: '12px' }}>
          {shape === 'list' ? <blockquote><ul>{Array.from({ length: count }, (_, index) =>
            <li data-paragraph={index} key={index}>List item {index}. {'Text that wraps into several lines. '.repeat(6)}</li>)}</ul></blockquote>
          : shape === 'table' ? <div className="agent-markdown-table"><table><tbody>{Array.from({ length: count }, (_, index) =>
            <tr data-paragraph={index} key={index}><td>Row {index}. {'Wrapped table text. '.repeat(8)}</td><td>Short cell</td></tr>)}</tbody></table></div>
          : Array.from({ length: count }, (_, index) => <p data-paragraph={index} key={index}>
            Paragraph {index}. {'Readable conversation text that wraps naturally. '.repeat(5)}
            <strong>Emphasis</strong> and <code>inline code</code>. {'More text to wrap. '.repeat(5)}
          </p>)}
        </div></article></div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `;
  const bundled = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
    bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  script = bundled.outputFiles[0]!.text;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

async function readParagraph(page: Page, index: number) {
  await page.locator('#viewport').dispatchEvent('wheel', { deltaY: -1 });
  await page.locator(`[data-paragraph="${index}"]`).evaluate(element => {
    const viewport = document.querySelector('#viewport')!;
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 5;
    viewport.dispatchEvent(new Event('scroll'));
  });
}

for (const engine of [chromium, webkit]) {
  it(`bounds text geometry reads deep inside a long reply (${engine.name()})`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(10_000);
      await page.goto(url);
      await readParagraph(page, 1000);
      const result = await page.evaluate(() => {
        const original = Range.prototype.getClientRects;
        const caret = document.caretPositionFromPoint?.bind(document);
        const caretRange = document.caretRangeFromPoint?.bind(document);
        let reads = 0, hitTests = 0;
        if (caret) document.caretPositionFromPoint = (...args) => { hitTests++; return caret(...args); };
        if (caretRange) document.caretRangeFromPoint = (...args) => { hitTests++; return caretRange(...args); };
        Range.prototype.getClientRects = function () { reads++; return original.call(this); };
        try {
          const started = performance.now();
          const anchor = (window as any).capture();
          return { reads, hitTests, duration: performance.now() - started, anchor };
        } finally {
          Range.prototype.getClientRects = original;
          if (caret) document.caretPositionFromPoint = caret;
          if (caretRange) document.caretRangeFromPoint = caretRange;
        }
      });
      console.log(engine.name(), JSON.stringify(result));
      expect(result.anchor).toBeDefined();
      expect(result.reads).toBeLessThan(80);
      expect(result.hitTests).toBe(0);
      expect(result.anchor.top).toBeLessThan(40);
    } finally { await browser.close(); }
  });

  it(`keeps the saved reading line through reflow and earlier content growth (${engine.name()})`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(10_000);
      await page.goto(url);
      await readParagraph(page, 1000);
      const anchor = await page.evaluate(() => (window as any).readAnchor().text);
      expect(anchor).toBeDefined();
      const offset = () => page.evaluate(anchor => (window as any).anchorTop(anchor) - document.querySelector('#viewport')!.getBoundingClientRect().top, anchor);
      for (const width of [844, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(offset).toBeCloseTo(anchor.top, 0);
      }
      await page.locator('[data-paragraph="10"]').evaluate(element => { (element as HTMLElement).style.paddingTop = '200px'; });
      await expect.poll(offset).toBeCloseTo(anchor.top, 0);
    } finally { await browser.close(); }
  });

  it(`searches long nested lists and tables within the message (${engine.name()})`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(10_000);
      for (const shape of ['list', 'table']) {
        await page.goto(url + '?shape=' + shape);
        await readParagraph(page, 1000);
        const result = await page.evaluate(() => {
          const original = Element.prototype.getBoundingClientRect;
          const textRects = Range.prototype.getClientRects;
          let blocks = 0, characters = 0;
          Element.prototype.getBoundingClientRect = function () { blocks++; return original.call(this); };
          Range.prototype.getClientRects = function () { characters++; return textRects.call(this); };
          try {
            const anchor = (window as any).capture();
            const node = anchor?.path.reduce((node: Node, index: number) => node.childNodes[index]!, document.querySelector('[data-entry-key]'));
            return { anchor, paragraph: node?.parentElement?.closest('[data-paragraph]')?.getAttribute('data-paragraph'), blocks, characters };
          }
          finally { Element.prototype.getBoundingClientRect = original; Range.prototype.getClientRects = textRects; }
        });
        expect(result.anchor).toBeDefined();
        expect(result.anchor.top).toBeLessThan(40);
        expect(result.blocks).toBeLessThan(60);
        expect(result.characters).toBeLessThan(80);
        expect(result.anchor.sample).toMatch(/^(List item|Row) /);
        expect(result.paragraph).toBe('1000');
      }
    } finally { await browser.close(); }
  });

  it(`ignores document hit-test APIs and preserves text selection (${engine.name()})`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(10_000);
      await page.goto(url + '?count=40');
      await readParagraph(page, 20);
      const results = await page.evaluate(() => {
        const selection = window.getSelection()!;
        const selected = document.querySelector('[data-paragraph="20"] strong')!;
        selection.selectAllChildren(selected);
        const baseline = (window as any).capture();
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: undefined });
        Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: undefined });
        const unsupported = (window as any).capture();
        const unrelated = document.createTextNode('Not part of the timeline');
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: unrelated, offset: 0 }) });
        const outside = (window as any).capture();
        const hidden = document.querySelector('[data-paragraph="0"]')!.firstChild;
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: hidden, offset: 0 }) });
        const offscreen = (window as any).capture();
        return { baseline, unsupported, outside, offscreen, selected: selection.toString() };
      });
      expect(results.unsupported).toEqual(results.baseline);
      expect(results.outside).toEqual(results.baseline);
      expect(results.offscreen).toEqual(results.baseline);
      expect(results.selected).toBe('Emphasis');
    } finally { await browser.close(); }
  });
}
