import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * The device store in a real browser with real IndexedDB: a page that read a conversation, reloaded. The product's timeline and activity status render
 * a replica restored from the stored record; the Relay's pages are the only simulated part. Nothing is asserted about source text, only about what the
 * page shows and when: rows in the first frame, no opening word at any moment, no frame without rows, and the same row nodes after the first page confirms.
 */
let script = '', css = '', url = '';
const server = createServer((request, response) => {
  response.setHeader('content-type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/fixture.js' ? script : `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
let browser: Browser;
beforeAll(async () => {
  const source = `
    import React, { useSyncExternalStore } from 'react';
    import { createRoot } from 'react-dom/client';
    import './session-view-styles.ts';
    import { AgentTimeline } from '../../agent-remote-web/src/react/AgentTimeline.tsx';
    import { AgentActivityStatus } from '../../agent-remote-web/src/react/AgentActivityStatus.tsx';
    import { remoteSessionState } from '../../agent-remote-web/src/client/session-state.ts';
    import { AgentReplica } from '../../agent-remote-web/src/replica/store.ts';
    import { deviceStore } from '../../agent-remote-web/src/device-store.ts';
    import { createStoredRecord, decodeStoredRecord, DEFAULT_WINDOW_LIMITS } from '../../agent-remote-web/src/session-record.ts';

    const scope = { relayUrl: 'https://relay.example/u/alice/', principalId: 'alice' };
    const identity = ['host', 'copilot', 'one'];
    const capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } };
    const snapshot = { id: 'one', providerId: 'copilot', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
      status: 'idle', activeTurn: null, pendingInteractions: [], capabilities, runtimeInfo: { providerId: 'copilot', sessionId: 'one', status: 'idle' } };
    const entry = row => ({ providerId: 'copilot', itemKey: row.key, turnId: 't', timestamp: '2026-11-16T00:00:00Z', seqStart: row.seq, seqEnd: row.seq,
      sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }], collapsed: [], resources: [], item: { type: 'assistant_message', text: row.text, messageId: row.key } });
    const page = (direction, epoch, rows) => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'r', agentId: 'one', direction, epoch, reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1000, nextSeq: rows.length + 1 }, startCursor: rows.length ? { epoch, seq: rows[0].seq } : null, endCursor: rows.length ? { epoch, seq: rows.at(-1).seq } : null,
      hasOlder: false, hasNewer: false, entries: rows.map(entry), error: null } });

    const replica = new AgentReplica();
    window.replica = replica;
    let connection = 'connecting';
    const listeners = new Set();
    window.setConnection = value => { connection = value; for (const listener of listeners) listener(); };
    // What a first visit does: read the conversation, then keep it.
    window.firstVisit = async (epoch, rows) => {
      replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: snapshot });
      replica.applyHistory(page('tail', epoch, rows));
      const { timeline } = replica.getState();
      deviceStore.put(createStoredRecord(scope, identity, { agentId: 'one', epoch: timeline.epoch, nextSeq: timeline.nextSeq, hasOlder: false, entries: timeline.entries, snapshot: replica.getState().agent }, DEFAULT_WINDOW_LIMITS, Date.now()));
      await deviceStore.flush();
    };
    // What the connection's first page does.
    window.firstPage = (direction, epoch, rows, stale) => {
      if (stale) replica.applyHistory({ ...page('after', epoch, []), payload: { ...page('after', epoch, []).payload, reset: true, staleCursor: true } });
      replica.applyHistory(page(direction, epoch, rows));
      window.setConnection('ready');
    };
    window.ready = (async () => {
      await deviceStore.preload(scope);
      const record = deviceStore.read(scope, identity);
      const stored = record && decodeStoredRecord(record, scope, identity);
      if (stored) replica.restoreFromDevice(stored);
    })();

    function Screen() {
      const state = useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState());
      useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => connection);
      const session = remoteSessionState(state, connection);
      return <div style={{ width: '720px' }}><AgentActivityStatus state={state} sessionState={session} /><AgentTimeline state={state} /></div>;
    }
    // Every state the page is in: rows and opening words, recorded as the document changes.
    window.frames = [];
    const record = () => window.frames.push({ rows: document.querySelectorAll('.agent-timeline-entry').length, text: document.body.textContent });
    window.ready.then(() => {
      createRoot(document.getElementById('root')).render(<Screen />);
      new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) }, bundle: true, write: false,
    outfile: 'fixture.js', loader: { '.woff2': 'dataurl' }, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

interface Row { key: string; seq: number; text: string }
const rows = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, seq: index + 1, text: `Reply number ${index}. ${'Readable conversation text. '.repeat(3)}` }));
const opening = /Opening session|Synchronizing|Checking access/;

