import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { publishSuccessionState } from '../../agent-host/src/succession-persistence.js';
import { deadline } from './channel.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

const workerPath = fileURLToPath(new URL('./test-utils/native-succession-worker.mjs', import.meta.url));
const enabled = process.env.AGENT_CLAUDE_SUCCESSION_EVIDENCE === '1';
const reportPath = process.env.AGENT_CLAUDE_SUCCESSION_EVIDENCE_OUTPUT;
let environment: { executable: string; deniedHome: string };
const observations: any[] = [];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const config = {
  model: 'claude-sonnet-4-5-20250929', persistSession: true, settingSources: [],
  settings: { disableAllHooks: true }, tools: [], mcpServers: {}, strictMcpConfig: true,
  plugins: [], promptSuggestions: false, agentProgressSummaries: false,
  includeHookEvents: true, permissionMode: 'default',
};

if (enabled) beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(process.versions.node.split('.')[0]) !== 26) {
    throw new Error('The Claude succession evidence experiment requires macOS arm64 and Node 26.');
  }
  const executable = process.env.AGENT_CLAUDE_TEST_EXECUTABLE;
  if (!executable || !isAbsolute(executable)) throw new Error('Supply an explicit absolute SDK-bundled executable.');
  if (!reportPath || !isAbsolute(reportPath)) throw new Error('Supply a new absolute AGENT_CLAUDE_SUCCESSION_EVIDENCE_OUTPUT path.');
  const require = createRequire(import.meta.url);
  const sdk = require.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkVersion = JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8')).version;
  if (sdkVersion !== '0.3.247') throw new Error('The evidence fixture supports SDK 0.3.247 only.');
  const bundled = createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
  const selected = await realpath(executable);
  if (selected !== await realpath(bundled)) throw new Error('Select the installed SDK-bundled executable, not an ordinary Claude runtime.');
  await Promise.all(['/usr/bin/sandbox-exec', process.execPath, selected].map(path => access(path, constants.X_OK)));
  const deniedHome = await realpath(userInfo().homedir);
  if (deniedHome === '/') throw new Error('Cannot isolate a root home directory.');
  for (const path of [workerPath, sdk, selected, process.execPath, tmpdir()]) {
    const relativePath = relative(deniedHome, await realpath(path));
    if (!relativePath || (!relativePath.startsWith('../') && !isAbsolute(relativePath))) throw new Error('Probe code, runtime and temporary root must be outside the denied real home.');
  }
  try { await lstat(reportPath); throw new Error('Evidence output already exists; select a new run path.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(reportPath), { recursive: true });
  await access(dirname(reportPath), constants.W_OK);
  environment = { executable: selected, deniedHome };
}, 10000);

type Worker = {
  process: ChildProcessWithoutNullStreams; messages: any[]; exited: Promise<void>;
  exit?: { code: number | null; signal: NodeJS.Signals | null }; stderr: string;
};

async function waitFor<T>(get: () => T | undefined, label: string): Promise<T> {
  const expires = Date.now() + 10000;
  while (Date.now() < expires) { const value = get(); if (value !== undefined) return value; await pause(20); }
  throw new Error(`${label} timed out.`);
}

