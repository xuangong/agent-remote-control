import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createDebuggerServer } from '../src/server.js';
import { createBrowserPrefixAdapter } from './fixtures/browser-prefix-adapter.mjs';

async function fixture(ephemeral = false, enrollmentDeferred = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ardb-live-input-'));
  const native = createBrowserPrefixAdapter(directory);
  const adapter = ephemeral || enrollmentDeferred ? { ...native, async createSession(config: Parameters<typeof native.createSession>[0]) {
    const session = await native.createSession(config);
    const runtimeInfo = session.runtimeInfo!.bind(session);
    session.runtimeInfo = async () => {
      const { persistence, cwd, ...info } = await runtimeInfo();
      return { ...info, ...(!ephemeral ? { persistence } : {}), ...(!enrollmentDeferred ? { cwd } : {}) };
    };
    return session;
  } } : native;
  try {
    const start = (port = 0) => createDebuggerServer({ adapter, port, config: { sessionId: 'A', cwd: directory },
      successionStateDirectory: join(directory, 'state'), resourceDirectory: join(directory, 'resources'),
      assetsDirectory: fileURLToPath(new URL('../dist/web', import.meta.url)) });
    let server = await start();
    return { native, get server() { return server; }, async enableEnrollmentAfterRestart() {
      const port = Number(new URL(server.url).port);
      await server.close(); enrollmentDeferred = false; server = await start(port);
    }, async close() { native.settleInput(false); await server.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

test('ephemeral Live sessions send and retain drafts independently of prompt-edit enrollment', async ({ page }) => {
  const live = await fixture(true);
  const admissions: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => admissions.push(String(frame.payload))));
  try {
    await page.goto(live.server.url);
    const editor = page.getByTestId('prompt-input');
    await expect(page.getByText('Durable local session identity is unavailable.')).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('[data-prompt-edit-action]')).toHaveCount(0);
    await editor.fill('echo before ACK'); await editor.press('Enter');
    await expect.poll(() => live.native.pendingInput()).toBe('echo before ACK');
    await expect(editor).toHaveText('echo before ACK');
    live.native.settleInput(true);
    await expect(editor).toHaveText('');
    await expect.poll(async () => (await live.native.state()).sessions.A.inputs).toEqual(['echo before ACK']);
    await page.reload(); await expect(editor).toHaveText('');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('rejected draft'); await editor.press('Enter');
    await expect.poll(() => live.native.pendingInput()).toBe('rejected draft');
    live.native.settleInput(false);
    await expect.poll(() => admissions.join('\n')).toContain('fixture_rejected');
    await expect(editor).toHaveText('rejected draft');
    await page.reload(); await expect(editor).toHaveText('rejected draft');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await page.getByRole('button', { name: 'Show debug controls' }).click();
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(editor).toHaveText('rejected draft');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
  } finally { await live.close(); }
});

test('retrying a failed prompt-edit description preserves the existing Live draft', async ({ page }) => {
  const live = await fixture();
  let attempts = 0;
  await page.route('**/__ardb/succession/describe', route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: 'The local prompt service is temporarily unavailable.' } }) : route.continue());
  try {
    await page.goto(live.server.url);
    const editor = page.getByTestId('prompt-input');
    const retry = page.getByRole('button', { name: 'Retry prompt editing' });
    await expect(retry).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('[data-prompt-edit-action]')).toHaveCount(0);
    await editor.fill('draft retained while prompt editing recovers');
    await retry.click();
    await expect(page.locator('[data-prompt-editable]').filter({ hasText: 'selected prompt' }).locator('[data-prompt-edit-action]:visible')).toHaveCount(1);
    await expect(retry).toHaveCount(0);
    await expect(editor).toHaveText('draft retained while prompt editing recovers');
    await page.reload();
    await expect(editor).toHaveText('draft retained while prompt editing recovers');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    expect(attempts).toBe(3);
  } finally { await live.close(); }
});

test('durable drafts keep their owner when enrollment becomes available after a local restart', async ({ page }) => {
  const live = await fixture(false, true);
  try {
    await page.goto(live.server.url);
    const editor = page.getByTestId('prompt-input');
    await expect(page.getByText('Local session workspace is unavailable.')).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('durable draft before enrollment');
    await page.reload(); await expect(editor).toHaveText('durable draft before enrollment');
    await live.enableEnrollmentAfterRestart();
    await page.reload();
    await expect(page.locator('[data-prompt-editable]').filter({ hasText: 'selected prompt' }).locator('[data-prompt-edit-action]:visible')).toHaveCount(1);
    await expect(editor).toHaveText('durable draft before enrollment');
    await editor.press('Enter');
    await expect.poll(async () => (await live.native.state()).sessions.A.inputs).toEqual(['durable draft before enrollment']);
    await expect(editor).toHaveText('');
  } finally { await live.close(); }
});

test('a retained unknown replacement stays fenced when prompt-edit description fails after reload', async ({ page }) => {
  const live = await fixture();
  const admissions: string[] = [];
  page.on('websocket', socket => socket.on('framereceived', frame => admissions.push(String(frame.payload))));
  async function attemptFencedSend() {
    admissions.length = 0;
    await expect(page.getByTestId('prompt-input')).toHaveAttribute('contenteditable', 'true');
    await page.getByTestId('prompt-input').press('Enter');
    await expect.poll(() => admissions.join('\n')).toContain('reserved for handoff');
    await expect(page.getByTestId('prompt-input')).toHaveText('draft during uncertain replacement');
    expect((await live.native.state()).sessions.A.inputs).toEqual([]);
  }
  try {
    const description = page.waitForResponse(response => response.url().endsWith('/__ardb/succession/describe'));
    await page.goto(live.server.url);
    const { role } = await (await description).json();
    expect(live.server.session.draftOwnerId).toBe(role.id);
    const row = page.locator('[data-prompt-editable]').filter({ hasText: 'selected prompt' });
    await expect(row.locator('[data-prompt-edit-action]:visible')).toHaveCount(1);
    await live.native.unknown();
    await row.hover(); await row.locator('[data-prompt-edit-action]:visible').click();
    await expect(page.getByRole('region', { name: 'Handoff', exact: true })).toBeVisible();
    await expect.poll(async () => (await live.native.state()).forks).toBe(1);
    await page.getByTestId('prompt-input').fill('draft during uncertain replacement');
    await attemptFencedSend();
    await page.route('**/__ardb/succession/describe', route => route.fulfill({ status: 503, json: { error: 'Description retry required.' } }));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Retry prompt editing' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Handoff', exact: true })).toBeVisible();
    await expect(page.getByTestId('prompt-input')).toHaveText('draft during uncertain replacement');
    await attemptFencedSend();
    await page.unroute('**/__ardb/succession/describe');
    await page.getByRole('button', { name: 'Retry prompt editing' }).click();
    await expect(page.getByRole('button', { name: 'Retry prompt editing' })).toHaveCount(0);
    await attemptFencedSend();
    expect((await live.native.state()).forks).toBe(1);
    expect((await live.native.state()).sessions.A.inputs).toEqual([]);
  } finally { await live.close(); }
});
