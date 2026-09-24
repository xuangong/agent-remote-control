import {expect, test} from '@playwright/test';
import {fixture, reply} from '../../agent-provider-copilot/tests/native-fixture.js';
import {createDebuggerServer} from '../dist/server.js';

test('Copilot patch renders a normalized diff in the shared mobile Session View', async ({page}, info) => {
 test.setTimeout(45000);
 await page.setViewportSize({width: 402, height: 874});
 const f = await fixture((body, res, index) => reply(res, body, index === 1
  ? {name: 'apply_patch', arguments: {input: '*** Begin Patch\n*** Add File: result.md\n+# Visible native diff\n*** End Patch'}} : 'PATCH_COMPLETE'));
 const server = await createDebuggerServer({adapter: f.provider, config: {cwd: f.cwd, model: 'gpt-5.4'}});
 const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
 try {
  await page.goto(server.url);
  await page.getByTestId('session-permissions-button').click();
  const select = page.getByTestId('session-setting-tool_approval_mode');
  await expect(select).toBeEnabled(); await select.selectOption('allow'); await expect(select).toHaveValue('allow');
  await page.getByRole('button', {name: 'Close session controls', exact: true}).click();
  await page.getByRole('textbox', {name: 'Message', exact: true}).fill('Create result.md with the native patch tool.');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect(page.getByText('PATCH_COMPLETE', {exact: true})).toBeVisible({timeout: 15000});
  const tool = page.locator('.agent-tool').filter({hasText: 'apply_patch'});
  await expect(tool).toHaveCount(1);
  const toggle = tool.locator('.agent-tool-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const files = tool.getByRole('region', {name: /^Diff for /});
  await expect(files).toContainText('+# Visible native diff');
  await expect(tool.locator('.agent-file-change')).toHaveCount(1);
  await expect(tool.locator('.agent-file-identity').last()).toContainText('result.md');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path: info.outputPath('copilot-mobile-diff.png'), fullPage: true});
  await page.reload();
  await expect(page.getByText('PATCH_COMPLETE', {exact: true})).toBeVisible();
  await expect(tool).toHaveCount(1);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(files).toContainText('+# Visible native diff');
  expect(errors).toEqual([]);
 } finally {await server.close(); await f.close();}
});
