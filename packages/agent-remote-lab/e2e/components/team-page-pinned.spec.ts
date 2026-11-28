import { expect, test, type Page } from '@playwright/test';

// The team page of a bot stays visible as a pinned header line in any conversation of that bot: the free workbench tile of Window mode, the
// workbench's main tile and Bot mode's panel all show the same conversation. In a long conversation read at its end the line is still in view;
// opening it shows the table over the conversation, and neither opening it nor a rewrite moves a single entry.
const scroller = (page: Page) => page.locator('.agent-timeline-entries').last().evaluateHandle(node => { let at: HTMLElement | null = node as HTMLElement;
  while (at && !(['auto', 'scroll'].includes(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight)) at = at.parentElement; return at!; });
// How far the last entry stands above the foot of the conversation's scroll area, which a reader at the end of the conversation keeps in view.
const lastEntryTop = (page: Page) => page.locator('.agent-timeline-entries').last().evaluate(node => { let at: HTMLElement | null = node as HTMLElement;
  while (at && !(['auto', 'scroll'].includes(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight)) at = at.parentElement;
  return (node.lastElementChild as HTMLElement).getBoundingClientRect().bottom - at!.getBoundingClientRect().bottom; });

for (const layout of ['', 'layout=bot&mode=bot&section=notes&bot=chief']) {
  test(`pins the team page line in a long conversation read at its end (${layout ? 'Bot mode' : 'free tile'}), opens over it and shifts nothing`, async ({ page }, testInfo) => {
    await page.goto(`/e2e/fixtures/assistant-conversation.html?pages=1&${layout}`);
    const card = page.locator('[data-page-card]').first();
    await expect(card).toHaveCount(1);
    const holder = await scroller(page);
    // A conversation opens at its end, far below the card's natural place at its top.
    expect(await holder.evaluate(node => (node as HTMLElement).scrollHeight - (node as HTMLElement).clientHeight)).toBeGreaterThan(600);
    const inView = () => Promise.all([card.boundingBox(), holder.evaluate(node => (node as HTMLElement).getBoundingClientRect().top)]).then(([box, top]) => !!box && box.y >= top - 1 && box.y <= top + 80);
    await expect.poll(inView).toBe(true);
    // The conversation has settled (nothing is still loading in) when two reads a moment apart agree.
    await expect.poll(async () => { const first = await lastEntryTop(page); await page.waitForTimeout(150); return first === await lastEntryTop(page); }).toBe(true);
    const before = await lastEntryTop(page), box = (await card.boundingBox())!;
    await card.getByRole('button', { name: 'Show page' }).dispatchEvent('click');
    await expect(card.locator('table')).toBeVisible();
    expect(await lastEntryTop(page)).toBe(before);
    expect((await card.boundingBox())!.y).toBe(box.y);
    await page.evaluate(() => (window as unknown as { rewritePage(): void }).rewritePage());
    await expect(card.locator('tbody tr')).toHaveCount(3);
    expect(await lastEntryTop(page)).toBe(before);
    expect(await inView()).toBe(true);
    await card.getByRole('button', { name: 'Hide page' }).dispatchEvent('click');
    expect(await lastEntryTop(page)).toBe(before);
    await page.screenshot({ path: testInfo.outputPath('pinned.png') });
  });
}
