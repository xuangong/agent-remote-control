import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDebuggerRuntime } from '../packages/agent-remote-debugger/dist/runtime.js';
import { parseRecording } from '../packages/agent-remote-debugger/dist/recording.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/opencode-debug-browser.mjs --url URL --agent-id ID [--output-directory PATH]');
  console.log('Use only the isolated session printed by opencode-debug-scenario.mjs --keep. Starts a fresh recording; its predecessor must already be exported.');
  process.exit(0);
}
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--url', '--agent-id', '--output-directory'].includes(args[i]) && args[i + 1], `Invalid argument: ${args[i]}`);
  options.set(args[i], args[i + 1]);
}
assert.ok(options.get('--url') && options.get('--agent-id'), '--url and --agent-id are required');
const url = new URL(options.get('--url'));
assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use the isolated loopback debugger URL.');
const agentId = options.get('--agent-id');
const output = resolve(options.get('--output-directory') ?? '.tmp/opencode-debug', `browser-${randomUUID()}`);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const require = createRequire(new URL('../packages/agent-remote-lab/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const execute = promisify(execFile);
const browser = await chromium.launch({ headless: true });
const deadline = setTimeout(() => { void browser.close(); }, 90000);
const observer = await createDebuggerRuntime(agentId, { relayUrl: url.origin, origin: url.origin, operationTimeoutMs: 15000 });
const evidence = { url: url.origin, agentId, checks: {}, output };
async function until(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (check()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await observer.ready(15000);
  assert.equal(observer.replica.getState().agent?.runtimeInfo.providerId, 'opencode');
  assert.ok(JSON.stringify(observer.replica.getState().timeline).includes('ARC_SCENARIO_COMPLETE: shell'), 'This is not the expected isolated scenario.');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('dialog', dialog => dialog.message().startsWith('Start a new recording?') ? dialog.accept() : dialog.dismiss());
  await page.goto(url.origin); await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Context compaction', exact: true })).toHaveCount(1);
  await expect(page.getByText('In progress', { exact: true })).toHaveCount(0);
  evidence.checks.compactionSettled = true;
  await page.getByRole('button', { name: 'Show debug controls', exact: true }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('ARC_DEBUG_QUESTION');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => observer.replica.getState().pendingInteractions.some(request => request.kind === 'question'), 'independent observer sees browser question');
  await page.getByRole('button', { name: 'Submit response', exact: true }).waitFor();
  await page.getByText('Record success', { exact: true }).last().click();
  await page.getByRole('button', { name: 'Submit response', exact: true }).click();
  await until(() => JSON.stringify(observer.replica.getState().timeline).includes('ARC_QUESTION_COMPLETE:'), 'native answer reaches independent observer');
  await expect(page.getByText('ARC_QUESTION_COMPLETE: the browser answer reached native OpenCode.', { exact: true })).toBeVisible();
  await until(() => observer.replica.getState().agent?.runtimeInfo.status === 'idle', 'native idle');
  evidence.checks.browserToNativeToObserver = true;
  const marker = `ARC_CLI_TO_VIEW_${randomUUID()}`;
  const cli = fileURLToPath(new URL('../packages/agent-remote-debugger/dist/cli.js', import.meta.url));
  const command = await execute(process.execPath, [cli, 'send', agentId, marker, '--relay', url.origin, '--origin', url.origin, '--json'], { timeout: 25000 });
  evidence.cli = command.stdout;
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
  await until(() => observer.replica.getState().agent?.runtimeInfo.status === 'idle' && JSON.stringify(observer.replica.getState().timeline).includes('ARC_NATIVE_REPLY:'), 'CLI reply');
  evidence.checks.cliToBrowser = true;
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export JSONL', exact: true }).click();
  const recordingPath = resolve(output, 'session.jsonl');
  await (await download).saveAs(recordingPath);
  const recording = parseRecording(await readFile(recordingPath, 'utf8'));
  assert.equal(recording.agentId, agentId);
  assert.ok(recording.events.some(event => event.record.kind === 'interaction_requested'));
  evidence.recording = { path: recordingPath, events: recording.events.length, duration: recording.duration, warnings: recording.warnings };
  evidence.checks.browserExport = true;
  await page.screenshot({ path: resolve(output, 'live.png'), fullPage: true });
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await page.getByRole('button', { name: 'Open recording', exact: true }).click();
  await page.getByLabel('Server path', { exact: true }).fill(recordingPath);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const position = page.getByLabel('Playback position', { exact: true });
  await position.waitFor(); await position.focus(); await position.press('End');
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
  await expect(page.getByText('ARC_QUESTION_COMPLETE: the browser answer reached native OpenCode.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Context compaction', exact: true })).toHaveCount(1);
  await expect(page.getByText('In progress', { exact: true })).toHaveCount(0);
  evidence.checks.serverFileReplay = true;
  await page.screenshot({ path: resolve(output, 'replay.png'), fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  await page.screenshot({ path: resolve(output, 'replay-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Mobile view must not overflow horizontally.');
  evidence.checks.mobileWidth = true;
  assert.deepEqual(browserErrors, []);
  evidence.checks.noBrowserErrors = true;
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  await writeFile(resolve(output, 'failure.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  throw error;
} finally {
  clearTimeout(deadline); observer.close(); await browser.close();
}
