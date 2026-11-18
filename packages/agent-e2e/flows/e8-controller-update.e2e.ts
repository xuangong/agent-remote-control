// E8 of the target architecture: the owner updates a Controller from the page. The Relay discovers a release without GitHub, the
// Controller's updater installs it without a download and asks the launcher to restart; the test plays the launcher and the page then
// shows the Host on the new version.
import type { Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { launchBrowser, openPage } from './browser.js';
import { openSettings, showsText } from './page.js';

const release = {
  protocolVersion: PROTOCOL_VERSION, version: '0.2.0', revision: 'b'.repeat(40), sha256: 'c'.repeat(64),
  asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: Number(process.versions.node.split('.')[0]),
  platforms: [`${process.platform}-${process.arch}`],
};
let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ controllerUpdate: { runningVersion: '0.1.0', release: release as never }, sessions: { work: { title: 'Work', history: [{ role: 'user', text: 'Start' }] } } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

it('E8: the page offers the newer release, installs it on the Host, and shows the Host updated after the Controller restarts', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('work'));
  await showsText(page, 'Start');
  await openSettings(page);
  await page.getByRole('button', { name: /Controller updates/ }).click();
  await showsText(page, 'Latest version: 0.2.0');
  expect(await page.getByRole('region', { name: 'Host name' }).first().innerText()).toContain('E2E Host');
  await page.getByRole('button', { name: 'Update Host', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm Controller update' }).innerText()).resolves.toContain('Update 1 online Host');
  await page.getByRole('button', { name: 'Confirm update', exact: true }).click();
  await expect.poll(() => stack.updates.restarts, { timeout: 25_000 }).toEqual(['0.2.0']);
  expect(stack.updates.installed).toEqual(['0.2.0']);
  await stack.finishUpdate();
  await page.getByRole('region', { name: 'Controller updates' }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await showsText(page, 'Updated');
  await expect(page.getByRole('button', { name: 'Update Host', exact: true }).count()).resolves.toBe(0);
  await context.close();
});
