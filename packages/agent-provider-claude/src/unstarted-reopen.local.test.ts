import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from './provider.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../dist/catalog.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

it('reopens a created session that never received input after its process is gone, under the same identity', async () => {
  const fixture = await nativeFixture((_body, response) => nativeReply(response, [{ type: 'text', text: 'SIDE_REPLY' }]));
  const options = { ...fixture.options, catalog: createClaudeCatalog(fixture.options.env, 15000) };
  try {
    const created = await new ClaudeAgentProvider(options).createSession({ cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' });
    const handle = (await created.runtimeInfo()).persistence!;
    await created.dispose();
    // A restarted Host has a new provider and no transcript for the session.
    const provider = new ClaudeAgentProvider(options);
    await expect(provider.resumeSession(handle)).rejects.toThrow(/unavailable/);
    const reopened = await provider.resumeSession(handle, {}, { initializeEmpty: true });
    const texts: string[] = [];
    let completed = 0;
    const pump = (async () => { for await (const item of reopened.observe()) {
      if (item.type !== 'observation') continue;
      if (item.event.type === 'turn_completed') completed++;
      if (item.event.type === 'timeline' && item.event.item.type === 'assistant_message') texts.push(item.event.item.text);
    } })();
    expect((await reopened.runtimeInfo()).sessionId).toBe(handle.sessionId);
    await reopened.sendMessage('First message to the Side');
    await expect.poll(() => completed, { timeout: 20000 }).toBe(1);
    expect(texts).toContain('SIDE_REPLY');
    await reopened.dispose(); await pump;
    // It now has a transcript, so it resumes like any other session.
    const resumed = await new ClaudeAgentProvider(options).resumeSession(handle);
    expect((await resumed.runtimeInfo()).sessionId).toBe(handle.sessionId);
    await resumed.dispose();
  } finally { await fixture.close(); }
}, 90000);
