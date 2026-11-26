// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';
import { openSettingsPage } from './../all-sessions.js';

// Settings > Computers keeps the reader's place: a status that arrives or refreshes does not move the computer in view, and a
// computer's page returns to the list where it was left. The Workbench runs on the Vite server alone; the Relay's answers are routed.

const GiB = 2 ** 30;
const hosts = Array.from({ length: 12 }, (_, index) => ({
  id: `host-${index}`, name: `computer-${index}`, online: true, managed: true, access: 'owner', hostStatus: true, sessionControl: true,
  providers: [{ providerId: 'codex', displayName: 'Codex' }],
}));
const light = { sampledAt: 1, sessions: { running: 1, waiting: 0, idle: 0, failed: 0 }, cpu: { cores: 8, usage: 0.1 }, memory: { total: 24 * GiB, used: 14 * GiB }, disks: [{ kind: 'home', path: '/Users/a', total: 460 * GiB, used: 100 * GiB }] };
const full = {
  sampledAt: 2, sessions: { running: 2, waiting: 1, idle: 3, failed: 0 }, cpu: { cores: 8, usage: 0.4 }, memory: { total: 24 * GiB, used: 14 * GiB },
  disks: [{ kind: 'home', path: '/Users/a', total: 460 * GiB, used: 100 * GiB }, { kind: 'workspace', path: '/Volumes/P', total: 900 * GiB, used: 100 * GiB }],
  processes: ['claude', 'codex', 'node', 'zsh', 'vite'].map(label => ({ kind: 'session', label, cpu: 0.1, memory: 200 * 2 ** 20 })),
};

async function openComputers(page: Page, held = false) {
  let answer: object = light;
  let release = () => {};
  let gate = held ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  await page.route('**/auth/status', route => route.fulfill({ json: { basePath: '/u/alice/', expiresAt: Date.now() + 120_000 } }));
  await page.route('**/v1/remote/hosts', route => route.fulfill({ json: { hosts } }));
  await page.route('**/v1/remote/hosts/*/status', async route => { await gate; await route.fulfill({ json: answer }); });
  // Safari has no scroll anchoring; switch it off everywhere so the page itself has to keep the place.
  await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = '*{overflow-anchor:none!important}'; document.head.append(style); }); });
  await page.clock.install();
  await page.goto('/?mode=window');
  const settings = await openSettingsPage(page, 'Computers');
  const cards = settings.locator('.lab-host-card');
  await expect(cards).toHaveCount(hosts.length);
  if (!held) await expect(cards.first().locator('.lab-host-sessions:not([data-pending])')).toBeVisible();
  return { settings, cards, deliver: (next: object) => { answer = next; }, release: () => release(), hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); } };
}

/** The first card that reaches into the panel and its distance from the panel's top edge: what the reader is looking at. */
async function place(page: Page, settings: ReturnType<Page['locator']>) {
  return settings.evaluate(panel => {
    const edge = panel.getBoundingClientRect().top;
    const card = [...panel.querySelectorAll<HTMLElement>('.lab-host-card')].find(item => item.getBoundingClientRect().bottom > edge + 1)!;
    return { scrollTop: panel.scrollTop, id: card.dataset.hostId, offset: Math.round(card.getBoundingClientRect().top - edge) };
  });
}

test('a status refresh that makes the cards taller does not move the computer in view', async ({ page }) => {
  const { settings, cards, deliver } = await openComputers(page);
  const panel = settings.locator('xpath=ancestor-or-self::*[contains(@class,"lab-settings")][1]');
  const scrollable = (await panel.count()) ? panel : settings;
  await cards.nth(8).scrollIntoViewIfNeeded();
  await scrollable.evaluate(node => { node.scrollTop += 120; });
  const before = await place(page, scrollable);
  expect(before.scrollTop).toBeGreaterThan(300);
  const heights = await cards.evaluateAll(items => items.map(item => item.getBoundingClientRect().height));
  deliver(full);
  await page.clock.runFor(5_100);
  await expect(settings.locator('.lab-host-processes')).toHaveCount(hosts.length);
  const grew = await cards.evaluateAll(items => items.map(item => item.getBoundingClientRect().height));
  expect(grew[0], 'the refresh made the cards above taller').toBeGreaterThan(heights[0]! + 40);
  // The page settles on the next frame; the card in view is then where it was.
  await expect.poll(async () => { const now = await place(page, scrollable); return now.id === before.id && Math.abs(now.offset - before.offset) <= 1; }).toBe(true);
});

test('a computer page opens at its top and returns to the list where the reader left it', async ({ page }) => {
  const { settings, cards } = await openComputers(page);
  const panel = settings.locator('xpath=ancestor-or-self::*[contains(@class,"lab-settings")][1]');
  const scrollable = (await panel.count()) ? panel : settings;
  await cards.nth(8).scrollIntoViewIfNeeded();
  await scrollable.evaluate(node => { node.scrollTop += 60; });
  const before = await place(page, scrollable);
  await cards.nth(8).locator('.lab-host-open').click();
  await expect(settings.locator('.lab-host-page')).toBeVisible();
  expect((await place(page, scrollable).catch(() => ({ scrollTop: 0 }))).scrollTop).toBe(0);
  await settings.getByRole('button', { name: 'Back to computers' }).or(settings.locator('.lab-host-back')).click();
  await expect(settings.locator('.lab-host-page')).toHaveCount(0);
  await expect.poll(() => place(page, scrollable).then(now => `${now.id}@${now.offset}`)).toBe(`${before.id}@${before.offset}`);
});

test('the first status fills the space its card already holds, and a reopened page shows the last figures at once', async ({ page }) => {
  const { settings, cards, release, hold } = await openComputers(page, true);
  const waiting = await cards.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().height)));
  release();
  await expect(settings.locator('.lab-host-sessions:not([data-pending])')).toHaveCount(hosts.length);
  const loaded = await cards.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().height)));
  expect(loaded, 'no card changed its height when its figures arrived').toEqual(waiting);
  // Leave Settings and come back while the Relay does not answer: the cards open with the figures they last showed.
  hold();
  const phone = (page.viewportSize()?.width ?? 1440) <= 760;
  await (phone ? page.locator('.lab-tab-bar').getByRole('button', { name: 'Home' }).or(page.locator('.lab-tab-bar .lab-tab').first()) : page.locator('.lab-rail').getByRole('button').first()).click();
  await expect(settings).toBeHidden();
  const again = await openSettingsPage(page, 'Computers');
  await expect(again.locator('.lab-host-sessions:not([data-pending])')).toHaveCount(hosts.length);
  expect(await cards.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().height)))).toEqual(waiting);
});
