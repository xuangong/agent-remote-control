import { expect, test } from '@playwright/test';
import { fixture, reply } from '../../agent-provider-copilot/tests/native-fixture.js';
import { createDebuggerServer } from '../dist/server.js';

test('two mobile pages share a Copilot session through reload and page close', async ({ browser }, info) => {
  test.setTimeout(45_000);
  let finishTurn: (() => void) | undefined;
  const f = await fixture((body, response, index) => {
    if (index === 1) finishTurn = () => { if (!response.writableEnded && !response.destroyed) reply(response, body, 'SHARED_TASK_FINISHED'); };
    else reply(response, body, 'SHARED_MESSAGE_FINISHED');
  });
  const server = await createDebuggerServer({ adapter: f.provider, config: { cwd: f.cwd, model: 'gpt-4.1' } });
  const firstContext = await browser.newContext({ viewport: { width: 402, height: 874 } });
  const secondContext = await browser.newContext({ viewport: { width: 402, height: 874 } });
  try {
    const a = await firstContext.newPage();
    const b = await secondContext.newPage();
    const errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    await a.goto(server.url);
    const aInput = a.getByRole('textbox', { name: 'Message', exact: true });
    await expect(aInput).toBeEditable();
    await aInput.fill('Keep running while another page opens.');
    await a.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => Boolean(finishTurn)).toBe(true);
    await aInput.fill('Preserve this unsent draft');
    await b.goto(server.url);
    const bInput = b.getByRole('textbox', { name: 'Message', exact: true });
    await expect(bInput).toBeEditable();
    await expect(aInput).toBeEditable();
    await bInput.fill('Draft only in the second page');
    await expect(aInput).toContainText('Preserve this unsent draft');
    for (const page of [a, b]) {
      await expect(page.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
      await expect(page.locator('.lab-session-control')).toHaveCount(0);
      await expect(page.getByTestId('session-permissions-button')).toBeVisible();
    }
    finishTurn!();
    for (const page of [a, b]) await expect(page.getByText('SHARED_TASK_FINISHED', { exact: true })).toBeVisible();
    await bInput.fill('Send from the second page.');
    await b.getByRole('button', { name: 'Send message', exact: true }).click();
    for (const page of [a, b]) await expect(page.getByText('SHARED_MESSAGE_FINISHED', { exact: true })).toBeVisible();
    await expect(aInput).toContainText('Preserve this unsent draft');
    await b.reload();
    await expect(bInput).toBeEditable();
    await expect(aInput).toBeEditable();
    await expect(b.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
    await expect(b.getByText('SHARED_TASK_FINISHED', { exact: true })).toBeVisible();
    await b.close();
    await expect(aInput).toBeEditable();
    await aInput.fill('Send after the other page closes.');
    await a.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(a.getByText('SHARED_MESSAGE_FINISHED', { exact: true })).toHaveCount(2);
    expect(f.requests).toHaveLength(3);
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bottom = await a.getByRole('region', { name: 'Live provider controls' }).boundingBox();
    expect(bottom!.y + bottom!.height).toBeLessThanOrEqual(874);
    await a.screenshot({ path: info.outputPath('shared-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { finishTurn?.(); await firstContext.close().catch(()=>undefined); await secondContext.close().catch(()=>undefined); await server.close(); await f.close(); }
});
