import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, expect as browserExpect } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

const entries = Array.from({ length: 120 }, (_, index) => ({
  providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-09-29T00:00:00.000Z',
  sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [],
  item: index === 1 ? { type: 'reasoning', text: '中文 needle reasoning' }
    : { type: index === 0 ? 'user_message' : 'assistant_message', text: index === 0 ? '中文 needle first request' : index === 44 ? '中文 needle later answer' : `Message ${index + 1}. A conversation paragraph with enough content to scroll through.` },
}));
function history(agentId: string, before = 121, limit = 20) {
  const selected = entries.filter(entry => entry.seqStart < before).slice(-limit);
  return { protocolVersion: '1.5.0', type: 'timeline_page', payload: { requestId: 'history', agentId, direction: before === 121 ? 'tail' : 'before',
    epoch: 'epoch', entries: selected, window: { minSeq: 1, maxSeq: 120, nextSeq: 121 },
    startCursor: selected.length ? { epoch: 'epoch', seq: selected[0]!.seqStart } : null,
    endCursor: selected.length ? { epoch: 'epoch', seq: selected.at(-1)!.seqEnd } : null,
    hasOlder: selected[0]!.seqStart > 1, hasNewer: before < 121, reset: false, staleCursor: false, gap: false, error: null,
  } };
}
let script = '', css = '', url = '';
const requests: string[] = [];
const server = createServer((request, response) => {
  const target = new URL(request.url!, 'http://fixture');
  if (target.pathname.endsWith('/timeline')) {
    requests.push(target.pathname);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(history(target.pathname.split('/')[3]!, Number(target.searchParams.get('seq')), Number(target.searchParams.get('limit')))));
  } else if (target.pathname === '/fixture.js') {
    response.setHeader('content-type', 'application/javascript'); response.end(script);
  } else {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
      #root { height: 100dvh; display: flex; } #root > div { width: 100%; min-width: 0; } @media(min-width: 900px) { #root > div { width: 50%; } }
      </style><div id="root"></div><script src="/fixture.js"></script>`);
  }
});
beforeAll(async () => {
  const source = `
    import React, { useEffect, useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { AgentReplica, RemoteSessionClient, HttpWebSocketTransport } from '@orchardworks/agent-remote-web';
    import { SessionWorkbench } from './components/SessionWorkbench.tsx';
    import { TimelineDisplay } from '@orchardworks/agent-remote-web/react';
    function View({ id }) {
      const [replica] = useState(() => {
        const replica = new AgentReplica();
        replica.applySnapshot({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: {
          id, providerId: 'recorded', status: 'idle', activeTurn: null, createdAt: '', updatedAt: '', pendingInteractions: [],
          capabilities: { sendMessage: false, history: true, steer: false, cancel: false, readResource: false },
          runtimeInfo: { providerId: 'recorded', status: 'idle' },
        } });
        const tail = ${JSON.stringify(history('one'))}; tail.payload.agentId = id; replica.applyHistory(tail); return replica;
      });
      const [client] = useState(() => new RemoteSessionClient(id, new HttpWebSocketTransport(location.origin), replica, { historyPageSize: 20 }));
      const [state, setState] = useState(replica.getState());
      useEffect(() => replica.subscribe(() => setState(replica.getState())), [replica]);
      return <div data-view={id}><TimelineDisplay.Provider value="content"><SessionWorkbench state={state} readOnly sessionStatus="ready" actions={{
        searchTimeline: (query, options) => client.searchTimeline(query, options),
        loadSearchMatch: (match, options) => client.loadSearchMatch(match, options),
        loadOlder: () => client.loadOlder(),
      }} /></TimelineDisplay.Provider></div>;
    }
    createRoot(document.getElementById('root')).render(<><View id="one" />{innerWidth >= 900 ? <View id="two" /> : null}</>);
  `;
  script = (await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0]!.text;
  css = (await Promise.all(['../../agent-remote-web/src/styles.css', '../src/app.css'].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n').replace(/^@import.*$/gm, '');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

for (const engine of [chromium, webkit]) for (const width of [402, 1280]) {
  it(`searches unloaded history and reveals the result in ${engine.name()} at ${width}px`, async () => {
    requests.length = 0;
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 812 }, hasTouch: width < 500 });
      page.setDefaultTimeout(8000);
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      const view = page.locator('[data-view="one"]');
      const second = page.locator('[data-view="two"]');
      const timeline = view.locator('.lab-timeline-scroll');
      const readingGeometry = () => timeline.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { top: box.top, height: box.height, scrollTop: element.scrollTop };
      });
      await browserExpect(view.locator('[data-entry-key]')).toHaveCount(20);
      const beforeSearch = await readingGeometry();
      await view.getByRole('button', { name: 'Search this session', exact: true }).click();
      expect(await readingGeometry()).toEqual(beforeSearch);
      await view.getByRole('searchbox').fill('中文 needle');
      await browserExpect(view.getByRole('status')).toContainText('All available history searched');
      await browserExpect(view.getByLabel('Search scope')).toHaveValue('messages');
      await browserExpect(view.locator('.agent-session-search-results li')).toHaveCount(2);
      await browserExpect(view.locator('[data-entry-key]')).toHaveCount(20);
      expect(await readingGeometry()).toEqual(beforeSearch);
      expect(requests.length).toBeGreaterThanOrEqual(5);
      expect(requests.every(path => path.includes('/one/'))).toBe(true);
      if (width > 900) { await browserExpect(second.locator('[data-entry-key]')).toHaveCount(20); await browserExpect(second.getByRole('searchbox')).toHaveCount(0); }
      await view.locator('.agent-session-search-results button').filter({ hasText: 'first request' }).click();
      const selected = view.locator('[data-inspected]');
      await browserExpect(selected).toContainText('first request');
      await browserExpect(view.locator('.agent-session-search-results')).toHaveCount(0);
      const geometry = await selected.evaluate(element => {
        const box = element.getBoundingClientRect(), viewport = element.closest('.lab-timeline-scroll')!.getBoundingClientRect();
        return { visible: box.bottom > viewport.top && box.top < viewport.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry).toEqual({ visible: true, overflow: false });
      await view.getByLabel('Search scope').selectOption('reasoning');
      await browserExpect(view.getByRole('status')).toContainText('All available history searched');
      await browserExpect(view.locator('.agent-session-search-results li')).toHaveCount(1);
      await view.locator('.agent-session-search-results button').click();
      await browserExpect(view.locator('[data-inspected] .agent-reasoning-toggle')).toHaveAttribute('aria-expanded', 'true');
      await page.screenshot({ path: `/tmp/arc-session-search-${engine.name()}-${width}.png` });
      await view.getByRole('button', { name: 'Close session search' }).click();
      await browserExpect(view.locator('.agent-reasoning')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
}
