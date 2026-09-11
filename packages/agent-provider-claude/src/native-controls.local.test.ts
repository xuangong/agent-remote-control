import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Channel } from './channel.js';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

for (const interrupted of [false, true]) it(`native priority next starts a separate turn${interrupted ? ' even after public interrupt' : ''}`, async () => {
  let held: ServerResponse | undefined;
  const fixture = await nativeFixture((_body, response) => {
    if (!held) held = response;
    else nativeReply(response, [{ type: 'text', text: 'STEER_OK' }]);
  });
  const input = new Channel<SDKUserMessage>();
  const sessionId = randomUUID();
  const native = query({ prompt: input, options: { sessionId, cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929',
    pathToClaudeCodeExecutable: fixture.options.executable, env: { ...process.env, ...fixture.options.env }, includePartialMessages: true } });
  const messages: any[] = [];
  const pump = (async () => { for await (const message of native) messages.push(message); })();
  try {
    await native.initializationResult();
    const first = randomUUID(), steer = randomUUID();
    input.push({ type: 'user', uuid: first, session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: 'FIRST' } });
    await expect.poll(() => Boolean(held)).toBe(true);
    input.push({ type: 'user', uuid: steer, session_id: sessionId, parent_tool_use_id: null, priority: 'next', message: { role: 'user', content: 'STEER' } });
    await expect.poll(() => messages.some((message) => message.type === 'command_lifecycle' && message.command_uuid === steer && message.state === 'queued')).toBe(true);
    if (interrupted) expect(await native.interrupt()).toMatchObject({ still_queued: expect.arrayContaining([steer]) });
    else nativeReply(held!, [{ type: 'text', text: 'FIRST_OK' }]);
    await expect.poll(() => messages.filter((message) => message.type === 'result').length).toBe(2);
    expect(messages.filter((message) => message.type === 'result').map((message) => message.user_message_uuid)).toEqual([first, steer]);
    const firstResult = messages.findIndex((message) => message.type === 'result' && message.user_message_uuid === first);
    expect(messages.findIndex((message) => message.type === 'command_lifecycle' && message.command_uuid === steer && message.state === 'started')).toBeGreaterThan(firstResult);
    expect(fixture.bodies).toHaveLength(2);
  } finally { input.close(); native.close(); await pump.catch(() => {}); await fixture.close(); }
}, 10000);

it('changes native model and restores permissions using public Query controls', async () => {
  const fixture = await nativeFixture((_body, response) => nativeReply(response, [{ type: 'text', text: 'SETTINGS_OK' }]));
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, fixture.options);
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    const models = (await session.runtimeInfo()).settings!.find((setting) => setting.id === 'model')!.options;
    expect(models.length).toBeGreaterThan(0);
    await session.setSessionSetting('model', models[0]!.value);
    await session.setSessionSetting('permissions', 'acceptEdits');
    await session.setPlanning(true);
    await session.setPlanning(false);
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: 'acceptEdits' }));
    await session.sendMessage('VERIFY_SETTINGS');
    await expect.poll(() => events.some((event) => event.type === 'turn_completed')).toBe(true);
    expect(fixture.bodies[0].model).toBe((await session.runtimeInfo()).model?.replace(/\[1m\]$/, ''));
    expect(session.capabilities.steer).toBe(false);
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);

for (const permissionMode of ['default', 'acceptEdits']) it(`reviews native ExitPlanMode and restores ${permissionMode} before execution`, async () => {
  let calls = 0;
  const plan = '# Verified native plan\nKeep the public API unchanged.';
  const fixture = await nativeFixture((_body, response) => {
    nativeReply(response, ++calls === 1
      ? [{ type: 'tool_use', id: 'plan-review', name: 'ExitPlanMode', input: { plan } }]
      : [{ type: 'text', text: 'PLAN_ACCEPTED' }]);
  });
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, fixture.options);
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.setSessionSetting('permissions', permissionMode);
    await session.setPlanning(true);
    await session.sendMessage('REVIEW_THE_PLAN');
    await expect.poll(() => events.some((event) => event.type === 'interaction_requested' && event.request.kind === 'plan_approval')).toBe(true);
    const review = events.find((event) => event.type === 'interaction_requested' && event.request.kind === 'plan_approval');
    expect(review.request.plan).toBe(plan);
    await session.respondToInteraction(review.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' });
    await expect.poll(() => events.some((event) => event.type === 'turn_completed')).toBe(true);
    expect((await session.runtimeInfo()).settings).toContainEqual(expect.objectContaining({ id: 'permissions', value: permissionMode }));
    expect(events.filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);

it('returns exact plan feedback to the native tool without leaving plan mode', async () => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => nativeReply(response, ++calls === 1
    ? [{ type: 'tool_use', id: 'rejected-plan', name: 'ExitPlanMode', input: { plan: '# Plan needing revision' } }]
    : [{ type: 'text', text: 'PLAN_REJECTED' }]));
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, planning: true }, fixture.options);
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.sendMessage('PLAN_FEEDBACK');
    await expect.poll(() => events.some((event) => event.type === 'interaction_requested' && event.request.kind === 'plan_approval')).toBe(true);
    const review = events.find((event) => event.type === 'interaction_requested' && event.request.kind === 'plan_approval');
    await session.respondToInteraction(review.request.requestId, { kind: 'plan_approval', action: 'reject', feedback: 'Keep the existing API.' });
    await expect.poll(() => events.some((event) => event.type === 'turn_completed')).toBe(true);
    expect(JSON.stringify(fixture.bodies[1].messages)).toContain('Keep the existing API.');
    expect((await session.runtimeInfo()).planning?.active).toBe(true);
    await expect(session.respondToInteraction(review.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' })).rejects.toThrow(/no longer active/);
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);
