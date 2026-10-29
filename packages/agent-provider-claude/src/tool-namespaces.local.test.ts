import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentSessionTool, AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

const schema = { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false };
const tool = (name: string, calls: unknown[], text: string): AgentSessionTool => ({ name, description: `Run ${name}.`, inputSchema: schema,
  execute: async args => { calls.push(args); return text; } });
const names = (body: any): string[] => (body.tools ?? []).map((item: any) => item.name).filter((name: string) => name.startsWith('mcp__'));

// Each turn's prompt names the tool the scripted model calls once, then it answers with the tool's output.
async function scripted(access?: 'read_only') {
  const fixture = await nativeFixture((body, response) => {
    const last = body.messages?.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((part: any) => part?.type === 'tool_result') : undefined;
    if (result) { nativeReply(response, [{ type: 'text', text: `SAW ${JSON.stringify(result.content)}` }]); return; }
    const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const target = /CALL (\w+)/.exec(prompt)?.[1];
    nativeReply(response, target ? [{ type: 'tool_use', id: `use-${randomUUID()}`, name: target, input: { role: 'code reviewer' } }] : [{ type: 'text', text: 'IDLE' }]);
  });
  const hostCalls: unknown[] = [];
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929',
    ...(access ? { access } : {}), tools: [tool('report', hostCalls, 'REPORTED')] }, fixture.options);
  const events: AgentStreamEvent[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  const turn = async (text: string) => {
    const before = events.filter(event => event.type === 'turn_completed').length;
    await session.sendMessage(text);
    await expect.poll(() => events.filter(event => ['turn_completed', 'turn_failed', 'interaction_requested'].includes(event.type)).length, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(events.filter(event => event.type === 'turn_failed' || event.type === 'interaction_requested')).toEqual([]);
  };
  return { fixture, session, hostCalls, turn, close: async () => { await session.dispose(); await pump.catch(() => {}); await fixture.close(); } };
}

it('adds a namespace to a running session, runs its tool without asking, and removes it again', async () => {
  const s = await scripted();
  const calls: unknown[] = [];
  try {
    await s.turn('first turn');
    expect(names(s.fixture.bodies.at(-1))).not.toContain('mcp__agent_remote__call_for_support');
    await s.session.updateToolNamespaces([{ name: 'agent_remote', description: 'Agent Remote Control', tools: [tool('call_for_support', calls, 'CALL_ACCEPTED call-123')] }]);
    await s.turn('CALL mcp__agent_remote__call_for_support');
    expect(names(s.fixture.bodies.at(-2))).toContain('mcp__agent_remote__call_for_support');
    expect(calls).toEqual([{ role: 'code reviewer' }]);
    expect(JSON.stringify(s.fixture.bodies.at(-1).messages.at(-1))).toContain('CALL_ACCEPTED call-123');
    await s.session.updateToolNamespaces([]);
    await s.turn('third turn');
    expect(names(s.fixture.bodies.at(-1))).not.toContain('mcp__agent_remote__call_for_support');
    expect(names(s.fixture.bodies.at(-1))).toContain('mcp__agent_host__report');
  } finally { await s.close(); }
}, 90_000);

it('lets a read-only session run its Host tools and namespace tools, which it cannot ask about', async () => {
  const s = await scripted('read_only');
  const calls: unknown[] = [];
  try {
    await s.turn('CALL mcp__agent_host__report');
    expect(s.hostCalls).toEqual([{ role: 'code reviewer' }]);
    await s.session.updateToolNamespaces([{ name: 'agent_remote', description: 'Agent Remote Control', tools: [tool('call_for_support', calls, 'CALL_ACCEPTED')] }]);
    await s.turn('CALL mcp__agent_remote__call_for_support');
    expect(calls).toEqual([{ role: 'code reviewer' }]);
    // The Host server kept working across the change.
    await s.turn('CALL mcp__agent_host__report');
    expect(s.hostCalls).toHaveLength(2);
  } finally { await s.close(); }
}, 90_000);
