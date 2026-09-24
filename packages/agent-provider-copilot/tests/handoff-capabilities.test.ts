import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { expect, it } from 'vitest';
import { resolveCopilotExecutable } from '../src/provider.js';
import { fixture, reply } from './native-fixture.js';

// Characterize the pinned runtime before relying on hooks as a release barrier.
it('cannot prevent native prompt admission by rejecting the submitted-prompt hook', async () => {
  const f = await fixture((body, response) => reply(response, body, 'PROMPT_WAS_NOT_BLOCKED'));
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: resolveCopilotExecutable() }),
    env: { ...process.env, COPILOT_HOME: `${f.home}/profile`, GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined },
    useLoggedInUser: false,
  });
  let hookCalls = 0;
  try {
    await client.start();
    const session = await client.createSession({
      workingDirectory: f.cwd, model: 'native-fixture', streaming: true,
      provider: { type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions' },
      hooks: { onUserPromptSubmitted: () => { hookCalls++; throw new Error('ARC_HANDOFF_INPUT_BLOCKED'); } },
      onPermissionRequest: async () => ({ kind: 'denied-interactively-by-user' }),
    });
    const result = await session.sendAndWait({ prompt: 'INPUT_DURING_HANDOFF' }, 5_000);
    expect(hookCalls).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(result?.data.content).toBe('PROMPT_WAS_NOT_BLOCKED');
    expect((await session.getEvents()).filter(event => event.type === 'user.message').map(event => event.data.content)).toEqual(['INPUT_DURING_HANDOFF']);
    await session.disconnect();
    expect(f.errors).toEqual([]);
  } finally {
    try { await client.stop(); } finally { await f.close(); }
  }
}, 20_000);
