import { expect, test } from '@playwright/test';
import { PageProbe, sessionPane } from '@orchardworks/agent-e2e/smoke/probe';

// A Window shows several conversations at once: primary groups side by side, docks beside them, and on the local instance
// the views of earlier runs. Each conversation names the address of its session, and the smoke harness reads and drives the
// session its link opened by that name: its probe, its observer and its composer, whichever place the Window gives it.

const fixture = '/e2e/fixtures/window-tiles.html?tiles=2&docks=1';
const address = (tile: number) => `host/recorded/tile-${tile}`;

test.skip(({ isMobile }) => isMobile, 'The smoke opens its pages on a desktop width, where a Window shows its tiles side by side.');

test('each session of a Window is found by its address once, in a primary group or a dock', async ({ page }) => {
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
