import { expect, test } from '@playwright/test';
import { PageProbe, sessionPane } from '@orchardworks/agent-e2e/smoke/probe';

// A Window shows several conversations at once: primary groups side by side, docks beside them, and on the local instance
// the views of earlier runs. Each conversation names the native session it shows, and the smoke harness reads and drives the
// session its link opened by that name: its probe, its observer and its composer, whichever place the Window gives it.

const fixture = '/e2e/fixtures/window-tiles.html?tiles=2&docks=1';
const address = (tile: number) => `host/recorded/tile-${tile}`;

test.skip(({ isMobile }) => isMobile, 'The smoke opens its pages on a desktop width, where a Window shows its tiles side by side.');

test('each session of a Window is found by its name once, in a primary group or a dock', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixture);
  // Both primary groups are primary conversations: that class names no one session.
  await expect(page.locator('.lab-primary-conversation')).toHaveCount(2);
  for (const tile of [1, 2, 3]) {
    const conversation = page.locator(sessionPane(address(tile)));
    await expect(conversation).toHaveCount(1);
    await expect(conversation.locator('.agent-timeline-entry').first()).toContainText(`of tile-${tile}.`);
    await expect(conversation.getByTestId('prompt-input')).toHaveCount(1);
  }
});

for (const [tile, place] of [[1, 'the first primary group'], [2, 'the second primary group'], [3, 'a dock']] as const) {
  test(`the smoke probe reads and drives the session its link opened, in ${place}`, async ({ context, baseURL }) => {
    const probe = await PageProbe.create(context, Date.now());
    await probe.page.setViewportSize({ width: 1280, height: 900 });
    const paint = await probe.open(`${baseURL}${fixture}&working=tile-${tile}&host=host&provider=recorded&session=tile-${tile}`, 'open', { rowsDeadlineMs: 20_000 });
    expect(paint.timedOut).toBeUndefined();
    const rows = await probe.rows();
    expect(rows).toHaveLength(24);
    expect(rows.filter(row => !row.text.includes(`of tile-${tile}.`))).toEqual([]);
    const seen = await probe.page.evaluate(() => (window as any).__smoke.read());
    expect(seen).toMatchObject({ composer: 'enabled', entries: 24 });
    // The tile says that its assistant is working; the observer reads that status, and no other tile's.
    expect(seen.labels).toEqual([await probe.page.locator(`${sessionPane(address(tile))} .lab-tile-sentence`).innerText()]);
    expect(await probe.assistantCount()).toBe(24);
    // What it types goes into this session's composer and stays there.
    await probe.composer().click();
    await probe.page.keyboard.type('draft kept');
    expect(await probe.page.evaluate(() => (window as any).__smoke.composer())).toEqual({ text: 'draft kept', focused: true });
    for (const other of [1, 2, 3].filter(item => item !== tile)) await expect(probe.page.locator(sessionPane(address(other))).getByTestId('prompt-input')).toHaveText('');
    await probe.close();
  });
}

test('the smoke probe opens its page with the process display its scenario reads: the page\'s own, or Full', async ({ context, baseURL }) => {
  const link = `${baseURL}${fixture}&host=host&provider=recorded&session=tile-3`;
  const display = (probe: PageProbe) => probe.page.locator(`${sessionPane(address(3))} [data-process-mode]`);
  // A probe that chooses nothing keeps the device's own default, Concise, which folds a turn's tool calls into its work line.
  const own = await PageProbe.create(context, Date.now());
  await own.page.setViewportSize({ width: 1280, height: 900 });
  expect((await own.open(link, 'own display', { rowsDeadlineMs: 20_000 })).timedOut).toBeUndefined();
  await expect(display(own)).toHaveAttribute('data-process-mode', 'concise');
  await own.close();
  // A scenario that reads every tool call as a row chooses Full, as this device's default, before the page's scripts run.
  const full = await PageProbe.create(context, Date.now(), { process: 'full' });
  await full.page.setViewportSize({ width: 1280, height: 900 });
  expect((await full.open(link, 'full display', { rowsDeadlineMs: 20_000 })).timedOut).toBeUndefined();
  await expect(display(full)).toHaveAttribute('data-process-mode', 'full');
  expect(await full.rows()).toHaveLength(24);
  await full.close();
});

test('the smoke probe reads the session the way M6 compares it with the native session: messages, activity and facts', async ({ context, baseURL }) => {
  // tile-2 is working; every fourth row of each tile is a message of the person's; each session has a model and an effort setting.
  const probe = await PageProbe.create(context, Date.now());
  await probe.page.setViewportSize({ width: 1280, height: 900 });
  expect((await probe.open(`${baseURL}${fixture}&working=tile-2&settings&users=4&host=host&provider=recorded&session=tile-2`, 'open', { rowsDeadlineMs: 20_000 })).timedOut).toBeUndefined();
  expect(await probe.userTexts()).toEqual([4, 8, 12, 16, 20, 24].map(index => `Question ${index} of tile-2`).map(text => expect.stringContaining(text)));
  expect(await probe.sessionStatus()).toBe('running');
  const facts = await probe.sessionFacts();
  expect(facts).toMatchObject({ Provider: 'recorded', Session: 'tile-2', Model: 'Recorded Large', 'Reasoning effort': 'medium' });
  // The details cover the conversation while they are open; the read closes them, so the composer takes the next message.
  await expect(probe.page.locator(`${sessionPane(address(2))} .lab-tile-who`)).toHaveAttribute('aria-expanded', 'false');
  await probe.composer().click();
  await probe.page.keyboard.type('after the facts');
  expect(await probe.page.evaluate(() => (window as any).__smoke.composer())).toEqual({ text: 'after the facts', focused: true });
  // Another tile's activity is its own.
  const idle = await PageProbe.create(context, Date.now());
  await idle.page.setViewportSize({ width: 1280, height: 900 });
  await idle.open(`${baseURL}${fixture}&working=tile-2&settings&host=host&provider=recorded&session=tile-1`, 'open', { rowsDeadlineMs: 20_000 });
  expect(await idle.sessionStatus()).toBe('idle');
  await idle.close();
  await probe.close();
});
