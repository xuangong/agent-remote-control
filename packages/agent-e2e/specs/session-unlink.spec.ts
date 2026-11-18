import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

/** A Side opens as an attached Window pane; unlinking keeps the same view (`data-view-id`) as an independent dock. */
const pane = (page: Page, viewId: string) => page.locator(`section.lab-session-family-pane[data-view-id='${viewId}']`);

async function createSide(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(page).toHaveURL(/[?&]session=/);
  const sourceUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/side Keep this conversation');
  await primary.getByTestId('prompt-input').press('Enter');
  const attached = page.locator('.lab-side-conversation').filter({ has: page.locator('.agent-message-user').filter({ hasText: 'Keep this conversation' }) });
  await expect(attached.locator('.agent-message-assistant').last()).toContainText('Keep this conversation');
  const takeover = attached.getByRole('button', { name: 'Take control', exact: true });
  if (await takeover.isVisible()) await takeover.click();
  // The page address follows the selected view, which becomes the new Side.
  await expect(page).not.toHaveURL(sourceUrl);
  const viewId = (await attached.getAttribute('data-view-id'))!;
  return { primary, side: pane(page, viewId), attached, viewId, sourceUrl, sideUrl: page.url() };
}

/** An independent dock is a region named "Docked <title>"; an unlinked Side, with its own attached Sides, moves into one. */
const docked = (page: Page, title: string) => page.getByRole('region', { name: `Docked ${title}`, exact: true });

test('unlink persists after reload, allows Undo, and preserves the independent session', async ({ page }, info) => {
  const { side, sourceUrl } = await createSide(page);
  await page.goto(sourceUrl);
  const primary = page.locator('.lab-primary-conversation');
  const entries = primary.getByRole('navigation', { name: 'Forked sessions' });
  await expect(entries).toContainText('Sides · 1');
  await entries.getByRole('button', { name: /Actions for Side/ }).click();
  await page.screenshot({ path: `../../.tmp/evidence/unlink-menu-${info.project.name}.png`, animations: 'disabled' });
  await page.getByRole('menuitem', { name: 'Unlink side session' }).click();
  await expect(entries).toHaveCount(0);
  await expect(page).toHaveURL(sourceUrl);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(entries).toContainText('Sides · 1');
  await entries.getByRole('button', { name: /Actions for Side/ }).click();
  await page.getByRole('menuitem', { name: 'Unlink side session' }).click();
  await expect(entries).toHaveCount(0);
  await page.reload();
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(entries).toHaveCount(0);
  // The former Side stays in the Window as an independent dock that no longer references its source.
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep this conversation');
  await expect(side).not.toHaveClass(/lab-side-conversation/);
  await expect(docked(page, 'Fork of New session').locator(`[data-view-id='${await side.getAttribute('data-view-id')}']`).first()).toBeVisible();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(side.getByTestId('timeline')).not.toContainText('<source-session-reference>');
});

test('unlinking from the side preserves its mounted view, draft and ongoing conversation', async ({ page }, info) => {
  const { primary, side, sourceUrl } = await createSide(page);
  const input = side.getByTestId('prompt-input');
  const takeover = side.getByRole('button', { name: 'Take control', exact: true });
  if (await takeover.isVisible()) await takeover.click();
  await input.fill('Keep this unsent draft');
  const element = await input.elementHandle();
  const attachments: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/attach')) attachments.push(request.url()); });
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Unlink side session', exact: true }).click();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  // The same view becomes an independent dock beside its former source.
  await expect(side).toBeVisible();
  await expect(side).not.toHaveClass(/lab-side-conversation/);
  await expect(docked(page, 'Fork of New session').locator(`[data-view-id='${await side.getAttribute('data-view-id')}']`).first()).toBeVisible();
  await expect(primary).toBeVisible();
  await expect(input).toHaveText('Keep this unsent draft');
  expect(await element!.evaluate(node => node.isConnected)).toBe(true);
  // The address follows the main view's family; an independent dock does not take it over.
  await expect(page).toHaveURL(sourceUrl);
  if (info.project.name === 'chromium-mobile') await expect(page.locator('.lab-mobile-session-title')).toHaveText('Keep this conversation');
  expect(attachments).toEqual([]);
  // It is no longer a child of the source family, so it has no child close control.
  await expect(side.getByRole('button', { name: 'Close subagent', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `../../.tmp/evidence/unlink-independent-${info.project.name}.png`, animations: 'disabled' });
  await input.press('Enter');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep this unsent draft');
  await expect(side.getByTestId('timeline')).not.toContainText('<source-session-reference>');
});

test('unlinking a side retains its nested side and keeps the source independent', async ({ page }) => {
  const { primary, side, sourceUrl } = await createSide(page);
  await side.getByTestId('prompt-input').fill('/side Nested conversation');
  await side.getByTestId('prompt-input').press('Enter');
  const attachedNested = page.locator('.lab-side-conversation').filter({ has: page.locator('.agent-message-user').filter({ hasText: 'Nested conversation' }) });
  await expect(attachedNested.locator('.agent-message-assistant').last()).toContainText('Nested conversation');
  const nested = pane(page, (await attachedNested.getAttribute('data-view-id'))!);
  await nested.locator('.lab-fork-reference summary').click();
  await nested.getByRole('button', { name: 'Open source session', exact: true }).click();
  await expect(side).toHaveAttribute('data-selected', 'true');
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Unlink side session', exact: true }).click();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(side.getByRole('navigation', { name: 'Forked sessions' })).toContainText('Nested conversation');
  // The unlinked view keeps its own Side attached to it, and leaves the source's family.
  await expect(side).not.toHaveClass(/lab-side-conversation/);
  await expect(nested).toBeVisible();
  await expect(docked(page, 'Fork of New session').locator(`[data-view-id='${await nested.getAttribute('data-view-id')}']`)).toBeVisible();
  await expect(primary.getByRole('navigation', { name: 'Forked sessions' })).toHaveCount(0);
  await side.getByRole('button', { name: 'Side 1 · Nested conversation', exact: true }).click();
  await expect(nested).toHaveAttribute('data-selected', 'true');
  await page.goto(sourceUrl);
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(primary.getByRole('navigation', { name: 'Forked sessions' })).toHaveCount(0);
});

test('creating another session after unlinking leaves the independent side', async ({ page }) => {
  const { side } = await createSide(page);
  await side.locator('.lab-fork-reference summary').click();
  await side.getByRole('button', { name: 'Unlink side session', exact: true }).click();
  await expect(side.locator('.lab-fork-reference')).toHaveCount(0);
  // A new session binds the selected view, which is still the unlinked one; select the main view so it replaces that instead.
  await page.locator('.lab-primary-conversation').getByTestId('prompt-input').click();
  await expect(page.locator('.lab-primary-conversation')).toHaveAttribute('data-selected', 'true');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeVisible();
  await primary.getByTestId('prompt-input').fill('A new independent topic');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(primary.locator('.agent-message-assistant').last()).toContainText('A new independent topic');
  // The independent dock is not replaced by the new session.
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep this conversation');
  await expect(side.locator('.agent-message-user').filter({ hasText: 'A new independent topic' })).toHaveCount(0);
});
