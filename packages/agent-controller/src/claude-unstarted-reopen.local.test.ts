import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../../agent-provider-claude/dist/catalog.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { createHostExecutionPolicy, protectHostDirectory } from './execution-policy.js';
import { SessionCreationStore } from './session-creation-store.js';

it('reopens a Claude session that never received input after a Controller restart, under the workspace policy', async () => {
  const f = await nativeFixture((_body, response) => nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]));
  const policy = (await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: f.cwd }))!;
  const controller = () => protectHostDirectory(createClaudeSessionDirectory(
    new ClaudeAgentProvider({ ...f.options, catalog: createClaudeCatalog(f.options.env, 15000) }), [], undefined, undefined,
    new SessionCreationStore(join(f.home, 'creations'), 'claude')), policy);
  let directory = controller();
  try {
    const id = await directory.create({ cwd: f.cwd, model: 'claude-sonnet-4-5-20250929' });
    await directory.close();
    directory = controller();
    const reopened = await directory.open(id);
    expect((await reopened.runtimeInfo()).sessionId).toBe(id);
    const texts: string[] = [];
    let completed = 0;
    const pump = (async () => { for await (const item of reopened.observe()) {
      if (item.type !== 'observation') continue;
      if (item.event.type === 'turn_completed') completed++;
      if (item.event.type === 'timeline' && item.event.item.type === 'assistant_message') texts.push(item.event.item.text);
    } })();
    await reopened.sendMessage('First message after the restart');
    await expect.poll(() => completed, { timeout: 20000 }).toBe(1);
    expect(texts).toContain('FIRST_REPLY');
    await directory.close(); await pump;
    // It now has a transcript and resumes from it.
    directory = controller();
    expect((await (await directory.open(id)).runtimeInfo()).sessionId).toBe(id);
  } finally { await directory.close(); await f.close(); }
}, 90000);
