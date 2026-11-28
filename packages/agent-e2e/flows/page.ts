import type { Page } from '@playwright/test';
import { actAsLocalUser, type ScriptedRow, type Stack } from '@orchardworks/agent-e2e/stack';
import { SESSION_CONNECTION_PATTERN, sessionConnectionWordsIn } from '@orchardworks/agent-e2e/faults/connection-words.mjs';

/** The page's own words and controls, so a flow reads as what a person does. Selectors live here and nowhere else. */

export const timelineEntries = (page: Page) => page.locator('.agent-timeline-entry');
export const waitForEntries = (page: Page, count: number) => page.waitForFunction(needed => document.querySelectorAll('.agent-timeline-entry').length >= needed, count);
export const showsText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => document.body.innerText.includes(needle), text, { timeout });
export const lacksText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => !document.body.innerText.includes(needle), text, { timeout });
/**
 * The page holds the text, on screen or not. A turn far below a reader who scrolled up is not rendered (`content-visibility`), so
 * its words are in the timeline but not in the page's rendered text.
 */
export const holdsText = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(needle => !!document.body.textContent?.includes(needle), text, { timeout });

/** The composer holds exactly `text`. */
export const showsInput = (page: Page, text: string, timeout = 25_000) => page.waitForFunction(expected => document.querySelector('[data-testid="prompt-input"]')?.textContent === expected, text, { timeout });

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

/** An assistant's details: beside the conversation or over the window on a wide screen, a sheet on a phone. */
export const assistantDetails = (page: Page) => page.locator('.lab-tile-details:visible, .lab-assistant-details:visible, dialog.orchard-sheet[open]').first();

/** The Sessions list of the assistant on screen, from its details: opened from its tile or its top bar as needed. */
export async function sessionsList(page: Page) {
  const list = assistantDetails(page).locator('.lab-assistant-sessions');
  if (!await list.count()) await page.locator('button.lab-tile-who:visible, button.lab-assistant-title:visible').first().click();
  await list.waitFor();
  return list;
}

/** Closes the details of the assistant on screen, which a tile opens over its window and its composer. */
export async function closeDetails(page: Page): Promise<void> {
  await assistantDetails(page).getByRole('button', { name: /^Close/ }).first().click();
  await page.locator('.lab-tile-details:visible, .lab-assistant-details:visible, dialog.orchard-sheet[open]').first().waitFor({ state: 'hidden' }).catch(() => {});
}

/**
 * Chooses how much of each turn's work shows, for every assistant on this device: Settings > Assistants, then back to where the person was.
 */
export async function chooseProcessMode(page: Page, mode: 'Concise' | 'Process' | 'Full'): Promise<void> {
  const here = await page.locator('.lab-rail [aria-current="page"], .lab-tab-bar [aria-current="page"]').first().evaluate(node => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '');
  await openSettings(page, 'Assistants');
  await page.getByRole('group', { name: 'Default process display', exact: true }).getByRole('button', { name: mode, exact: true }).click();
  await goTo(page, here === 'Chats' ? 'Chats' : 'Windows');
}

export async function showTrace(page: Page): Promise<void> {
  if (!await page.getByRole('tab', { name: 'Trace', exact: true }).isVisible()) await toggleViewPanel(page, 'Header');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
}

/** The destination buttons of the page: the desktop's rail, or the phone's tab bar, whichever this width shows. */
const destinations = (page: Page) => page.locator('.lab-rail, .lab-tab-bar').first();

/**
 * Goes to a destination of the rail (Chats, Assistants, Windows, Settings) or, on a phone, of the tab bar (Me holds Settings). The words are
 * the page's, English or Chinese. On a phone a conversation hides the tab bar: Back returns to the list first.
 */
export async function goTo(page: Page, destination: 'Chats' | 'Assistants' | 'Windows' | 'Settings' | '聊天' | '助手' | '窗口' | '设置'): Promise<void> {
  const bar = destinations(page);
  await bar.waitFor({ state: 'attached' });
  if (!await bar.isVisible()) await page.locator('.lab-bot-back').first().click();
  await bar.waitFor({ state: 'visible' });
  const phone = await bar.evaluate(node => node.classList.contains('lab-tab-bar'));
  const me = destination === 'Settings' || destination === '设置';
  if (phone) await bar.locator('.lab-tab').filter({ hasText: me ? /^(Me|我)$/ : destination }).click();
  else await bar.getByRole('button', { name: destination, exact: true }).click();
}