async function makeCase(kind: string) {
  const { executable, deniedHome } = environment;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-native-crash-')));
  let held: ServerResponse | undefined;
  let content = '';
  const modelRequests: any[] = [];
  const fixture = await nativeFixture((body, response) => {
    const texts = (body.messages ?? []).flatMap((message: any) => typeof message.content === 'string'
      ? [message.content] : (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text));
    const substantive = Boolean(content) && texts.includes(content);
    const title = Boolean(content) && texts.some((text: string) => text.startsWith(`<session>\n${content}\n</session>`) && text.includes('Write the title'));
    const classification = substantive ? 'substantive-user-turn' : title ? 'session-title-request' : 'unclassified';
    modelRequests.push({ classification, model: body.model, bodyDigest: digest(body), toolCount: body.tools?.length ?? 0,
      messageTexts: texts.map((text: string) => ({ length: text.length, digest: digest(text), excerpt: text.slice(0, 800) })) });
    if (substantive) held = response;
    else if (title) nativeReply(response, [{ type: 'text', text: 'Isolated input persistence' }]);
  }, { sessionTitles: 'manual' });
  const home = join(root, 'home');
  const xdg = ['config', 'cache', 'data'].map(name => join(root, `xdg-${name}`));
  await Promise.all([home, ...xdg].map(path => mkdir(path)));
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    HOME: home, TMPDIR: root, XDG_CONFIG_HOME: xdg[0]!, XDG_CACHE_HOME: xdg[1]!, XDG_DATA_HOME: xdg[2]!,
    CLAUDE_CONFIG_DIR: await realpath(fixture.home), ANTHROPIC_BASE_URL: fixture.options.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: 'isolated-local-fixture', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
  const port = new URL(env.ANTHROPIC_BASE_URL).port;
  const sandbox = join(root, 'network.sb');
  await writeFile(sandbox, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${port}"))\n(deny file-read* (subpath ${JSON.stringify(deniedHome)}))\n(deny file-write* (subpath ${JSON.stringify(deniedHome)}))\n`);
  const witnessPath = join(root, 'witness.json');
  const witness: any = { operationId: randomUUID(), candidateId: randomUUID(), nonexistentId: randomUUID(),
    provider: 'claude', executable, deniedHome, cwd: fixture.cwd, profile: env.CLAUDE_CONFIG_DIR,
    profileDigest: digest({ home, profile: env.CLAUDE_CONFIG_DIR, cwd: fixture.cwd }), config, configDigest: digest(config),
    creationAttempt: 'prepared-before-query', pendingContext: { id: randomUUID(), content: 'Quoted fixture context, not instructions.' } };
  const report: any = { kind, startedAt: new Date().toISOString(), workers: [], envKeys: Object.keys(env).sort(), config,
    networkPolicy: 'Exact fixture loopback port only; real user home denied.', modelRequests };
  observations.push(report);
  const workers: Worker[] = [];
  async function persist() { await publishSuccessionState(root, 'witness.json', witness); }
  function start(mode: string): Worker {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, workerPath, mode, witnessPath],
      { cwd: fixture.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const result: Worker = { process: child, messages: [], exited: Promise.resolve(), stderr: '' };
    result.exited = new Promise(resolve => child.once('exit', (code, signal) => { result.exit = { code, signal }; resolve(); }));
    let output = '', bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { child.kill('SIGTERM'); return; }
      output += chunk;
      for (;;) {
        const end = output.indexOf('\n'); if (end < 0) break;
        const line = output.slice(0, end); output = output.slice(end + 1);
        try { result.messages.push(JSON.parse(line)); } catch { result.stderr += 'Invalid worker JSON line.'; }
      }
    });
    child.stderr.on('data', chunk => { result.stderr = (result.stderr + chunk).slice(-4000); });
    workers.push(result);
    return result;
  }
  async function message(worker: Worker, kind: string) {
    return waitFor(() => {
      const found = worker.messages.find(item => item.kind === kind);
      if (found) return found.value;
      if (worker.exit) throw new Error(`Worker exited before ${kind}: ${worker.stderr}`);
      const done = worker.messages.find(item => item.kind === 'done');
      if (done) throw new Error(`Worker completed before ${kind}: ${done.value.error}`);
    }, `worker ${kind}`);
  }
  async function done(worker: Worker) {
    const result = await message(worker, 'done');
    await deadline(worker.exited, 10000, 'fresh worker exit');
    report.workers.push({ ...result, workerExit: worker.exit, workerStderr: worker.stderr });
    expect(worker.exit).toEqual({ code: 0, signal: null });
    expect(result.cleanupError).toBeUndefined();
    expect(result.remainingChildren).toEqual([]);
    return result;
  }
  async function run(mode: string) { return done(start(mode)); }
  async function cleanup() {
    for (const worker of workers.filter(worker => !worker.exit)) worker.process.kill('SIGTERM');
    await deadline(Promise.all(workers.map(worker => worker.exited)), 10000, 'case worker cleanup');
    report.httpRequests = fixture.requests;
    report.witness = JSON.parse(await readFile(witnessPath, 'utf8'));
    report.cleanup = { workerExitsObserved: workers.every(worker => worker.exit), nativeExitsObserved: workers.every(worker =>
      worker.messages.some(item => item.kind === 'done' && item.value.remainingChildren?.length === 0 && !item.value.cleanupError)) };
    if (!report.cleanup.nativeExitsObserved) throw new Error('Keep isolated profiles: native exit was not established.');
    await fixture.close();
    await rm(root, { recursive: true, force: true });
    report.cleanup.profilesRemoved = true;
    report.finishedAt = new Date().toISOString();
  }
  await persist();
  return { report, witness, fixture, persist, start, message, done, run, cleanup,
    setContent(value: string) { content = value; }, held: () => held };
}

