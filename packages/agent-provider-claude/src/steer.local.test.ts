import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInputAcceptance } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentSession } from './session.js';
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
