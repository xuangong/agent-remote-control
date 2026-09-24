import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
let installed = '';
let cli = '';
const fixture = fileURLToPath(new URL('../src/fixtures/stdio-adapter.mjs', import.meta.url));
const run = promisify(execFile);
let child: ChildProcessWithoutNullStreams;
let exited: Promise<unknown>;
let url: string;
let agentId: string;
let output = '';
let errors = '';

test.beforeEach(async () => {
  output = ''; errors = '';
  installed = await mkdtemp(join(tmpdir(), 'ardb-installed-'));
  await cp(join(packageDirectory, 'dist'), join(installed, 'dist'), { recursive: true });
  await cp(join(packageDirectory, 'package.json'), join(installed, 'package.json'));
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies)) {
    const destination = join(installed, 'node_modules', dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(packageDirectory, 'node_modules', dependency), destination, 'junction');
  }
  cli = join(installed, 'dist/cli.js');
  child = spawn(process.execPath, [cli, 'server', '--adapter', fixture, '--jsonl'], { stdio: 'pipe', cwd: installed });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  await expect.poll(() => output, { timeout: 15000, message: 'Built ARDB server starts' }).toContain('server_ready');
  const ready = JSON.parse(output.split('\n').find(line => line.includes('server_ready'))!);
  url = ready.url; agentId = ready.agentId;
});
test.afterEach(async () => {
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { expect(await exited, errors).toEqual({ code: 0, signal: null }); } finally { clearTimeout(timeout); await rm(installed, { recursive: true, force: true }); }
});
async function command(...args: string[]) {
  const result = await run(process.execPath, [cli, ...args, '--relay', url, '--origin', url, '--json', '--timeout', '5000'], { timeout: 10000 });
  return JSON.parse(result.stdout);
}

test('CLI events broadcast into the product view; page controls reach stdio; refresh and reconnect converge', async ({ page, context }, info) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(url);
  const editor = page.getByTestId('prompt-input');
  await expect(editor).toBeVisible();
  await command('send', agentId, 'CLI broadcast');
  await expect(page.getByText('STDIO reply: CLI broadcast', { exact: true })).toBeVisible();
  await editor.fill('browser broadcast');
  await editor.press('Enter');
  await expect(page.getByText('STDIO reply: browser broadcast', { exact: true })).toBeVisible();
  expect(JSON.stringify(await command('inspect', agentId))).toContain('STDIO reply: browser broadcast');
  await command('send', agentId, 'approve');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByText('Approval received', { exact: true })).toBeVisible();
  await command('send', agentId, 'hold');
  await command('cancel', agentId);
  await expect.poll(() => output.includes('"messageType":"interaction_response"')).toBe(true);
  const settings = await command('settings', 'list', agentId);
  expect(settings[0].value).toBe('medium');
  await command('settings', 'set', agentId, 'reasoning', 'high');
  expect((await command('settings', 'list', agentId))[0].value).toBe('high');
  await expect(command('settings', 'set', agentId, 'reasoning', 'invalid')).rejects.toThrow();
  expect((await command('settings', 'list', agentId))[0].value).toBe('high');
  await page.reload();
  await expect(page.getByText('STDIO reply: browser broadcast', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await command('send', agentId, 'while browser offline');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('STDIO reply: while browser offline', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('STDIO reply: CLI broadcast', { exact: true })).toHaveCount(1);

  await expect.poll(() => output.includes('"source":"relay"')).toBe(true);
  expect(failures).toEqual([]);
  await page.screenshot({ path: info.outputPath('session-view.png'), fullPage: true });
});

test('SIGINT closes the owned stdio session cleanly', async () => {
  await command('send', agentId, 'hold');
  child.kill('SIGINT');
  await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
});


test('packaged built-in adapters load without private workspace dependencies', async () => {
  const script = `
    const { ClaudeAgentProvider } = await import('./dist/providers/claude.js');
    const { CopilotAgentProvider } = await import('./dist/providers/copilot.js');
    const claude = new ClaudeAgentProvider();
    const copilot = new CopilotAgentProvider();
    console.log(JSON.stringify([claude.descriptor.providerId, copilot.descriptor.providerId]));
    await copilot.dispose();
  `;
  const result = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: installed, timeout: 10000 });
  expect(JSON.parse(result.stdout)).toEqual(['claude', 'copilot']);
  await run(process.execPath, ['--check', 'dist/providers/catalog-worker.js'], { cwd: installed, timeout: 5000 });
});


test('recorded CLI interaction replays in a read-only Session View with playback controls', async ({ page }, info) => {
  await command('send', agentId, 'replay broadcast');
  await page.goto(url);
  await page.getByTestId('prompt-input').fill('browser recorded');
  await page.getByTestId('prompt-input').press('Enter');
  await expect(page.getByText('STDIO reply: browser recorded', { exact: true })).toBeVisible();
  await command('send', agentId, 'approve');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(() => output).toContain('Approval received');
  child.kill('SIGTERM');
  expect(await exited).toEqual({ code: 0, signal: null });
  const recording = join(installed, 'session.jsonl');
  await writeFile(recording, output);
  output = ''; errors = '';
  child = spawn(process.execPath, [cli, 'replay', recording, '--json'], { stdio: 'pipe' });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  await expect.poll(() => output, { timeout: 10000 }).toContain('replay_ready');
  url = JSON.parse(output.trim()).url;
  const mutations: string[] = []; const failures: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
  page.on('websocket', socket => mutations.push(socket.url()));
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Play recording', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open recording', exact: true })).toBeVisible();
  await expect(page.getByTestId('prompt-input')).toBeDisabled();
  const progress = page.getByRole('slider', { name: 'Playback position' });
  const captured = await (await page.request.get(`${url}/__ardb/recording`)).json();
  const approvalAt = captured.events.find((event: { record: { kind: string } }) => event.record.kind === 'interaction_requested').at;
  await progress.fill(String(approvalAt));
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled();
  await progress.fill(await progress.getAttribute('max') ?? '0');
  await expect(page.getByText('STDIO reply: replay broadcast', { exact: true })).toBeVisible();
  await expect(page.getByText('STDIO reply: browser recorded', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval received', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restart recording' }).click();
  await expect(page.getByText('Approval received', { exact: true })).toHaveCount(0);
  await page.getByLabel('Playback speed').selectOption('4');
  await page.getByRole('button', { name: 'Play recording', exact: true }).click();
  await expect(page.getByText('Approval received', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play recording', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Open recording', exact: true })).toBeVisible();
  const original = await readFile(recording, 'utf8');
  await page.getByLabel('Open recording file').setInputFiles({ name: 'another-session.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(original.replaceAll('replay broadcast', 'opened from disk')) });
  await expect(page.getByText('another-session.jsonl', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval received', { exact: true })).toHaveCount(0);
  await progress.fill(await progress.getAttribute('max') ?? '0');
  await expect(page.getByText('STDIO reply: opened from disk', { exact: true })).toBeVisible();
  await expect(page.getByText('STDIO reply: replay broadcast', { exact: true })).toHaveCount(0);
  await page.getByLabel('Open recording file').setInputFiles({ name: 'broken.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from('not json') });
  await expect(page.getByRole('alert')).toContainText('line 1');
  await expect(page.getByText('another-session.jsonl', { exact: true })).toBeVisible();
  await expect(page.getByText('STDIO reply: opened from disk', { exact: true })).toBeVisible();
  expect(mutations).toEqual([]); expect(failures).toEqual([]);
  await page.screenshot({ path: info.outputPath('recording-replay.png'), fullPage: true });
});