/** Opens the Settings page (Me on a phone), and a group of it when one is named (its name in the page's language). */
export async function openSettings(page: Page, group?: string): Promise<void> {
  await goTo(page, 'Settings');
  if (group) await chooseSetting(page, group);
}

/** Chooses a group of the Settings page from its list: a column beside it on the desktop, the list under Me on a phone. */
export async function chooseSetting(page: Page, group: string): Promise<void> {
  // On a phone an open group is a screen of its own: its Back returns to the list.
  const back = page.locator('.lab-settings-head').getByRole('button').first();
  if (await back.isVisible()) await back.click();
  await page.locator('.lab-settings-group').filter({ has: page.locator('strong', { hasText: new RegExp(`^${group}$`) }) }).click();
}

/** Opens a computer's page from Settings > Computers, by the name its card shows. */
export async function openComputer(page: Page, name: string): Promise<void> {
  await page.locator('.lab-host-card').filter({ hasText: name }).locator('.lab-host-open').click();
  await page.locator('.lab-host-page').waitFor();
}

/** Opens All sessions from the sidebar rail. */
export async function openAllSessions(page: Page): Promise<void> {
  await showSidebar(page);
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
 *
 * For the lifecycle simulator (`LifecycleSockets`): `cut()` ends the Relay's side of every open socket while the page's side stays open and
 * carries nothing until `drop()`, as a connection that died while the page was frozen; `halfOpen()` lets nothing through either way and no
 * close reach the page, as a connection that looks open and is dead. Sockets the page opens afterwards work.
 */
export async function watchSockets(page: Page, held: boolean | 'agent_snapshot' = false) {
  const holdFrom = held === 'agent_snapshot' ? '"type":"agent_snapshot"' : '"type":"timeline_page"';
  type Route = import('@playwright/test').WebSocketRoute;
  const open = new Map<Route, { dead: boolean; cut(): void }>();
  const releases: Array<() => void> = [];
  let released = !held;
  let closed = 0;
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    // `dead`: nothing passes either way and no close reaches the page.
    const state = { dead: false, cut: () => { state.dead = true; server.close({ code: 1006, reason: 'network dropped' }); } };
    open.set(socket, state);
    socket.onClose((code, reason) => { if (open.delete(socket)) closed += 1; if (!state.dead) server.close({ code, reason }); });
    socket.onMessage(message => { if (!state.dead) server.send(message); });
    server.onClose((code, reason) => { if (!state.dead) void socket.close({ code, reason }); });
    const waiting: Array<string | Buffer> = [];
    let holding = false;
    server.onMessage(message => {
      if (state.dead) return;
      if (!released && (holding || (typeof message === 'string' && message.includes(holdFrom)))) { holding = true; waiting.push(message); return; }
      socket.send(message);
    });
    releases.push(() => { holding = false; for (const message of waiting.splice(0)) if (!state.dead) socket.send(message); });
  });
  return {
    drop: async () => { const cut = [...open.keys()]; open.clear(); closed += cut.length; await Promise.all(cut.map(socket => socket.close({ code: 1006, reason: 'network dropped' }))); return cut.length; },
    cut: () => { for (const state of open.values()) state.cut(); return open.size; },
    halfOpen: () => { for (const state of open.values()) state.dead = true; return open.size; },
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

/**
 * A second Controller paired as an installed one is: the page's own pairing endpoint issues the key (the flow that types it in is E1's),
 * and the Controller connects with it as a Host of its own. `close()` stops it.
 */
export async function pairSecondHost(stack: Stack, host: Omit<Parameters<Stack['pairController']>[0], 'key'>) {
  const key = await actAsLocalUser(stack.origin, async request => {
    const response = await request('POST', 'v1/remote/pairings', {});
    if (!response.ok) throw new Error(`The Relay did not issue a pairing key (${response.status} ${await response.text()}).`);
    return (await response.json() as { key: string }).key;
  });
  return stack.pairController({ key, ...host });
}

/** The goal pinned above the conversation, and its buttons by their words. */
export const goalLine = (page: Page) => page.locator('[data-goal-line]');
export const goalButton = (page: Page, name: 'Pause' | 'Resume' | 'Clear goal') => goalLine(page).getByRole('button', { name, exact: true });
