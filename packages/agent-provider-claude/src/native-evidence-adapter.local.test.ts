import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { deadline } from './channel.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

const enabled = process.env.AGENT_CLAUDE_ADAPTER_EVIDENCE === '1';
it.skipIf(!enabled)('validates empty restoration, current settings, exact input and source tools through an isolated native SDK process', async () => {
  if (process.platform !== 'darwin' || !process.env.AGENT_CLAUDE_TEST_EXECUTABLE || !process.env.AGENT_CLAUDE_ADAPTER_EVIDENCE_REPORT) throw new Error('Explicit macOS native executable and evidence report path are required.');
  const executable = await realpath(process.env.AGENT_CLAUDE_TEST_EXECUTABLE);
  let calls = 0;
  const fixture = await nativeFixture((body, response) => {
    const tool = body.tools?.find((value: any) => value.name.endsWith('read_source_session'));
    nativeReply(response, ++calls === 1 ? [{ type: 'tool_use', id: 'source-tool', name: tool?.name ?? 'mcp__agent_host__read_source_session', input: {} }] : [{ type: 'text', text: 'Source acknowledged.' }]);
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-claude-adapter-evidence-')));
  const home = join(root, 'home'), result = join(root, 'result.json');
  await mkdir(home);
  const worker = fileURLToPath(new URL('./test-utils/native-evidence-worker.mjs', import.meta.url));
  const module = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ executable, result, cwd: fixture.cwd, module }));
  const port = new URL(fixture.options.env.ANTHROPIC_BASE_URL).port;
  const sandbox = join(root, 'network.sb');
  const deniedHome = await realpath(userInfo().homedir);
  await writeFile(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${port}"))\n(deny file-read* (subpath ${JSON.stringify(deniedHome)}))\n(deny file-write* (subpath ${JSON.stringify(deniedHome)}))\n`);
  const messages: any[] = []; let stderr = '', stdout = '';
  const child = spawn('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, worker, config], { cwd: fixture.cwd,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, SHELL: '/bin/zsh',
      LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: fixture.home, ANTHROPIC_API_KEY: 'isolated-local-fixture', ANTHROPIC_BASE_URL: fixture.options.env.ANTHROPIC_BASE_URL,
      DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdout.on('data', chunk => { stdout += chunk; for (;;) { const index = stdout.indexOf('\n'); if (index < 0) break; const line = stdout.slice(0, index); stdout = stdout.slice(index + 1); try { const value = JSON.parse(line); messages.push({ ...value, modelRequests: fixture.bodies.length }); } catch {} } });
  let report: any;
  try {
    const exit = await deadline(exited, 27000, 'isolated adapter evidence worker');
    report = JSON.parse(await readFile(result, 'utf8'));
    report.workerExit = exit; report.workerStderr = stderr; report.stages = messages;
    report.modelRequests = fixture.bodies.length;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(report.error).toBeUndefined(); expect(report.cleanupError).toBeUndefined();
    expect(messages.find(message => message.stage === 'prepared')?.modelRequests).toBe(0);
    expect(report.defaultResumeRejected).toBe(true);
    expect(report.restored.settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'acceptEdits' }));
    expect(report.restored.settings).toContainEqual(expect.objectContaining({ id: 'reasoning_effort', value: 'high' }));
    expect(report.coldRestored.settings).toContainEqual(expect.objectContaining({ id: 'model', value: 'opus[1m]' }));
    expect(report.coldRestored.settings).toContainEqual(expect.objectContaining({ id: 'reasoning_effort', value: 'low' }));
    expect(report.coldRestored.settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'dontAsk' }));
    expect(JSON.parse(report.latestConfirmed.persistence.opaque).kind).toBeUndefined();
    expect(report.started).toMatchObject({ status: 'materialized', proof: { inputId: report.witness.inputId, nativeInputId: report.witness.inputId }, execution: { disposition: 'started' } });
    expect(report.cold).toMatchObject({ status: 'materialized' }); expect(report.cold).not.toHaveProperty('execution');
    expect(report.coldReplayRejected).toBe(true); expect(report.sourceCalls).toBe(1);
    expect(report.exits).toHaveLength(3); expect(fixture.bodies).toHaveLength(3);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await deadline(exited, 10000, 'evidence worker cleanup');
    if (report) await writeFile(process.env.AGENT_CLAUDE_ADAPTER_EVIDENCE_REPORT!, JSON.stringify(report, null, 2));
    if (report && messages.some(message => message.stage === 'done') && !report.cleanupError) {
      await fixture.close(); await rm(root, { recursive: true, force: true });
    } else throw new Error(`Native cleanup was not confirmed; retained fixture at ${root}, ${fixture.home}, ${fixture.cwd}.`);
  }
}, 40000);
