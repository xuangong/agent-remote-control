import { expect, it } from 'vitest';
import type { AgentPersistenceHandle, AgentSession } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentProvider } from './provider.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../dist/catalog.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

const model = 'claude-sonnet-4-5-20250929';
type Prompt = { text: string; turnId?: string; messageId?: string };

function observe(session: AgentSession) {
  const prompts: Prompt[] = [], texts: string[] = [];
  let completed = 0, boundary = false;
  const pump = (async () => {
    for await (const item of session.observe()) {
      if (item.type === 'history_boundary') { boundary = true; continue; }
      if (item.type !== 'observation') continue;
      const event = item.event;
      if (event.type === 'turn_completed') completed++;
      if (event.type !== 'timeline') continue;
      if (event.item.type === 'user_message') prompts.push({ text: event.item.text, turnId: event.turnId, messageId: event.item.messageId });
      if (event.item.type === 'assistant_message') texts.push(event.item.text);
    }
  })();
  return { prompts, texts, pump, completed: () => completed, ready: () => boundary };
}

it('branches before a prompt with Codex semantics and keeps the original conversation', async () => {
  const fixture = await nativeFixture((body, response) => {
    const last = JSON.stringify(body.messages.at(-1));
    const reply = ['FIRST', 'SECOND', 'THIRD', 'EDITED', 'RESTART'].find(word => last.includes(`${word}_PROMPT`)) ?? 'UNKNOWN';
    nativeReply(response, [{ type: 'text', text: `${reply}_REPLY` }]);
  });
  const provider = new ClaudeAgentProvider({ ...fixture.options, catalog: createClaudeCatalog(fixture.options.env, 15000) });
  const send = async (session: AgentSession, observed: ReturnType<typeof observe>, text: string) => {
    const before = observed.completed();
    await session.sendMessage(text);
    await expect.poll(() => observed.completed(), { timeout: 20000 }).toBe(before + 1);
    await expect.poll(async () => (await session.runtimeInfo()).status, { timeout: 5000 }).toBe('idle');
  };
  try {
    const source = await provider.createSession({ cwd: fixture.cwd, model });
    const sourceId = (await source.runtimeInfo()).sessionId;
    const live = observe(source);
    for (const text of ['FIRST_PROMPT', 'SECOND_PROMPT', 'THIRD_PROMPT']) await send(source, live, text);
    const second = live.prompts.find(prompt => prompt.text === 'SECOND_PROMPT')!;
    expect(second.messageId).toBeTruthy();
    expect(second.turnId).toBe(second.messageId);

    const target = { nativeSessionId: sourceId, turnId: second.turnId!, messageId: second.messageId! };
    const checkpoints: AgentPersistenceHandle[] = [];
    const branch = await provider.nativePrefix!.create(target, {}, async handle => { checkpoints.push(handle); });
    const branchId = (await branch.runtimeInfo()).sessionId;
    expect(branchId).not.toBe(sourceId);
    expect(checkpoints.map(handle => handle.sessionId)).toEqual([branchId]);
    await provider.nativePrefix!.verify(target, checkpoints[0]!);
    const edited = observe(branch);
    await expect.poll(() => edited.ready(), { timeout: 10000 }).toBe(true);
    expect(edited.prompts.map(prompt => prompt.text)).toEqual(['FIRST_PROMPT']);
    await send(branch, edited, 'EDITED_PROMPT');
    const request = JSON.stringify(fixture.bodies.at(-1)!.messages);
    expect(request).toContain('FIRST_PROMPT');
    expect(request).toContain('FIRST_REPLY');
    expect(request).toContain('EDITED_PROMPT');
    expect(request).not.toContain('SECOND_PROMPT');
    expect(request).not.toContain('THIRD_PROMPT');
    await branch.dispose(); await edited.pump;

    // The original is unchanged, and its reopened history offers the same prompts for editing.
    await source.dispose(); await live.pump;
    const reopened = await provider.resumeSession({ providerId: 'claude', sessionId: sourceId, opaque: JSON.stringify({ cwd: fixture.cwd, model }) });
    const history = observe(reopened);
    await expect.poll(() => history.ready(), { timeout: 10000 }).toBe(true);
    expect(history.prompts.map(prompt => prompt.text)).toEqual(['FIRST_PROMPT', 'SECOND_PROMPT', 'THIRD_PROMPT']);
    expect(history.prompts.every(prompt => prompt.turnId && prompt.turnId === prompt.messageId)).toBe(true);
    expect(history.prompts.find(prompt => prompt.text === 'SECOND_PROMPT')!.messageId).toBe(second.messageId);

    const first = history.prompts[0]!;
    const empty = await provider.nativePrefix!.create({ nativeSessionId: sourceId, turnId: first.turnId!, messageId: first.messageId! }, {}, async () => {});
    const restarted = observe(empty);
    await expect.poll(() => restarted.ready(), { timeout: 10000 }).toBe(true);
    expect(restarted.prompts).toEqual([]);
    await send(empty, restarted, 'RESTART_PROMPT');
    expect(JSON.stringify(fixture.bodies.at(-1)!.messages)).not.toContain('FIRST_PROMPT');
    await empty.dispose(); await restarted.pump;
    await reopened.dispose(); await history.pump;
  } finally { await provider.dispose(); await fixture.close(); }
}, 120000);