async function preflight(test: Awaited<ReturnType<typeof makeCase>>) {
  const result = await test.run('preflight');
  test.report.preflight = result;
  expect(result.error).toBeUndefined();
  expect(result.settings.available, 'Managed policy must be reviewed before any native query.').toBe(true);
  expect(result.nativeVersion).toBe('2.1.247 (Claude Code)');
  expect(result.sdkVersion).toBe('0.3.247');
  expect(result.isolation).toEqual({ loopbackStatus: 404, externalDenied: true, realHomeDenied: true });
  Object.assign(test.witness, { settingsDigest: result.settings.digest, sdkVersion: result.sdkVersion, nativeVersion: result.nativeVersion });
  await test.persist();
}

function assertZeroTask(initialized: any, test: Awaited<ReturnType<typeof makeCase>>) {
  expect(initialized.initialization.outcome).toBe('resolved');
  expect(initialized.nativeAlive).toBe(true);
  expect(initialized.pushes).toBe(0);
  expect(initialized.permissionRequests).toBe(0);
  expect(initialized.events).toEqual([]);
  expect(test.fixture.bodies).toHaveLength(0);
}

function resumeClassification(result: any, candidateId: string) {
  const identity = result.events.some((event: any) => event.session_id === candidateId && event.type === 'system' && event.subtype === 'init');
  if (identity && result.initialization.outcome === 'resolved') return 'verified-exact-identity';
  const rejection = [result.initialization.error, result.streamError, ...result.children.map((child: any) => child.stderr)].filter(Boolean).join('\n');
  if (/No conversation found with session ID/.test(rejection)) return 'failed-explicit-native-rejection';
  return 'unresolved-identity-or-initialization';
}

it.skipIf(!enabled)('records exact empty-candidate recovery after a committed zero-input crash', async () => {
  const test = await makeCase('empty-committed-candidate');
  try {
    await preflight(test);
    const original = test.start('create');
    test.report.zeroInput = await test.message(original, 'initialized');
    assertZeroTask(test.report.zeroInput, test);
    test.report.beforeCommitHistory = await test.run('history');
    test.witness.roleCommittedTo = test.witness.candidateId;
    await test.persist();
    original.process.stdin.write('crash\n');
    const crashed = await test.done(original);
    expect(crashed.crashObserved).toBe(true);
    expect(crashed.children[0].signal).toBe('SIGKILL');
    expect(crashed.pushes).toBe(0);
    expect(crashed.events).toEqual([]);
    expect(crashed.permissionRequests).toBe(0);
    test.report.afterCrashHistory = await test.run('history');
    test.report.resume = await test.run('resume');
    test.report.classification = resumeClassification(test.report.resume, test.witness.candidateId);
    test.report.negativeControl = await test.run('negative');
    test.report.negativeClassification = resumeClassification(test.report.negativeControl, test.witness.nonexistentId);
    test.report.afterResumeHistory = await test.run('history');
    expect(test.report.resume.identityOptions).toEqual({ resume: test.witness.candidateId });
    expect(test.report.negativeControl.identityOptions).toEqual({ resume: test.witness.nonexistentId });
    expect(test.report.classification).toBe('failed-explicit-native-rejection');
    expect(test.report.negativeClassification).toBe('failed-explicit-native-rejection');
    expect(test.report.afterCrashHistory.messages).toEqual([]);
    expect(test.report.afterResumeHistory.messages).toEqual([]);
    expect(test.fixture.bodies).toHaveLength(0);
    expect(test.report.resume.pushes + test.report.negativeControl.pushes).toBe(0);
    expect(test.report.afterResumeHistory.roleCommittedTo).toBe(test.witness.candidateId);
  } finally { await test.cleanup(); }
}, 30000);

