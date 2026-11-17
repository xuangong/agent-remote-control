import { expect, it } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { message, startResponsesFixture } from './test-utils/native-responses-fixture.js';

it.runIf(!!process.env.ARC_PROMPT_EDIT_TEST_EXECUTABLE)('verifies native prompt-edit boundaries and preserves the original thread', async () => {
  const fixture = await startResponsesFixture((_request, index) => message(`answer-${index + 1}`, `Done ${index + 1}`));
  const directory = fixture.cwd;
  const provider = new CodexAppServerProvider({ executable: process.env.ARC_PROMPT_EDIT_TEST_EXECUTABLE,
    env: fixture.env, requestTimeoutMs: 10000 });
  const sessions: AgentSession[] = [];
  try {
    const source = await provider.createSession({ sessionId: 'test', cwd: directory }); sessions.push(source);
    const stream = source.observe()[Symbol.asyncIterator](); await stream.next();
    const prompts: Array<{ turnId: string; messageId: string }> = [];
    for (const text of ['Keep this prompt', 'Edit this prompt', 'Discard this later prompt']) {
      await source.sendMessage(text);
      for (;;) {
        const next = await stream.next(); if (next.done) throw new Error('Runtime ended');
        if (next.value.type !== 'observation') continue;
        const { event } = next.value;
        if (event.type === 'timeline' && event.item.type === 'user_message') prompts.push({ turnId: event.turnId!, messageId: event.item.messageId! });
        if (event.type === 'turn_failed') throw new Error(JSON.stringify(event));
        if (event.type === 'turn_completed') break;
      }
    }
    const persistence = (await source.runtimeInfo()).persistence!;
    await provider.validatePromptEdit({ nativeSessionId: persistence.sessionId, ...prompts[1]! });
    const fork = await provider.forkForPromptEdit({ nativeSessionId: persistence.sessionId, ...prompts[1]! }); sessions.push(fork);
    expect((await fork.runtimeInfo()).sessionId).not.toBe(persistence.sessionId);
    const texts: string[] = [];
    for await (const value of fork.observe()) {
      if (value.type === 'history_boundary') break;
      if (value.event.type === 'timeline' && value.event.item.type === 'user_message') texts.push(value.event.item.text);
    }
    expect(texts).toEqual(['Keep this prompt']);
    const first = await provider.forkForPromptEdit({ nativeSessionId: persistence.sessionId, ...prompts[0]! }); sessions.push(first);
    expect((await first.observe()[Symbol.asyncIterator]().next()).value).toMatchObject({ type: 'history_boundary' });
    await source.dispose();
    const original = await provider.resumeSession(persistence); sessions.push(original);
    const originalTexts: string[] = [];
    for await (const value of original.observe()) {
      if (value.type === 'history_boundary') break;
      if (value.event.type === 'timeline' && value.event.item.type === 'user_message') originalTexts.push(value.event.item.text);
    }
    expect(originalTexts).toEqual(['Keep this prompt', 'Edit this prompt', 'Discard this later prompt']);
    expect(fixture.requests.length).toBe(3);
  } finally {
    await Promise.allSettled(sessions.map(session => session.dispose()));
    await fixture.close();
  }
}, 30000);
