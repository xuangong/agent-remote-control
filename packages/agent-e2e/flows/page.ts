import type { Page } from '@playwright/test';
import type { ScriptedRow } from '@orchardworks/agent-e2e/stack';
import { SESSION_CONNECTION_PATTERN, sessionConnectionWordsIn } from '@orchardworks/agent-e2e/faults/connection-words.mjs';

/** The page's own words and controls, so a flow reads as what a person does. Selectors live here and nowhere else. */

export const timelineEntries = (page: Page) => page.locator('.agent-timeline-entry');
export const waitForEntries = (page: Page, count: number) => page.waitForFunction(needed => document.querySelectorAll('.agent-timeline-entry').length >= needed, count);
export const showsText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => document.body.innerText.includes(needle), text, { timeout });
export const lacksText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => !document.body.innerText.includes(needle), text, { timeout });

export async function send(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="prompt-input"]').click();
  await page.keyboard.type(text);
  await page.locator('[data-testid="prompt-submit"]').click();
}

/** Turns on a panel in the View options menu of the session view (Header holds the Workbench and Trace tabs). */
export async function toggleViewPanel(page: Page, panel: 'Header' | 'Sidebar' | 'Replica Inspector'): Promise<void> {
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await options.getByRole('checkbox', { name: panel, exact: true }).click();
  await page.keyboard.press('Escape');
}

export async function showTrace(page: Page): Promise<void> {
  if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
}

/** The sidebar rail: shown at once on an empty Window, hidden when the page opened with a session until View options turns it on. */
async function showRail(page: Page): Promise<void> {
  await page.locator('.lab-shell').waitFor();
  const rail = page.locator('#lab-context');
  if (await rail.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) return;
  await toggleViewPanel(page, 'Sidebar');
  await rail.waitFor({ state: 'visible' });
}

/** Opens the Settings page from the sidebar rail, showing the rail first when a session hides it. */
export async function openSettings(page: Page): Promise<void> {
  await showRail(page);
  await page.getByRole('button', { name: 'Sidebar settings', exact: true }).click();
}

/** Opens All sessions from the sidebar rail. */
export async function openAllSessions(page: Page): Promise<void> {
  await showRail(page);
  await page.locator('#lab-context').getByRole('navigation', { name: 'Shortcuts' }).getByRole('button', { name: 'All sessions', exact: true }).click();
}

/** A history of `count` numbered rows, alternating between the person and the assistant: "Row 1", "Row 2", and so on. */
export function numberedHistory(count: number, padding = '', first = 1): ScriptedRow[] {
  return Array.from({ length: count }, (_, at) => ({ role: (first + at) % 2 === 1 ? 'user' as const : 'assistant' as const, text: `Row ${first + at}${padding}`, key: `r${first + at}` }));
}

/** The conversation's scroll container. */
export const timelineScroll = (page: Page) => page.getByTestId('timeline');

/** Where the row that shows `text` sits in the viewport, in pixels from the top of the timeline; `undefined` while it is not rendered. */
export const rowOffset = (page: Page, text: string): Promise<number | undefined> => page.evaluate(needle => {
  const viewport = document.querySelector('[data-testid="timeline"]');
  const entry = [...document.querySelectorAll('.agent-timeline-entry')].find(node => (node.textContent ?? '').includes(needle));
  return viewport && entry ? Math.round(entry.getBoundingClientRect().top - viewport.getBoundingClientRect().top) : undefined;
}, text);

/**
 * Passes the page's WebSockets through to the Relay and lets a flow cut them, as a network drop does: `drop()` closes every open socket
 * of the page, and the page opens new ones by itself. With `held`, the Relay's first timeline page of a session, and every frame after it
 * on that socket, waits until `release()` (with `'agent_snapshot'`, the first snapshot of the session instead of the first timeline page); the page has by then everything else (the account, the Hosts, the subscription) but no
 * conversation rows from the Relay. Install it before the page loads.
 */
