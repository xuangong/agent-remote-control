import { expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import { ClaudeAgentProvider } from '../dist/provider.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

it('shows native SendMessage input before the resumed child answer', async () => {
  let childId = '';
  const fixture = await nativeFixture((body, response) => {
    const last = body.messages.at(-1)?.content;
    const text = typeof last === 'string' ? last : (last ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    const content = text.includes('SPAWN_CHILD')
      ? [{ type: 'tool_use', id: 'spawn-call', name: 'Agent', input: { description: 'Child history probe', prompt: 'CHILD_FIRST', subagent_type: 'general-purpose' } }]
      : text.includes('FOLLOW_UP')
      ? [{ type: 'tool_use', id: 'followup-call', name: 'SendMessage', input: { to: childId, message: 'CHILD_SECOND' } }]
      : [{ type: 'text', text: text.includes('CHILD_SECOND') ? 'SECOND_ANSWER' : text.includes('CHILD_FIRST') ? 'FIRST_ANSWER' : 'PARENT_DONE' }];
    nativeReply(response, content);
  });
  const provider = new ClaudeAgentProvider({ ...fixture.options, query(input) {
    const native = query(input);
    return new Proxy(native, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const message of native) {
          if (message.type === 'system' && message.subtype === 'task_started') childId = message.task_id;
          yield message;
        }
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } });
  let parent: AgentSession | undefined;
  let child: AgentSession | undefined;
  let pump: Promise<void> | undefined;
  try {
    parent = await provider.createSession({ sessionId: 'proposal', cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' });
    const root = parent.observe()[Symbol.asyncIterator]();
    await root.next();
    async function send(text: string) {
      await parent!.sendMessage(text);
      for (;;) {
        const { value, done } = await root.next();
        if (done) throw new Error('Parent stopped');
        if (value.type !== 'observation') continue;
        if (value.event.type === 'turn_failed') throw new Error(value.event.error);
        if (value.event.type === 'turn_completed') return;
      }
    }
    await send('SPAWN_CHILD');
    const info = await parent.runtimeInfo();
    expect(info.childSessions).toHaveLength(1);
    child = await provider.openChildSession(info.sessionId!, info.childSessions![0]!.nativeSessionId);
    const output: ProviderStreamItem[] = [];
    pump = (async () => { for await (const item of child!.observe()) output.push(item); })();
    await expect.poll(() => output.some((item) => item.type === 'history_boundary')).toBe(true);
    await send('FOLLOW_UP');
    const items = () => {
      let timeline: any[] = [];
      for (const item of output) {
        if (item.type === 'timeline_replacement') timeline = item.observations.flatMap((row) => row.event.type === 'timeline' ? [row.event.item] : []);
        else if (item.type === 'observation' && item.event.type === 'timeline') timeline.push(item.event.item);
      }
      return timeline;
    };
    await expect.poll(() => items().some((item) => item.type === 'assistant_message' && item.text.includes('SECOND_ANSWER'))).toBe(true);
    await expect.poll(() => items().some((item) => item.type === 'user_message' && item.text.includes('CHILD_SECOND'))).toBe(true);
    const inputIndex = items().findIndex((item) => item.type === 'user_message' && item.text.includes('CHILD_SECOND'));
    const answerIndex = items().findIndex((item) => item.type === 'assistant_message' && item.text.includes('SECOND_ANSWER'));
    expect(items().filter((item) => item.type === 'user_message' && item.text.includes('CHILD_SECOND'))).toHaveLength(1);
    expect(inputIndex).toBeLessThan(answerIndex);
  } finally { await child?.dispose(); await pump; await parent?.dispose(); await fixture.close(); }
}, 15000);
