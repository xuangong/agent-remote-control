import { expect, it } from 'vitest';
import type { AgentStreamEvent } from '@agent-remote-controller/agent-provider-sdk';
import { ClaudeInteractions } from './interactions.js';

function pendingPlan(approve: () => Promise<void>, plan: unknown = '# Native plan\nChange one file.') {
  const events: AgentStreamEvent[] = [];
  const interactions = new ClaudeInteractions((event) => events.push(event), approve);
  const controller = new AbortController();
  const input = { plan, otherNativeField: true };
  const result = interactions.request('ExitPlanMode', input, { signal: controller.signal, toolUseID: 'plan-tool' });
  const event = events.find((event) => event.type === 'interaction_requested');
  if (event?.type !== 'interaction_requested') throw new Error('Missing plan request');
  return { interactions, events, controller, input, result, request: event.request };
}

it('reviews the actual native plan and waits for permission restoration before allowing execution', async () => {
  let confirm!: () => void;
  const plan = pendingPlan(() => new Promise<void>((resolve) => { confirm = resolve; }));
  expect(plan.request).toMatchObject({ kind: 'plan_approval', plan: plan.input.plan, allowedActions: ['approve_and_resume', 'reject'] });
  let settled = false; void plan.result.then(() => { settled = true; });
  const responding = plan.interactions.respond(plan.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(() => plan.interactions.respond(plan.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' })).toThrow(/progress/);
  confirm(); await responding;
  await expect(plan.result).resolves.toEqual({ behavior: 'allow', updatedInput: plan.input });
  expect(plan.events.filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
});

it('preserves rejection feedback and never invents a missing plan body', async () => {
  const plan = pendingPlan(async () => { throw new Error('Must not transition'); });
  await plan.interactions.respond(plan.request.requestId, { kind: 'plan_approval', action: 'reject', feedback: 'Keep the old API.' });
  await expect(plan.result).resolves.toEqual({ behavior: 'deny', message: 'Keep the old API.' });
  const events: AgentStreamEvent[] = [];
  const interactions = new ClaudeInteractions((event) => events.push(event), async () => {});
  await expect(interactions.request('ExitPlanMode', {}, { signal: new AbortController().signal, toolUseID: 'missing' })).resolves.toMatchObject({ behavior: 'deny' });
  expect(events).toHaveLength(0);
});

it('keeps a failed approval pending for retry and handles cancellation during native transition exactly once', async () => {
  const failed = pendingPlan(async () => { throw new Error('native refused'); });
  await expect(failed.interactions.respond(failed.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' })).rejects.toThrow('native refused');
  expect(failed.interactions.size).toBe(1);
  expect(failed.events.filter((event) => event.type === 'interaction_resolved')).toHaveLength(0);
  failed.controller.abort();
  await expect(failed.result).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
  let confirm!: () => void;
  const canceled = pendingPlan(() => new Promise<void>((resolve) => { confirm = resolve; }));
  const responding = canceled.interactions.respond(canceled.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' });
  canceled.controller.abort(); confirm();
  await expect(responding).rejects.toThrow(/no longer active/);
  await expect(canceled.result).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
  expect(canceled.events.filter((event) => event.type === 'interaction_resolved')).toHaveLength(1);
});