export async function watchSockets(page: Page, held: boolean | 'agent_snapshot' = false) {
  const holdFrom = held === 'agent_snapshot' ? '"type":"agent_snapshot"' : '"type":"timeline_page"';
  const open = new Set<import('@playwright/test').WebSocketRoute>();
  const releases: Array<() => void> = [];
  let released = !held;
  let closed = 0;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    open.add(socket);
    socket.onClose(() => { if (open.delete(socket)) closed += 1; });
    const waiting: Array<string | Buffer> = [];
    let holding = false;
    server.onMessage(message => {
      if (!released && (holding || (typeof message === 'string' && message.includes(holdFrom)))) { holding = true; waiting.push(message); return; }
      socket.send(message);
    });
    releases.push(() => { holding = false; for (const message of waiting.splice(0)) socket.send(message); });
  });
  return {
    drop: async () => { const cut = [...open]; open.clear(); closed += cut.length; await Promise.all(cut.map(socket => socket.close({ code: 1006, reason: 'network dropped' }))); return cut.length; },
    release: () => { released = true; for (const release of releases) release(); },
    /** Runs `cause` (a Relay restart, say) and waits until every socket the page had was lost and the page has the same number open again. */
    async recoveredFrom(cause: () => Promise<void>, timeout = 30_000) {
      const steady = open.size, lostBefore = closed;
      await cause();
      const until = Date.now() + timeout;
      while (closed - lostBefore < steady || open.size < steady) {
        if (Date.now() > until) throw new Error(`The page did not reconnect its ${steady} sockets in ${timeout} ms.`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
  };
}

/**
 * Waits until the device store holds a conversation that contains `text`. The page writes behind what it shows, after a quiet moment
 * or when it is hidden; a page closed earlier would lose the write that is still queued.
 */
export async function waitForKeptConversation(page: Page, text: string, timeout = 15_000): Promise<void> {
  const kept = () => page.evaluate(needle => new Promise<boolean>(resolve => {
    const opening = indexedDB.open('agent-remote-image-drafts');
    opening.onerror = () => resolve(false);
    opening.onsuccess = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains('sessions')) { database.close(); resolve(false); return; }
      const all = database.transaction('sessions').objectStore('sessions').getAll();
      all.onsuccess = () => { database.close(); resolve(all.result.some(record => JSON.stringify(record).includes(needle))); };
      all.onerror = () => { database.close(); resolve(false); };
    };
  }), text);
  const until = Date.now() + timeout;
  while (!await kept()) {
    if (Date.now() > until) throw new Error(`The device store did not keep a conversation with "${text}" in ${timeout} ms.`);
    await page.waitForTimeout(100);
  }
}

/** Turns the sidebar rail on when a session page hides it, and returns it. */
export async function showSidebar(page: Page) {
  await page.locator('.lab-shell').waitFor();
  const rail = page.locator('#lab-context');
  if (!await rail.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) { await toggleViewPanel(page, 'Sidebar'); await rail.waitFor({ state: 'visible' }); }
  return rail;
}

export const composerOf = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

/**
 * Records, from before the first paint, every T5 connection word that any frame of the page shows: a MutationObserver checks the
 * `innerText` of the visible page (hidden nodes have none) after every change, except while the Relay's sign-in page is up. Install it before the page loads.
 */
export async function watchWords(page: Page): Promise<{ seen(): Promise<string[]> }> {
  await page.addInitScript(({ source, flags }) => {
    const pattern = new RegExp(source, flags);
    const found = new Set<string>();
    (window as unknown as { __connectionWordTexts: Set<string> }).__connectionWordTexts = found;
    const look = () => {
      // The Relay's sign-in page (.arc-access) is not a session; its own words are out of scope.
      if (document.querySelector('.arc-access')) return;
      const text = document.body?.innerText ?? '';
      for (const line of text.split('\n')) if (pattern.test(line)) found.add(line.trim());
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  }, { source: SESSION_CONNECTION_PATTERN.source, flags: SESSION_CONNECTION_PATTERN.flags.replace(/[gy]/g, '') });
  return {
    seen: async () => {
      const texts = await page.evaluate(() => [...((window as unknown as { __connectionWordTexts?: Set<string> }).__connectionWordTexts ?? [])]);
      return [...new Set(texts.flatMap(text => sessionConnectionWordsIn(text)))];
    },
  };
}
