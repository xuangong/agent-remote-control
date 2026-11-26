// Component projects: orchard-phone-webkit
import { expect, test, type Locator } from '@playwright/test';

// A phone shows a Session View's actions behind one control; the logic of that control is `SessionTimelineTools.test.tsx`.
// This spec holds what only a real touch browser at phone size shows: the layout stays put, and a tap leaves no sticky look.
const fixture = '/e2e/fixtures/session-view-responsive.html?toolbar&idle&width=360';

test.beforeEach(({ isMobile }) => { test.skip(!isMobile, 'A phone shows the actions behind one control.'); });

async function appearance(button: Locator) {
  return button.evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow, outline: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
}

async function open(page: import('@playwright/test').Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(fixture);
  const view = page.locator('.lab-primary-conversation');
  const tools = view.getByRole('toolbar', { name: 'Session actions', exact: true });
  return { view, tools, timeline: view.getByTestId('timeline'),
    expand: tools.getByRole('button', { name: 'Expand session actions', exact: true }), collapse: tools.getByRole('button', { name: 'Collapse session actions', exact: true }),
    manage: tools.getByRole('button', { name: 'Manage', exact: true, includeHidden: true }), search: tools.getByRole('button', { name: 'Search this session', exact: true, includeHidden: true }) };
}

test('the actions start behind one control, out of reach, and expanding or collapsing them leaves the conversation where it is', async ({ page }) => {
  const { view, timeline, expand, collapse, manage, search } = await open(page);
  await expect(expand).toBeVisible();
  await expect(collapse).toBeHidden();
  for (const control of [manage, search]) await expect(control).toBeHidden();
  const place = (control: Locator) => control.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
  const hidden = await place(manage);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.lab-timeline-tools-content') !== null, hidden), 'a collapsed action is not under the finger').toBe(false);
  // The page may scroll to reach a control, so the conversation is read inside its view.
  const where = async () => { const inner = (await timeline.boundingBox())!, outer = (await view.boundingBox())!; return { x: inner.x - outer.x, y: inner.y - outer.y, width: inner.width, height: inner.height }; };
  const conversation = await where();
  const owner = (await view.boundingBox())!, toggle = (await expand.boundingBox())!;
  expect(owner.x + owner.width - toggle.x - toggle.width, 'the control stays against the right edge of its view').toBeLessThanOrEqual(12);
  await expand.tap();
  await expect(collapse).toBeVisible();
  for (const control of [manage, search]) await expect(control).toBeVisible();
  expect(await where()).toEqual(conversation);
  expect(await page.evaluate(() => ({ left: scrollX, overflow: document.documentElement.scrollWidth - innerWidth }))).toMatchObject({ left: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await collapse.tap();
  await expect(expand).toBeVisible();
  for (const control of [manage, search]) await expect(control).toBeHidden();
  expect(await where()).toEqual(conversation);
});

test('a tap on an action, on the control or on the search leaves each as it looked before, without a focus ring', async ({ page }) => {
  const { view, tools, expand, collapse, manage, search } = await open(page);
  const settled = () => expect.poll(() => tools.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
  const idleExpand = await appearance(expand);
  await expand.tap();
  await settled();
  const idleManage = await appearance(manage), idleSearch = await appearance(search);
  await manage.tap();
  await expect.poll(() => appearance(manage)).toEqual(idleManage);
  await search.tap();
  await expect(view.getByRole('searchbox')).toBeVisible();
  await view.getByRole('button', { name: 'Close session search', exact: true }).tap();
  await expect(view.getByRole('searchbox')).toBeHidden();
  await expect.poll(() => appearance(search)).toEqual(idleSearch);
  await settled();
  await collapse.tap();
  await expect(expand).toBeVisible();
  await expect.poll(() => appearance(expand)).toEqual(idleExpand);
  expect(await expand.evaluate(element => element.matches(':focus-visible'))).toBe(false);
  await settled();
});