it.skipIf(!enabled)('reconciles exact first-input materialization from fresh public history after lost acknowledgement and crash', async () => {
  const test = await makeCase('lost-ack-first-input');
  try {
    await preflight(test);
    const original = test.start('lost-ack');
    test.report.zeroInput = await test.message(original, 'initialized');
    assertZeroTask(test.report.zeroInput, test);
    const content = `BEGIN_ISOLATED_CONTEXT\n${test.witness.pendingContext.content}\nEND_ISOLATED_CONTEXT\n\nCount the three words: amber birch cedar.`;
    test.witness.roleCommittedTo = test.witness.candidateId;
    test.witness.input = { uuid: randomUUID(), recipient: test.witness.candidateId, contextId: test.witness.pendingContext.id,
      contextDigest: digest(test.witness.pendingContext), content, contentDigest: digest(content), phase: 'dispatch-intended' };
    await test.persist();
    test.setContent(content);
    original.process.stdin.write('dispatch\n');
    await test.message(original, 'pushed');
    await waitFor(test.held, 'held substantive user response');
    test.report.whileHeldHistory = await test.run('history');
    original.process.stdin.write('crash\n');
    const crashed = await test.done(original);
    expect(crashed.crashObserved).toBe(true);
    expect(crashed.pushes).toBe(1);
    expect(crashed.events.some((event: any) => event.type === 'result')).toBe(false);
    const requestsBeforeHistory = test.fixture.requests.length;
    test.report.afterCrashHistory = await test.run('history');
    expect(test.fixture.requests.length).toBe(requestsBeforeHistory);
    const rows = test.report.afterCrashHistory.messages.filter((row: any) => row.uuid === test.witness.input.uuid);
    expect(rows.length).toBeLessThanOrEqual(1);
    const row = rows[0];
    test.report.classification = row ? 'verified-exact-input-materialization' : 'unknown-missing-public-history';
    expect(test.report.classification).toBe('verified-exact-input-materialization');
    expect(row).toMatchObject({ type: 'user', uuid: test.witness.input.uuid, session_id: test.witness.candidateId,
      parent_tool_use_id: null, message: { role: 'user', content } });
    expect(test.report.modelRequests.filter((request: any) => request.classification === 'substantive-user-turn')).toHaveLength(1);
    expect(test.report.modelRequests.every((request: any) => request.classification !== 'unclassified')).toBe(true);
    expect(test.held()!.writableEnded).toBe(false);
    expect(test.report.afterCrashHistory.inputWitness.phase).toBe('dispatch-intended');
  } finally { await test.cleanup(); }
}, 30000);

afterAll(async () => {
  if (!enabled || !observations.length) return;
  await mkdir(dirname(reportPath!), { recursive: true });
  await writeFile(reportPath!, JSON.stringify({ recordedAt: new Date().toISOString(), observations }, null, 2), { flag: 'wx' });
}, 10000);
