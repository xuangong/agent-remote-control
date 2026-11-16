import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * A replacement of a journal in a real browser: the product's timeline, composer and scroll hook render the replica, and the
 * replica takes the replacement the way the client does (`replaceTimeline`, then the tail). Layout, focus, selection and scroll
 * positions are the browser's own, so nothing here is simulated except the Relay that would send the frames.
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
    import { AgentComposer } from '../../agent-remote-web/src/react/AgentComposer.tsx';
    import { useTimelineScroll } from '../../agent-remote-web/src/react/useTimelineScroll.ts';
    import { remoteSessionState } from '../../agent-remote-web/src/client/session-state.ts';
    import { AgentReplica } from '../../agent-remote-web/src/replica/store.ts';

    const replica = new AgentReplica();
    window.replica = replica;
    const positions = new Map();
    const capabilities = { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } };
    replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { id: 'one', providerId: 'copilot', createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
      status: 'idle', activeTurn: null, pendingInteractions: [], capabilities, runtimeInfo: { providerId: 'copilot', sessionId: 'one', status: 'idle' } } });
    const entry = row => ({ providerId: 'copilot', itemKey: row.key, turnId: 't', timestamp: '2026-11-16T00:00:00Z', seqStart: row.seq, seqEnd: row.seq,
      sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }], collapsed: [], resources: [],
      item: row.user ? { type: 'user_message', text: row.text, messageId: row.key } : { type: 'assistant_message', text: row.text, messageId: row.key } });
    const page = (direction, epoch, rows, hasOlder) => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: { requestId: 'r', agentId: 'one', direction, epoch, reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1000, nextSeq: 1001 }, startCursor: rows.length ? { epoch, seq: rows[0].seq } : null, endCursor: rows.length ? { epoch, seq: rows.at(-1).seq } : null,
      hasOlder, hasNewer: false, entries: rows.map(entry), error: null } });
    window.loadTail = (epoch, rows, hasOlder) => { replica.applyHistory(page('tail', epoch, rows, hasOlder)); };
    window.replaceWith = (epoch, rows, hasOlder) => { replica.replaceTimeline(epoch); replica.applyHistory(page('tail', epoch, rows, hasOlder)); };
    window.loadOlder = (epoch, rows, hasOlder) => { replica.applyHistory(page('before', epoch, rows, hasOlder)); };
    window.setNotice = height => { document.querySelector('#notice').style.height = height + 'px'; };
    window.replacementPending = (epoch) => { replica.replaceTimeline(epoch); };

    function Screen() {
      const state = useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState());
      const scroll = useTimelineScroll('one', true, positions, undefined, undefined, state.timeline.entries, 'bottom');
      return <div style={{ display: 'flex', flexDirection: 'column', height: '640px', width: '720px' }}>
        <div id="viewport" ref={scroll.viewportRef} onScroll={scroll.onScroll} onWheel={scroll.onWheel} style={{ flex: '1 1 auto', overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column-reverse' }}>
          <div ref={scroll.contentRef} style={{ flex: 'none' }}><AgentTimeline state={state} /></div>
        </div>
        <div id="notice" style={{ flex: 'none', height: '0px' }} />
        <AgentComposer state={state} sessionState={remoteSessionState(undefined, 'ready')} onSendMessage={async () => {}} />
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Screen />);
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

interface Row { key: string; seq: number; text: string; user?: boolean }
const sentence = (seed: number) => `Row ${seed}. ${'Readable conversation text that wraps over several lines. '.repeat(2 + (seed * 7) % 5)}`;
const rows = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, seq: index + 1, text: sentence(index), user: index % 5 === 0 }));