/** A browser context that has read the conversation once and is back on a fresh page. */
async function knownConversation(initialScript?: string) {
  const context = await browser.newContext({ viewport: { width: 900, height: 760 } });
  if (initialScript) await context.addInitScript(initialScript);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof (window as any).firstVisit === 'function');
  await page.evaluate(([list]) => (window as any).ready.then(() => (window as any).firstVisit('epoch-one', list)), [rows(30)] as const);
  return { context, page, errors };
}
const marks = (page: Page) => page.evaluate(() => { (window as any).marks = new Map([...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey, node])); });
const frameSummary = (page: Page) => page.evaluate(() => ({ rowless: (window as any).frames.filter((frame: any) => frame.rows === 0).length, count: (window as any).frames.length }));
const sawOpening = (page: Page) => page.evaluate(source => (window as any).frames.some((frame: any) => new RegExp(source).test(frame.text)), opening.source);

it('shows the stored rows in the first frame after a reload, with no opening word at any moment', async () => {
  const { context, page, errors } = await knownConversation();
  try {
    await page.reload();
    await page.locator('.agent-timeline-entry').first().waitFor();
    const firstFrame = await page.evaluate(() => (window as any).frames[0]);
    expect(firstFrame.rows).toBe(30);
    expect(firstFrame.text).not.toMatch(/Opening session|Synchronizing|Checking access/);
    expect(await page.evaluate(() => (window as any).replica.getState().timeline.restoredFromDevice)).toBe(true);
    // The connection opens and its first page confirms the rows: the same nodes stay, no frame is without rows, no opening word appears.
    await marks(page);
    await page.evaluate(() => { (window as any).setConnection('catching_up'); });
    await page.evaluate(([list]) => (window as any).firstPage('after', 'epoch-one', []), [rows(30)] as const);
    const kept = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')].every(node => (window as any).marks.get(node.dataset.entryKey) === node));
    expect(kept).toBe(true);
    expect((await frameSummary(page)).rowless).toBe(0);
    expect(await sawOpening(page)).toBe(false);
    expect(await page.evaluate(() => (window as any).replica.getState().timeline.restoredFromDevice)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

it('replaces stored rows by key when the Relay holds another epoch, keeping unchanged nodes and never an empty timeline', async () => {
  const { context, page } = await knownConversation();
  try {
    await page.reload();
    await page.locator('.agent-timeline-entry').first().waitFor();
    await marks(page);
    const next = rows(30).filter(row => row.key !== 'k5').map(row => row.key === 'k7' ? { ...row, text: 'Edited reply.' } : row).map((row, index) => ({ ...row, seq: index + 1 }));
    await page.evaluate(([list]) => (window as any).firstPage('tail', 'epoch-two', list, true), [next] as const);
    const result = await page.evaluate(() => {
      const marked = (window as any).marks as Map<string, HTMLElement>;
      const now = [...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')];
      return { keys: now.map(node => node.dataset.entryKey), replaced: now.filter(node => marked.has(node.dataset.entryKey!) && marked.get(node.dataset.entryKey!) !== node).map(node => node.dataset.entryKey), edited: now.find(node => node.dataset.entryKey === 'k7')?.textContent };
    });
    expect(result.keys).not.toContain('k5');
    expect(result.keys).toHaveLength(29);
    expect(result.replaced).toEqual([]);
    expect(result.edited).toContain('Edited reply.');
    expect((await frameSummary(page)).rowless).toBe(0);
    expect(await sawOpening(page)).toBe(false);
  } finally { await context.close(); }
});

it('says Reconnecting, never hides it, when the connection breaks while stored rows are held', async () => {
  const { context, page } = await knownConversation();
  try {
    await page.reload();
    await page.locator('.agent-timeline-entry').first().waitFor();
    await page.evaluate(() => { (window as any).setConnection('disconnected'); });
    await expect.poll(() => page.evaluate(() => document.body.textContent)).toContain('Reconnecting');
    expect(await page.locator('.agent-timeline-entry').count()).toBe(30);
  } finally { await context.close(); }
});

it('works from memory when the browser gives the page no IndexedDB: the conversation reads and renders, and a reload simply starts empty', async () => {
  const { context, page, errors } = await knownConversation('Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });');
  try {
    await page.locator('.agent-timeline-entry').first().waitFor();
    expect(await page.locator('.agent-timeline-entry').count()).toBe(30);
    await page.reload();
    await page.waitForFunction(() => (window as any).ready);
    await page.evaluate(() => (window as any).ready);
    expect(await page.locator('.agent-timeline-entry').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
