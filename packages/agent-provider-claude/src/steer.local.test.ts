import { randomUUID } from 'node:crypto';
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import type { AgentInputAcceptance } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentSession } from './session.js';
import { ClaudeAgentProvider } from './provider.js';
import { withFoldedInput } from './folded-input.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

it.each(['while a tool runs', 'after the reply is written'] as const)('delivers a message sent %s without rejecting it', async when => {
  let releaseReply: (() => void) | undefined;
  const fixture = await nativeFixture((body, response) => {
    const messages = JSON.stringify(body.messages);
    if (when === 'while a tool runs' && !messages.includes('tool_result')) {
      nativeReply(response, [{ type: 'tool_use', id: 'steer-wait', name: 'Bash', input: { command: 'sleep 2', description: 'wait' } }]);
    } else if (when === 'after the reply is written' && !messages.includes('STEER_INPUT')) {
      void new Promise<void>(resolve => { releaseReply = resolve; }).then(() => nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]));
    } else nativeReply(response, [{ type: 'text', text: messages.includes('STEER_INPUT') ? 'SAW_STEER' : 'NO_STEER' }]);
  });
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929', permissionMode: 'bypassPermissions' }, fixture.options);
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.sendMessage('Start the work.');
    if (when === 'while a tool runs') await expect.poll(() => events.some(event => JSON.stringify(event).includes('steer-wait')), { timeout: 15000 }).toBe(true);
    else await expect.poll(() => typeof releaseReply, { timeout: 15000 }).toBe('function');
    const acceptances: AgentInputAcceptance['disposition'][] = [];
    await session.sendMessage('STEER_INPUT also check this', { onAcceptance: ({ disposition }) => acceptances.push(disposition) });
    releaseReply?.();
    await expect.poll(() => events.filter(event => event.type === 'turn_completed').length, { timeout: 20000 })
      .toBe(when === 'while a tool runs' ? 1 : 2);
    await expect.poll(async () => (await session.runtimeInfo()).status, { timeout: 5000 }).toBe('idle');
    expect(fixture.bodies.some(body => JSON.stringify(body).includes('STEER_INPUT'))).toBe(true);
    expect(JSON.stringify(events)).toContain('SAW_STEER');
    expect(acceptances).toEqual(['queued', when === 'while a tool runs' ? 'handled' : 'started']);
    expect(events.some(event => event.type === 'turn_failed')).toBe(false);
  } finally { releaseReply?.(); await session.dispose(); await pump; await fixture.close(); }
}, 60000);

it('stops a message waiting behind the running turn before it reaches the model', async () => {
  let releaseReply: (() => void) | undefined;
  const fixture = await nativeFixture((body, response) => {
    if (JSON.stringify(body.messages).includes('STOPPED_INPUT')) { nativeReply(response, [{ type: 'text', text: 'SAW_STOPPED' }]); return; }
    void new Promise<void>(resolve => { releaseReply = resolve; }).then(() => nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]));
  });
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, fixture.options);
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.sendMessage('Start the work.');
    await expect.poll(() => typeof releaseReply, { timeout: 15000 }).toBe('function');
    const acceptances: AgentInputAcceptance['disposition'][] = [], withdrawals: string[] = [];
    await session.sendMessage('STOPPED_INPUT do this next', { onAcceptance: ({ disposition }) => acceptances.push(disposition), onWithdrawn: ({ reason }) => withdrawals.push(reason) });
    await expect.poll(() => acceptances, { timeout: 10000 }).toEqual(['queued']);
    await session.cancel();
    releaseReply?.();
    await expect.poll(() => events.some(event => event.type === 'turn_canceled'), { timeout: 15000 }).toBe(true);
    await expect.poll(() => withdrawals, { timeout: 10000 }).toEqual(['stopped']);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(fixture.bodies.some(body => JSON.stringify(body).includes('STOPPED_INPUT'))).toBe(false);
    expect(events.filter(event => event.type === 'timeline' && event.item.type === 'user_message' && event.item.withdrawn).map(event => event.item.text)).toEqual(['STOPPED_INPUT do this next']);
    expect(events.filter(event => event.type === 'turn_started')).toHaveLength(1);
    expect((await session.runtimeInfo()).status).toBe('idle');
  } finally { releaseReply?.(); await session.dispose(); await pump; await fixture.close(); }
}, 60000);

it('restores a message folded into a running turn when the session is reopened', async () => {
  const fixture = await nativeFixture((body, response) => {
    const messages = JSON.stringify(body.messages);
    if (!messages.includes('tool_result')) nativeReply(response, [{ type: 'tool_use', id: 'fold-wait', name: 'Bash', input: { command: 'sleep 2', description: 'wait' } }]);
    else nativeReply(response, [{ type: 'text', text: messages.includes('FOLDED_INPUT') ? 'SAW_FOLDED' : 'NO_FOLDED' }]);
  });
  const env = fixture.options.env!, previous = process.env.CLAUDE_CONFIG_DIR;
  // Public session reads resolve the native profile from the process environment.
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  const catalog = { list: () => listSessions(), info: (id: string) => getSessionInfo(id), messages: (id: string) => getSessionMessages(id),
    timelineMessages: async (id: string) => withFoldedInput(id, await getSessionMessages(id), env), children: async () => [] };
  const provider = new ClaudeAgentProvider({ ...fixture.options, catalog });
  try {
    const session = await provider.createSession({ cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' });
    const live: any[] = [];
    const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') live.push(item.event); })();
    await session.sendMessage('START_INPUT');
    await expect.poll(() => JSON.stringify(live).includes('fold-wait'), { timeout: 15000 }).toBe(true);
    await session.sendMessage('FOLDED_INPUT also check this');
    await expect.poll(() => JSON.stringify(live).includes('SAW_FOLDED'), { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await session.runtimeInfo()).status, { timeout: 5000 }).toBe('idle');
    const handle = (await session.runtimeInfo()).persistence!;
    await session.dispose(); await pump;
    const resumed = await provider.resumeSession(handle);
    const history: string[] = [];
    for await (const item of resumed.observe()) {
      if (item.type === 'history_boundary') break;
      if (item.type === 'observation' && item.event.type === 'timeline' && ['user_message', 'assistant_message'].includes(item.event.item.type)) history.push(`${item.event.item.type}:${(item.event.item as { text: string }).text}`);
    }
    await resumed.dispose();
    expect(history).toEqual(['user_message:START_INPUT', 'user_message:FOLDED_INPUT also check this', 'assistant_message:SAW_FOLDED']);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await provider.dispose(); await fixture.close();
  }
}, 60000);