async function openPage(initial: Row[], hasOlder = false) {
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => typeof (window as unknown as { loadTail?: unknown }).loadTail === 'function');
  await page.evaluate(([epoch, list, older]) => (window as any).loadTail(epoch, list, older), ['epoch-one', initial, hasOlder] as const);
  await page.locator('.agent-timeline-entry').first().waitFor();
  // Watch for any moment the timeline shows no rows, and for the composer being disabled.
  await page.evaluate(() => {
    const w = window as any;
    w.sawNoRows = false; w.composerDisabled = false;
    const check = () => {
      if (document.querySelectorAll('.agent-timeline-entry').length === 0) w.sawNoRows = true;
      const editor = document.querySelector('[data-testid="prompt-input"]') as HTMLElement | null;
      if (editor && (editor.hasAttribute('disabled') || editor.getAttribute('aria-disabled') === 'true' || editor.getAttribute('contenteditable') === 'false')) w.composerDisabled = true;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  return { page, errors };
}

/** Scrolls so that the row `key` sits `offset` px below the viewport top, then lets the scroll hook take its anchor. */
async function readAt(page: Page, key: string, offset: number) {
  await page.locator('#viewport').dispatchEvent('wheel', { deltaY: -1 });
  await page.evaluate(([wanted, px]) => {
    const viewport = document.querySelector('#viewport') as HTMLElement;
    const node = document.querySelector(`[data-entry-key="${wanted}"]`) as HTMLElement;
    viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (px as number);
    viewport.dispatchEvent(new Event('scroll'));
  }, [key, offset] as const);
  await page.waitForTimeout(150);
}
const topOf = (page: Page, key: string) => page.evaluate(wanted => {
  const node = document.querySelector(`[data-entry-key="${wanted}"]`) as HTMLElement | null;
  return node ? node.getBoundingClientRect().top - (document.querySelector('#viewport') as HTMLElement).getBoundingClientRect().top : null;
}, key);
const firstVisible = (page: Page) => page.evaluate(() => {
  const viewport = document.querySelector('#viewport') as HTMLElement;
  const top = viewport.getBoundingClientRect().top;
  return ([...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')].find(node => node.getBoundingClientRect().bottom > top + 1))?.dataset.entryKey ?? null;
});
const keysOf = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => node.dataset.entryKey));

it('keeps every unchanged row node and the reading position through a replacement', async () => {
  const { page, errors } = await openPage(rows(60));
  try {
    await readAt(page, 'k30', 40);
    await page.evaluate(() => { (window as any).marks = new Map([...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey, node])); });
    const before = await topOf(page, 'k30');
    const anchorKey = (await firstVisible(page))!;
    const anchorBefore = await topOf(page, anchorKey);
    // k2 and k10 (above the reader) and k45 (below) are gone, k20 changed, and new rows join above and below the reader.
    const next = rows(60).filter(row => !['k2', 'k10', 'k45'].includes(row.key)).map(row => row.key === 'k20' ? { ...row, text: `${row.text} Edited.` } : row);
    const withNew = [...next.slice(0, 12), { key: 'n1', seq: 0, text: 'New above the reader', user: false }, ...next.slice(12, 40), { key: 'n2', seq: 0, text: 'New below the reader' }, ...next.slice(40)]
      .map((row, index) => ({ ...row, seq: index + 1 }));
    await page.evaluate(([list]) => (window as any).replaceWith('epoch-two', list, false), [withNew] as const);
    await page.waitForTimeout(300);

    const result = await page.evaluate(() => {
      const marks = (window as any).marks as Map<string, HTMLElement>;
      const now = new Map([...document.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey!, node]));
      const kept = [...now].filter(([key]) => marks.has(key));
      return { replacedNodes: kept.filter(([key, node]) => marks.get(key) !== node).map(([key]) => key), keptCount: kept.length, keys: [...now.keys()], sawNoRows: (window as any).sawNoRows };
    });
    expect(result.replacedNodes).toEqual([]);
    expect(result.keptCount).toBe(57);
    expect(new Set(result.keys).size).toBe(result.keys.length);
    expect(result.sawNoRows).toBe(false);
    // The row the reader was on keeps its place, and the rows below it keep their distance to it. The scroll hook holds the first visible
    // line of text, rows sit at half-pixel offsets and scrollTop holds whole pixels, so the row can sit a few pixels off; a jump would
    // be the height of the rows that were added or removed above it (more than 100 px here).
    const anchorAfter = await topOf(page, anchorKey);
    expect(Math.abs((anchorAfter as number) - (anchorBefore as number))).toBeLessThanOrEqual(4);
    expect(Math.abs(((await topOf(page, 'k30')) as number) - (before as number))).toBeLessThanOrEqual(4);
    expect(await page.evaluate(() => (window as any).marks.get('k20').isConnected)).toBe(true);
    expect(await page.locator('[data-entry-key="k20"]').textContent()).toContain('Edited.');
    expect(errors.filter(message => /same key|unique "key"/.test(message))).toEqual([]);
  } finally { await page.close(); }
});

