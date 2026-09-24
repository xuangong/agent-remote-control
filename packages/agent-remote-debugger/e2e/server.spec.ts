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

test('standalone Session View keeps product presentation and display preferences', async ({ page, browser }) => {
  const checkPresentation = async (target: typeof page) => {
    await target.goto(url);
    await expect(target.getByTestId('prompt-input')).toBeVisible();
    const styles = await target.evaluate(() => {
      const view = document.querySelector('.lab-workbench-layout')!;
      const inspect = () => {
        const toggle = getComputedStyle(view.querySelector('.lab-composer-toggle')!);
        const input = getComputedStyle(view.querySelector('textarea')!);
        const surface = getComputedStyle(view.querySelector('.agent-remote-surface')!);
        return { position: toggle.position, width: toggle.width, height: toggle.height,
          right: toggle.right, font: input.fontSize, border: input.borderColor,
          ink: surface.getPropertyValue('--agent-ink').trim() };
      };
      const standalone = inspect();
      const host = view.parentElement!;
      host.classList.add('lab-shell');
      const product = inspect();
      host.classList.remove('lab-shell');
      return { standalone, product };
    });
    expect(styles.standalone).toEqual(styles.product);
    expect(styles.standalone).toMatchObject({ position: 'absolute', width: '28px', height: '16px', right: '12px' });
  };
  await checkPresentation(page);
  await command('send', agentId, 'trace');
  await expect(page.locator('.agent-reasoning')).toContainText('Fixture reasoning detail');
  await page.getByRole('button', { name: 'Show debug controls' }).click();
  await page.getByLabel('Timeline display').selectOption('simple');
  await expect(page.locator('.agent-reasoning')).toBeVisible();
  await expect(page.getByText('Fixture reasoning detail', { exact: true })).toHaveCount(0);
  await page.getByLabel('Timeline display').selectOption('content');
  await expect(page.locator('.agent-reasoning')).toHaveCount(0);
  await expect(page.getByText('STDIO reply: trace', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Show debug controls' }).click();
  await expect(page.getByLabel('Timeline display')).toHaveValue('content');
  await expect(page.locator('.agent-reasoning')).toHaveCount(0);
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try { await checkPresentation(await mobile.newPage()); } finally { await mobile.close(); }
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
  await command('send', agentId, 'trace');
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
  await page.goto('about:blank');
  const mutations: string[] = []; const failures: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
  page.on('websocket', socket => mutations.push(socket.url()));
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(url);
  const toggle = page.getByRole('button', { name: 'Show playback controls' });
  await expect(toggle).toBeVisible();
  const toggleBounds = (await toggle.boundingBox())!;
  expect(toggleBounds.width).toBe(28); expect(toggleBounds.height).toBe(28);
  expect(toggleBounds.y).toBe(4);
  expect(toggleBounds.x + toggleBounds.width).toBe(page.viewportSize()!.width - 4);
  await expect(page.getByRole('button', { name: 'Play recording', exact: true })).toBeHidden();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Open recording', exact: true })).toBeVisible();
  await expect(page.getByTestId('prompt-input')).toBeDisabled();
  const view = page.locator('.lab-workbench-layout');
  const expandedBounds = await view.boundingBox();
  expect(expandedBounds?.y).toBe(0);
  expect(expandedBounds?.height).toBe(page.viewportSize()?.height);
  await page.getByRole('button', { name: 'Hide playback controls' }).click();
  await expect(page.getByRole('button', { name: 'Play recording', exact: true })).toBeHidden();
  expect(await view.boundingBox()).toEqual(expandedBounds);
  await page.getByRole('button', { name: 'Show playback controls' }).click();
  expect(await view.boundingBox()).toEqual(expandedBounds);
  const progress = page.getByRole('slider', { name: 'Playback position' });
  const captured = await (await page.request.get(`${url}/__ardb/recording`)).json();
  const approvalAt = captured.events.find((event: { record: { kind: string } }) => event.record.kind === 'interaction_requested').at;
  await progress.fill(String(approvalAt));
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled();
  await progress.fill(await progress.getAttribute('max') ?? '0');
  await expect(page.getByText('STDIO reply: replay broadcast', { exact: true })).toBeVisible();
  await expect(page.getByText('STDIO reply: browser recorded', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval received', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-reasoning')).toHaveCount(1);
  await page.getByLabel('Timeline display').selectOption('content');
  await expect(page.locator('.agent-reasoning')).toHaveCount(0);
  await page.getByLabel('Timeline display').selectOption('preview');
  await expect(page.locator('.agent-reasoning')).toHaveCount(1);
  await page.getByRole('button', { name: 'Restart recording' }).click();
  await expect(page.getByText('Approval received', { exact: true })).toHaveCount(0);
  await page.getByLabel('Playback speed').selectOption('4');
  await page.getByRole('button', { name: 'Play recording', exact: true }).click();
  await page.getByRole('button', { name: 'Hide playback controls' }).click();
  await expect(page.getByText('Approval received', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show playback controls' }).click();
  await expect(page.getByRole('button', { name: 'Play recording', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const mobileBounds = await view.boundingBox();
  await page.getByLabel('Timeline display').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Show playback controls' })).toBeFocused();
  expect(await view.boundingBox()).toEqual(mobileBounds);
  await page.getByRole('button', { name: 'Show playback controls' }).click();
  await expect(page.getByRole('button', { name: 'Open recording', exact: true })).toBeVisible();
  const original = await readFile(recording, 'utf8');
  await writeFile(join(installed, 'another-session.jsonl'), original.replaceAll('replay broadcast', 'opened from disk'));
  await page.getByRole('button', { name: 'Open recording', exact: true }).click();
  await page.getByRole('button', { name: 'another-session.jsonl JSONL', exact: true }).click();
  await expect(page.getByText('another-session.jsonl', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval received', { exact: true })).toHaveCount(0);
  await progress.fill(await progress.getAttribute('max') ?? '0');
  await expect(page.getByText('STDIO reply: opened from disk', { exact: true })).toBeVisible();
  await expect(page.getByText('STDIO reply: replay broadcast', { exact: true })).toHaveCount(0);
  await writeFile(join(installed, 'broken.jsonl'), 'not json');
  await page.getByRole('button', { name: 'Open recording', exact: true }).click();
  await page.getByRole('button', { name: 'broken.jsonl JSONL', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('line 1');
  await expect(page.getByText('another-session.jsonl', { exact: true })).toBeVisible();
  await expect(page.getByText('STDIO reply: opened from disk', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close recording browser' }).click();
  expect(mutations).toEqual([]); expect(failures).toEqual([]);
  await page.screenshot({ path: info.outputPath('recording-replay.png'), fullPage: true });
});


test('records browser and AI collaboration, survives reload, exports and opens server files', async ({ page }, info) => {
  const observer = spawn(process.execPath, [cli, 'observe', agentId, '--relay', url, '--origin', url, '--jsonl'], { stdio: 'pipe' });
  let observed = '';
  const observerExited = new Promise(resolve => observer.once('exit', resolve));
  observer.stdout.on('data', chunk => { observed += chunk; });
  try {
    await expect.poll(() => observed).toContain('checkpoint');
    await page.goto(url);
    await page.getByRole('button', { name: 'Show debug controls' }).click();
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByLabel('Recording active')).toBeVisible();
    await page.getByRole('button', { name: 'Hide debug controls' }).click();
    await page.getByTestId('prompt-input').fill('Human operating the shared view');
    await page.getByTestId('prompt-input').press('Enter');
    await expect.poll(() => observed).toContain('Human operating the shared view');
    await command('send', agentId, 'AI contribution');
    await expect(page.getByText('STDIO reply: AI contribution', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Recording active')).toBeVisible();
    await page.getByRole('button', { name: 'Show debug controls' }).click();
    await page.getByText('Connect an AI or CLI client', { exact: true }).click();
    await expect(page.locator('.ardb-agent-connection code')).toContainText(`ardb observe ${agentId}`);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await expect(page.getByLabel('Recording active')).toHaveCount(0);
    const downloadPending = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export JSONL' }).click();
    const download = await downloadPending;
    const recording = join(installed, 'shared-session.jsonl');
    await download.saveAs(recording);
    const data = await readFile(recording, 'utf8');
    expect(data).toContain('Human operating the shared view');
    expect(data).toContain('STDIO reply: AI contribution');
    expect(data).toContain('recording_end');
    await page.getByRole('button', { name: 'Open recording', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Open server recording' })).toBeVisible();
    await page.getByRole('button', { name: 'shared-session.jsonl JSONL', exact: true }).click();
    await expect(page.getByTestId('prompt-input')).toBeDisabled();
    const position = page.getByRole('slider', { name: 'Playback position' });
    await position.fill(await position.getAttribute('max') ?? '0');
    await expect(page.getByText('STDIO reply: AI contribution', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByLabel('Recording active')).toBeVisible();
    await page.getByRole('button', { name: 'Open recording', exact: true }).click();
    await page.getByRole('button', { name: 'shared-session.jsonl JSONL', exact: true }).click();
    await expect(page.getByLabel('Recording active')).toBeVisible();
    await command('send', agentId, 'AI while human reviews a recording');
    await expect.poll(() => observed).toContain('AI while human reviews a recording');
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await expect(page.getByText('STDIO reply: AI while human reviews a recording', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('live-recording.png') });
  } finally {
    observer.kill('SIGINT');
    const deadline = setTimeout(() => observer.kill('SIGKILL'), 5000);
    try { await observerExited; } finally { clearTimeout(deadline); }
  }
});

test('replay entry point starts live from the floating controls and switches without replacing the session', async ({ page }) => {
  await command('send', agentId, 'original recording');
  await expect.poll(() => output).toContain('STDIO reply: original recording');
  child.kill('SIGTERM'); expect(await exited).toEqual({ code: 0, signal: null });
  const file = join(installed, 'session.jsonl');
  await writeFile(file, output);
  output = ''; errors = '';
  const script = `
    import { createReplayServer } from './dist/replay-server.js';
    import { readRecordingFile } from './dist/recording-files.js';
    const { createAdapter } = await import(${JSON.stringify(fixture)});
    const server = await createReplayServer({ recording: await readRecordingFile(${JSON.stringify(file)}), name: 'session.jsonl', loadProvider: createAdapter });
    console.log(JSON.stringify({ kind: 'server_ready', url: server.url }));
    process.once('SIGTERM', async () => { await server.close(); process.exit(0); });
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe', cwd: installed });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  await expect.poll(() => output).toContain('server_ready');
  url = JSON.parse(output.trim()).url;
  await page.goto(url);
  await expect(page.getByTestId('prompt-input')).toBeDisabled();
  await page.getByRole('button', { name: 'Show playback controls' }).click();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByLabel('Working directory', { exact: true }).fill(installed);
  await page.getByRole('button', { name: 'Start live session', exact: true }).click();
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
  const bootstrap = await (await page.request.get(`${url}/__ardb/session`)).json();
  agentId = bootstrap.live.agentId;
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByLabel('Recording active')).toBeVisible();
  await page.getByRole('button', { name: 'Hide debug controls' }).click();
  await page.getByTestId('prompt-input').fill('live from the same page');
  await page.getByTestId('prompt-input').press('Enter');
  await expect(page.getByText('STDIO reply: live from the same page', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show debug controls' }).click();
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.getByTestId('prompt-input')).toBeDisabled();
  await expect(page.getByLabel('Recording active')).toBeVisible();
  const position = page.getByRole('slider', { name: 'Playback position' });
  await position.fill(await position.getAttribute('max') ?? '0');
  await expect(page.getByText('STDIO reply: original recording', { exact: true })).toBeVisible();
  await command('send', agentId, 'background live message');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByText('STDIO reply: background live message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.getByText('STDIO reply: original recording', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Show playback controls' }).click();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByText('STDIO reply: background live message', { exact: true })).toBeVisible();
  expect((await (await page.request.get(`${url}/__ardb/session`)).json()).live.agentId).toBe(agentId);
  await page.getByRole('button', { name: 'Clear view', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveCount(0);
  await expect(page.getByText('STDIO reply: original recording', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByText('STDIO reply: background live message', { exact: true })).toBeVisible();
  expect((await (await page.request.get(`${url}/__ardb/session`)).json()).live.agentId).toBe(agentId);
});
