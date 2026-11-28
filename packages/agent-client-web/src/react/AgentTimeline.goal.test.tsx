// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createReplicaState, type AgentReplicaState } from '@orchardworks/agent-client';
import { TimelineRows } from '@orchardworks/agent-client/testing';
import type { AgentSessionGoal } from '@orchardworks/agent-remote-protocol';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TaskDirectoryContext, type PageView, type TaskDirectory } from './TaskDirectory.js';

const goal: AgentSessionGoal = { objective: 'all tests pass', status: 'active', iterations: 2, actions: [{ kind: 'clear', commandId: 'goal', args: 'clear' }] };
const page: PageView = { pageId: 'pg_0a1b2c3d4e5f', botId: 'b_tracker', bot: 'tracker', title: 'Launch tracker', contents: '| Task |\n|---|\n| Ship |', version: 1, updatedAt: Date.UTC(2026, 10, 28, 9, 30), team: true };

function conversation(withGoal: AgentSessionGoal | undefined): AgentReplicaState {
  const rows = new TimelineRows('codex', Date.parse('2026-11-20T10:00:00Z'));
  rows.user('Make the tests pass', { key: 'p1', turnId: 't1' });
  rows.assistant('Working on it.', { key: 'a1', turnId: 't1' });
  const base = createReplicaState();
  return { ...base, agent: { id: 'agent', providerId: 'codex', createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z', status: 'idle', activeTurn: null, pendingInteractions: [],
    capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
    runtimeInfo: { providerId: 'codex', sessionId: 'native', status: 'idle', ...(withGoal ? { goal: withGoal } : {}) } },
  timeline: { ...base.timeline, epoch: 'e', initialized: true, entries: rows.entries, nextSeq: rows.entries.length + 1 } };
}
const directory = (pages: readonly PageView[]): TaskDirectory => ({ canOpen: () => false, open: () => {}, owned: () => [], act: async () => {}, pages: () => pages });

it('pins the session\'s goal above the conversation, with a team page, and adds no entry', async () => {
  const state = conversation(goal);
  const container = await render(<TaskDirectoryContext.Provider value={directory([page])}><AgentTimeline state={state} processMode="concise" /></TaskDirectoryContext.Provider>);
  const pinned = container.querySelector('.agent-pinned-lines')!;
  expect([...pinned.children].map(node => node.getAttribute('data-goal-line') !== null ? 'goal' : node.getAttribute('data-page-cards') !== null ? 'pages' : 'other')).toEqual(['goal', 'pages']);
  expect(pinned.compareDocumentPosition(container.querySelector('.agent-timeline-entries')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const bare = await render(<AgentTimeline state={conversation(undefined)} processMode="concise" />);
  expect(container.querySelectorAll('.agent-timeline-entry').length).toBe(bare.querySelectorAll('.agent-timeline-entry').length);
  expect(container.textContent).not.toContain('Goal: all tests pass');
});

it('changes the line where it stands when the goal is reported again, and draws none for a session without one', async () => {
  const container = await render(<AgentTimeline state={conversation(goal)} processMode="concise" />);
  const line = container.querySelector('[data-goal-line]')!;
  const entries = container.querySelectorAll('.agent-timeline-entry').length;
  await rerender(container, <AgentTimeline state={conversation({ ...goal, iterations: 3, status: 'paused', actions: [{ kind: 'resume', commandId: 'goal', args: 'resume' }] })} processMode="concise" />);
  expect(container.querySelector('[data-goal-line]')).toBe(line);
  expect(line.textContent).toContain('Paused · 3 checks');
  expect(container.querySelectorAll('.agent-timeline-entry').length).toBe(entries);
  await rerender(container, <AgentTimeline state={conversation(undefined)} processMode="concise" />);
  expect(container.querySelector('[data-goal-line]')).toBeNull();
  expect(container.querySelector('.agent-pinned-lines')).toBeNull();
});

it('hands an action to the host as the command the adapter named, and only reads when the host gives none', async () => {
  const onGoalAction = vi.fn(async () => {});
  const container = await render(<AgentTimeline state={conversation(goal)} processMode="concise" onGoalAction={onGoalAction} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-goal-action="clear"]')!.click());
  expect(onGoalAction).toHaveBeenCalledExactlyOnceWith('goal', 'clear');
  const readOnly = await render(<AgentTimeline state={conversation(goal)} processMode="concise" />);
  expect(readOnly.querySelector('[data-goal-action]')).toBeNull();
});
