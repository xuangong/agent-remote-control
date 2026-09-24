import {execFile} from 'node:child_process';
import {mkdir, writeFile, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';
import {fixture, observe, reply, waitFor} from '../../agent-provider-copilot/tests/native-fixture.js';

it('continues SDK history through the real native CLI and resumes that same session back in the adapter', async () => {
  const f = await fixture((body, res) => reply(res, body, 'NATIVE_RESUME_OK'));
  try {
    const session = await f.provider.createSession({sessionId: 'fixture', cwd: f.cwd, model: 'native-fixture'});
    const seen = observe(session);
    await session.sendMessage('SDK_BEFORE_TERMINAL');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    const info = await session.runtimeInfo();
    await session.dispose();
    const state = join(f.home, 'controller'); await mkdir(state);
    await writeFile(join(state, 'connection.json'), JSON.stringify({serverUrl: 'https://relay.invalid', remoteKey: 'fixture-only', environment: {AGENT_HOST_COPILOT_HOME: join(f.home, 'profile')}}));
    const {stdout} = await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'copilot', 'resume', info.sessionId!,
      '--no-auto-update', '--no-auto-login', '--disable-builtin-mcps', '-p', 'TERMINAL_CONTINUATION', '--allow-all-tools'], {
      cwd: f.home, timeout: 20000, env: {...process.env, AGENT_HOST_STATE_DIR: state, AGENT_HOST_COPILOT: undefined, AGENT_HOST_COPILOT_HOME: undefined,
        GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined,
        COPILOT_PROVIDER_BASE_URL: f.baseUrl, COPILOT_MODEL: 'native-fixture'},
    });
    expect(stdout).toContain('NATIVE_RESUME_OK');
    const resumed = await f.provider.resumeSession(info.persistence!);
    const restored = observe(resumed);
    await waitFor(() => restored.items.some(item => item.type === 'history_boundary'));
    expect((await resumed.runtimeInfo()).sessionId).toBe(info.sessionId);
    expect(await realpath((await resumed.runtimeInfo()).cwd!)).toBe(await realpath(f.cwd));
    const messages = restored.events().flatMap(event => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item.text] : []);
    expect(messages).toEqual(['SDK_BEFORE_TERMINAL', 'TERMINAL_CONTINUATION']);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 40000);
