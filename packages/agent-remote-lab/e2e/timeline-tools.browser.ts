import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let script = '', css = '', url = '';
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
beforeAll(async () => {
  // A session view of a given width holding the expanded actions: the toolbar's own buttons and the session switcher.
  const source = `
    import React, { useRef } from 'react'; import { createRoot } from 'react-dom/client';
    import './session-view-styles.ts';
    import { SessionTimelineTools } from './components/SessionTimelineTools.tsx';
    function View({ width }) {
      const timeline = useRef(null);
      return <div className="lab-session-view" data-width={width} style={{ width: width + 'px', height: '320px' }}>
        <div style={{ position: 'relative', height: '100%' }}>
          <SessionTimelineTools collapsible searchOpen={false} timelineRef={timeline} onDismissSearch={() => {}}>
            <div className="lab-timeline-session-tools">
              <button type="button" aria-label="Share session link">S</button>
              <button type="button" aria-label="Quote messages">Q</button>
              <section className="lab-chat-sessions" aria-label="Chat sessions"><button type="button" className="lab-chat-sessions-heading">Sessions</button></section>
            </div>
            <button type="button" className="lab-timeline-search-trigger" aria-label="Search this session">F</button>
          </SessionTimelineTools>
          <div ref={timeline} />
        </div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<><View width={402} /><View width={800} /></>);
  `;
  // The page gets the product's styles, including those the components import, from the bundle.
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it('narrows only the toolbar\'s own buttons in a narrow session view', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(8000);
    await page.goto(url);
    const widths = async (view: number) => {
      const scope = page.locator(`.lab-session-view[data-width="${view}"]`);
      await scope.getByRole('button', { name: 'Expand session actions', exact: true }).click();
      // The layout width: the expanding actions are scaled while they animate in.
      const width = (locator: ReturnType<typeof scope.locator>) => locator.evaluate(element => (element as HTMLElement).offsetWidth);
      return {
        share: await width(scope.getByRole('button', { name: 'Share session link', exact: true })),
        search: await width(scope.getByRole('button', { name: 'Search this session', exact: true })),
        switcher: await width(scope.locator('.lab-chat-sessions-heading')),
      };
    };
    const narrow = await widths(402);
    expect(narrow.share).toBe(42);
    expect(narrow.search).toBe(42);
    // The session switcher keeps the width its label needs.
    expect(narrow.switcher).toBeGreaterThan(42);
    const wide = await widths(800);
    expect(wide.share).not.toBe(42);
  } finally { await browser.close(); }
});
