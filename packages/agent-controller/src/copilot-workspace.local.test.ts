import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {CopilotAgentProvider} from '../../agent-provider-copilot/src/provider.js';
import {fixture, observe, reply, waitFor} from '../../agent-provider-copilot/tests/native-fixture.js';
import {createCopilotSessionDirectory} from './copilot-directory.js';
import {createHostExecutionPolicy, protectHostDirectory} from './execution-policy.js';

it('opens a persisted Copilot session through workspace policy after a Controller restart', async () => {
  const f = await fixture((body, res) => reply(res, body, 'WORKSPACE_RESTORED'));
  const provider = new CopilotAgentProvider({useLoggedInUser: false, requestTimeoutMs: 5000,
    env: {COPILOT_HOME: join(f.home, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined},
    nativeSessionConfig: {provider: {type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions'}}});
  const directory = protectHostDirectory(createCopilotSessionDirectory(provider, []),
    (await createHostExecutionPolicy({AGENT_HOST_WORKSPACE: f.cwd}))!);
  try {
    const initial = await f.provider.createSession({sessionId: 'initial', cwd: f.cwd, model: 'native-fixture'});
    const seen = observe(initial);
    await initial.sendMessage('BEFORE_RESTART');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    const id = (await initial.runtimeInfo()).sessionId!;
    await f.provider.dispose(); await seen.done;
    const session = await directory.open(id);
    const restored = observe(session);
    await waitFor(() => restored.items.some(item => item.type === 'history_boundary'));
    expect(await realpath((await session.runtimeInfo()).cwd!)).toBe(await realpath(f.cwd));
    expect(restored.timeline().some(row => row.item.type === 'user_message' && row.item.text === 'BEFORE_RESTART')).toBe(true);
    const completed = restored.events().filter(event => event.type === 'turn_completed').length;
    await session.sendMessage('AFTER_RESTART');
    await waitFor(() => restored.events().filter(event => event.type === 'turn_completed').length > completed);
    expect(f.requests).toHaveLength(2);
    expect(f.errors).toEqual([]);
  } finally {await directory.close(); await f.close();}
}, 40000);
