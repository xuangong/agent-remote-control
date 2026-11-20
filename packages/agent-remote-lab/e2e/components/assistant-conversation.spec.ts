import { expect, test, type Page } from '@playwright/test';
import { contrastFailures } from './contrast.js';

// The assistant's conversation in both themes, both locales and the three process modes, at desktop and phone width: contrast,
// touch targets under a coarse pointer, no sideways scrolling at 390 px, and screenshots of each mode for review.

async function open(page: Page, query: string) {
  await page.goto(`/e2e/fixtures/assistant-conversation.html?${query}`);
  await page.locator('.agent-turn').first().waitFor();
  // The earlier session settles before anything is measured.
  await page.locator('.lab-earlier-session .orchard-bubble').first().waitFor();
}

/** Opens every closed work line, every approval card's changes and every receipt, so every word of the page is shown. */
async function openEverything(page: Page) {
  for (const selector of ['.agent-work-line > button[aria-expanded="false"]', 'details.agent-approval-changes:not([open]) > summary', '.agent-receipt-toggle[aria-expanded="false"]']) {
    await page.locator(selector).evaluateAll(nodes => { for (const node of nodes) (node as HTMLElement).click(); });
  }
  await page.locator('.agent-work-line > button[aria-expanded="true"]').first().waitFor();
}

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    test.describe(`${theme} theme, ${locale}`, () => {
      test.use({ colorScheme: theme, locale });

      test('every text passes WCAG AA with every step, card and receipt open', async ({ page }) => {
        await open(page, `mode=concise&theme=${theme}`);
        expect(await contrastFailures(page)).toEqual([]);
        await openEverything(page);
        expect(await contrastFailures(page)).toEqual([]);
        await open(page, `mode=full&theme=${theme}&pending=none`);
        expect(await contrastFailures(page)).toEqual([]);
      });

      test('the three process modes, for review', async ({ page }, testInfo) => {
        for (const mode of ['concise', 'process', 'full'] as const) {
          await open(page, `mode=${mode}&theme=${theme}&pending=none`);
          await page.locator('.agent-turn-status').waitFor();
          await page.screenshot({ path: testInfo.outputPath(`${mode}.png`), fullPage: false });
          await page.locator('.lab-timeline-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
          await page.screenshot({ path: testInfo.outputPath(`${mode}-latest.png`) });
        }
      });
    });
  }
}

test('touch targets of the work line, the steps and the card choices are at least 44 px under a coarse pointer', async ({ page }) => {
  await open(page, 'mode=concise&theme=light');
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  test.skip(!coarse, 'Only a coarse pointer needs 44 px targets.');
  await openEverything(page);
  const targets = await page.locator([
    '.agent-work-line > button', '.agent-work-steps :is(.agent-tool-toggle, .agent-reasoning-toggle, .agent-notice-toggle, .agent-background-summary)',
    '.orchard-approval-choices > button', '.agent-approval-changes-toggle', '.agent-receipt-toggle',
  ].join(', ')).evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).offsetParent !== null).map(node => {
    const box = node.getBoundingClientRect();
    return { name: (node.textContent ?? '').trim().slice(0, 30), height: Math.round(box.height) };
  }));
  expect(targets.length).toBeGreaterThan(10);
  expect(targets.filter(target => target.height < 44)).toEqual([]);
});

test("a bubble's actions sit beside it, never over its words", async ({ page }) => {
  await open(page, 'mode=concise&theme=light&pending=none');
  for (const key of ['prompt-1', 'answer-1']) {
    const covered = await page.locator(`.agent-timeline-entry[data-entry-key="${key}"]`).evaluate(node => {
      const actions = node.querySelector(':scope > .agent-entry-actions')!.getBoundingClientRect();
      const bubble = node.querySelector('.orchard-bubble')!.getBoundingClientRect();
      return Math.max(0, Math.min(actions.right, bubble.right) - Math.max(actions.left, bubble.left)) > 0
        && Math.max(0, Math.min(actions.bottom, bubble.bottom) - Math.max(actions.top, bubble.top)) > 0;
    });
    expect(covered, key).toBe(false);
  }
});

test('nothing scrolls sideways at the page or in the conversation', async ({ page }) => {
  await open(page, 'mode=full&theme=light');
  await openEverything(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.lab-timeline-scroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
