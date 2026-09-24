import {execFile, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';
import {fixture, observe, reply, waitFor} from '../../agent-provider-copilot/tests/native-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function controllerEnvironment(f: Fixture) {
  const state = join(f.home, 'controller'); await mkdir(state);
  await writeFile(join(state, 'connection.json'), JSON.stringify({serverUrl: 'https://relay.invalid', remoteKey: 'fixture-only', environment: {AGENT_HOST_COPILOT_HOME: join(f.home, 'profile')}}));
  return {...process.env, TERM: 'xterm-256color', AGENT_HOST_STATE_DIR: state,
    AGENT_HOST_COPILOT: undefined, AGENT_HOST_COPILOT_HOME: undefined,
    GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined,
    COPILOT_PROVIDER_BASE_URL: f.baseUrl, COPILOT_MODEL: 'native-fixture'};
}
function cliArgs(id: string) {
  return [resolve('dist/cli.js'), 'copilot', 'resume', id, '--no-auto-update', '--no-auto-login', '--disable-builtin-mcps', '--allow-all-tools'];
}
async function locks(f: Fixture, id: string) {
  return (await readdir(join(f.home, 'profile', 'session-state', id))).filter(name => /^inuse\..*\.lock$/.test(name));
}
async function history(f: Fixture, id: string): Promise<Array<{type: string; data: {content?: string}}>> {
  return (await readFile(join(f.home, 'profile', 'session-state', id, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// These tests verify native lifecycle primitives. They do not claim that ARC's
// coordinated ownership reservation, admission barrier, or takeover UI exists.
it.each(['safe', 'interrupt'] as const)('hands SDK execution to the real CLI using %s release', async mode => {
  let finish: (() => void) | undefined;
  const f = await fixture((body, res, index) => {
    if (index === 1) finish = () => reply(res, body, 'SDK_TASK_FINISHED');
    else reply(res, body, mode === 'safe' && index === 2 ? 'SDK_QUEUED_FINISHED' : 'CLI_CONTINUED');
  });
  try {
    const session = await f.provider.createSession({sessionId: 'fixture', cwd: f.cwd, model: 'native-fixture'});
    const seen = observe(session); const info = await session.runtimeInfo();
    await session.sendMessage('SDK_RUNNING_TASK'); await waitFor(() => finish);
    expect((await session.rpc.metadata.isProcessing()).processing).toBe(true);
    expect((await locks(f, info.sessionId!)).length).toBeGreaterThan(0);
    if (mode === 'safe') {
      await session.sendMessage('SDK_QUEUED_TASK', {delivery: 'next_turn'});
      expect((await session.rpc.queue.pendingItems()).items).toHaveLength(1);
      finish!(); await waitFor(() => seen.events().filter(event => event.type === 'turn_completed').length === 2);
    } else await session.cancel();
    await waitFor(async () => !(await session.rpc.metadata.isProcessing()).processing);
    expect((await session.rpc.tasks.list()).tasks).toEqual([]);
    expect((await session.rpc.queue.pendingItems()).items).toEqual([]);
    await session.dispose();
    expect(await locks(f, info.sessionId!)).toEqual([]);
    const {stdout} = await promisify(execFile)(process.execPath, [...cliArgs(info.sessionId!), '-p', 'CLI_TAKEOVER'], {
      cwd: f.cwd, env: await controllerEnvironment(f), timeout: 20000,
    });
    expect(stdout).toContain('CLI_CONTINUED');
    const resumed = await f.provider.resumeSession(info.persistence!); const restored = observe(resumed);
    await waitFor(() => restored.items.some(item => item.type === 'history_boundary'));
    expect((await resumed.runtimeInfo()).sessionId).toBe(info.sessionId);
    const messages = restored.events().flatMap(event => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item.text] : []);
    expect(messages).toEqual(mode === 'safe' ? ['SDK_RUNNING_TASK', 'SDK_QUEUED_TASK', 'CLI_TAKEOVER'] : ['SDK_RUNNING_TASK', 'CLI_TAKEOVER']);
    const nativeHistory = await history(f, info.sessionId!);
    expect(nativeHistory.some(event => event.type === 'assistant.message' && event.data.content === 'SDK_TASK_FINISHED')).toBe(mode === 'safe');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 40000);

it.skipIf(process.platform === 'win32').each(['safe', 'interrupt'] as const)('hands real interactive CLI execution back to SDK using %s release', async mode => {
  let finish: (() => void) | undefined;
  const f = await fixture((body, res, index) => {
    if (index === 2) finish = () => reply(res, body, 'CLI_TASK_FINISHED');
    else reply(res, body, index === 1 ? 'INITIAL_HISTORY' : 'SDK_CONTINUED');
  });
  let terminal: ChildProcessWithoutNullStreams | undefined;
  try {
    const session = await f.provider.createSession({sessionId: 'fixture', cwd: f.cwd, model: 'native-fixture'});
    const initial = observe(session); const info = await session.runtimeInfo();
    await session.sendMessage('INITIAL'); await waitFor(() => initial.events().some(event => event.type === 'turn_completed'));
    await session.dispose();
    terminal = spawn('python3', [resolve('tests/copilot-pty.py'), process.execPath, ...cliArgs(info.sessionId!)], {cwd: f.cwd, env: await controllerEnvironment(f)});
    let output = '', errors = '', lines = ''; let exit: number | null | undefined;
    terminal.stdout.on('data', chunk => { lines += chunk.toString(); for (;;) {
      const end = lines.indexOf('\n'); if (end < 0) break;
      const row = JSON.parse(lines.slice(0, end)); lines = lines.slice(end + 1);
      if (row.output) output += row.output;
      if ('exit' in row) exit = row.exit;
    } });
    terminal.stderr.on('data', chunk => {errors += chunk.toString();});
    const write = (text: string) => terminal!.stdin.write(JSON.stringify({write: text}) + '\n');
    await waitFor(() => output.includes('commands') && output.includes('INITIAL_HISTORY'));
    expect(output).not.toContain('Session in use');
    await new Promise(resolve => setTimeout(resolve, 500));
    write('CLI_RUNNING_TASK\r'); await waitFor(() => finish).catch(error => {throw new Error(String(error) + '\n' + output.slice(-7000) + errors);});
    expect((await locks(f, info.sessionId!)).length).toBeGreaterThan(0);
    if (mode === 'safe') {
      finish!(); await waitFor(() => output.includes('CLI_TASK_FINISHED'));
    } else {
      await new Promise(resolve => setTimeout(resolve, 200));
      write('\x03'); await waitFor(async () => (await history(f, info.sessionId!)).some(event => event.type === 'abort')).catch(error => {throw new Error(String(error) + '\n' + output.slice(-7000) + errors);});
    }
    write('/exit\r'); await waitFor(() => exit !== undefined);
    expect(exit, output.slice(-2000) + errors).toBe(0);
    expect(await locks(f, info.sessionId!)).toEqual([]);
    const resumed = await f.provider.resumeSession(info.persistence!); const restored = observe(resumed);
    await waitFor(() => restored.items.some(item => item.type === 'history_boundary'));
    expect((await resumed.runtimeInfo()).sessionId).toBe(info.sessionId);
    await resumed.sendMessage('SDK_TAKEOVER');
    await waitFor(() => restored.timeline().some(row => row.item.type === 'assistant_message' && row.item.text === 'SDK_CONTINUED'));
    const messages = restored.events().flatMap(event => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item.text] : []);
    expect(messages).toEqual(['INITIAL', 'CLI_RUNNING_TASK', 'SDK_TAKEOVER']);
    expect((await history(f, info.sessionId!)).some(event => event.type === 'assistant.message' && event.data.content === 'CLI_TASK_FINISHED')).toBe(mode === 'safe');
    expect(f.errors).toEqual([]);
  } finally {
    terminal?.stdin.end();
    if (terminal && terminal.exitCode === null) await new Promise<void>(resolve => {terminal!.once('exit', () => resolve()); setTimeout(resolve, 4500);});
    await f.close();
  }
}, 40000);