it('lands a reader above the new window on its first row and lets them read older history again', async () => {
  const all = rows(120);
  const { page, errors } = await openPage(all.slice(60), true);
  try {
    await page.evaluate(([list]) => (window as any).loadOlder('epoch-one', list, true), [all.slice(30, 60)] as const);
    await page.waitForTimeout(100);
    await readAt(page, 'k35', 10);
    // The replacement's window starts at k80: the reader's rows are older than it.
    const window_ = all.slice(80);
    await page.evaluate(([list]) => (window as any).replaceWith('epoch-two', list, true), [window_] as const);
    await page.waitForTimeout(300);
    expect((await keysOf(page))[0]).toBe('k80');
    expect(await firstVisible(page)).toBe('k80');
    expect(await page.evaluate(() => (window as any).sawNoRows)).toBe(false);
    // Older history arrives again: the rows above the window are read and the viewport can scroll up through them.
    await page.evaluate(([list]) => (window as any).loadOlder('epoch-two', list, true), [all.slice(50, 80)] as const);
    await page.waitForTimeout(200);
    const keys = await keysOf(page);
    expect(keys.slice(0, 3)).toEqual(['k50', 'k51', 'k52']);
    expect(new Set(keys).size).toBe(keys.length);
    await page.evaluate(() => { const viewport = document.querySelector('#viewport') as HTMLElement; viewport.scrollTop = -(viewport.scrollHeight - viewport.clientHeight); });
    expect(await firstVisible(page)).toBe('k50');
    expect(errors.filter(message => /same key|unique "key"/.test(message))).toEqual([]);
  } finally { await page.close(); }
});

it('keeps the composer\'s text, focus and selection, and never disables it, through a replacement', async () => {
  const { page } = await openPage(rows(30));
  try {
    const editor = page.locator('[data-testid="prompt-input"]');
    await editor.click();
    await page.keyboard.type('A draft in progress');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    const read = () => page.evaluate(() => {
      const node = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement | HTMLElement;
      const text = 'value' in node ? (node as HTMLTextAreaElement).value : node.textContent ?? '';
      const selection = 'selectionStart' in node ? [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd] : [window.getSelection()?.anchorOffset, window.getSelection()?.focusOffset];
      return { text, focused: node.contains(document.activeElement) || document.activeElement === node, selection };
    });
    const before = await read();
    expect(before.text).toBe('A draft in progress');
    expect(before.focused).toBe(true);
    await page.evaluate(() => { (window as any).composerNode = document.querySelector('[data-testid="prompt-input"]'); });
    await page.evaluate(([list]) => (window as any).replaceWith('epoch-two', list, false), [rows(30).filter(row => row.key !== 'k4').map((row, index) => ({ ...row, seq: index + 1 }))] as const);
    await page.waitForTimeout(300);
    expect(await read()).toEqual(before);
    expect(await page.evaluate(() => (window as any).composerNode === document.querySelector('[data-testid="prompt-input"]'))).toBe(true);
    expect(await page.evaluate(() => (window as any).composerDisabled)).toBe(false);
  } finally { await page.close(); }
});

it('keeps the reader\'s line when the viewport changes height without any change to the rows (a notice appears and goes)', async () => {
  const { page } = await openPage(rows(60));
  try {
    await readAt(page, 'k30', 40);
    const key = (await firstVisible(page))!;
    const before = await topOf(page, key);
    for (const height of [32, 62, 21, 0]) { await page.evaluate(px => (window as any).setNotice(px), height); await page.waitForTimeout(120); }
    await page.waitForTimeout(300);
    expect(Math.abs(((await topOf(page, key)) as number) - (before as number))).toBeLessThanOrEqual(4);
  } finally { await page.close(); }
});
