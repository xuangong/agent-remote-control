import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * The lease gate in a real browser with the product's GatewayController: a page that read a conversation reloads while the Relay is slow to answer. The cached
 * lease still runs, so the stored rows show at once; the Relay then answers 401, and the rows go, the store is emptied and nothing is written afterwards.
 */
let script = '', css = '', url = '';
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script : `<!doctype html><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
let browser: Browser;
beforeAll(async () => {
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { GatewayController } from './GatewayController.tsx';
    import { useStoredDisplay } from './hooks/useStoredDisplay.ts';
    import { saveStoredDisplay } from './stored-display.ts';
    import { startDeviceStore } from './device-store-start.ts';
    import { AgentTimeline } from '../../agent-client-web/src/react/AgentTimeline.tsx';
    import { AgentReplica } from '../../agent-client/src/replica/store.ts';
    import { deviceStore } from '@orchardworks/agent-client/device-store';

    const target = { hostId: 'host', providerId: 'copilot', nativeSessionId: 'one' };
    const capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } };
    window.seed = async baseUrl => {
      const replica = new AgentReplica();
      replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { id: 'one', providerId: 'copilot', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', status: 'idle', activeTurn: null, pendingInteractions: [], capabilities, runtimeInfo: { providerId: 'copilot', sessionId: 'one', status: 'idle' } } });
      const entries = Array.from({ length: 12 }, (_, index) => ({ providerId: 'copilot', itemKey: 'k' + index, turnId: 't', timestamp: '2026-11-16T00:00:00Z', seqStart: index + 1, seqEnd: index + 1,
        sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [], item: { type: 'assistant_message', text: 'Stored reply ' + index, messageId: 'm' + index } }));
      replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'r', agentId: 'one', direction: 'tail', epoch: 'e', reset: false, staleCursor: false, gap: false,
        window: { minSeq: 1, maxSeq: 12, nextSeq: 13 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries, error: null } });
      saveStoredDisplay(baseUrl, target, replica.getState());
      await deviceStore.flush();
    };
    function Rows({ baseUrl }) {
      const state = useStoredDisplay(baseUrl, target);
      window.baseUrl = baseUrl;
      return state ? <AgentTimeline state={state} /> : <p id="nothing">nothing stored shown</p>;
    }
    const ready = startDeviceStore(true);
    ready.then(() => createRoot(document.getElementById('root')).render(<GatewayController>{baseUrl => <Rows baseUrl={baseUrl} />}</GatewayController>));
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"development"', 'import.meta.hot': 'undefined' } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

const basePath = '/u/' + 'a'.repeat(64) + '/';
const granted = () => JSON.stringify({ user: { id: 'person' }, basePath, expiresAt: Date.now() + 120_000 });

it('shows stored rows on the cached lease before the Relay answers, and removes them, empties the store and writes nothing when it answers 401', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.addInitScript(() => {
    const puts: string[] = [];
    (window as unknown as { __puts: string[] }).__puts = puts;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { puts.push(this.name); return original.apply(this, args); };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await page.route('**/auth/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: granted() }));
    await page.goto(url);
    await page.waitForFunction(() => (window as any).baseUrl);
    await page.evaluate(() => (window as any).seed((window as any).baseUrl));
    const records = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const open = indexedDB.open('agent-remote-image-drafts'); open.onsuccess = () => resolve(open.result); });
      return await new Promise<number>(resolve => { const tx = db.transaction('sessions'); const count = tx.objectStore('sessions').count(); tx.oncomplete = () => { db.close(); resolve(count.result); }; });
    });
    expect(await records()).toBe(1);

    // The Relay is slow and then refuses the lease.
    await page.unroute('**/auth/status');
    await page.route('**/auth/status', route => new Promise<void>(resolve => setTimeout(() => { void route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Sign in"}' }); resolve(); }, 900)));
    await page.reload();
    await page.locator('.agent-timeline-entry').first().waitFor({ timeout: 600 });
    expect(await page.locator('.agent-timeline-entry').count()).toBe(12);

    await expect.poll(() => page.locator('.agent-timeline-entry').count(), { timeout: 5000 }).toBe(0);
    await expect.poll(records, { timeout: 5000 }).toBe(0);
    const writes = await page.evaluate(() => (window as any).__puts.length);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).__puts.length)).toBe(writes);
    expect(await page.evaluate(() => (window as any).__puts.filter((name: string) => name === 'sessions').length)).toBe(0);
  } finally { await context.close(); }
});
