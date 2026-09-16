import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentChildSession, ProjectedTimelineEntry } from '@borgee/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

const child = (nativeSessionId: string, parentTurnId?: string): AgentChildSession => ({
  nativeSessionId, title: `Review ${nativeSessionId}`, role: 'Reviewer', description: 'Check the native flow',
  createdAt: '2026-09-10T00:00:00Z', parentTurnId, status: 'running', observation: 'live',
});
const entry = (seq: number, turnId: string, text: string): ProjectedTimelineEntry => ({
  providerId: 'codex', turnId, item: { type: 'assistant_message', text, messageId: `message-${seq}` },
  timestamp: '2026-09-10T00:00:00Z', seqStart: seq, seqEnd: seq,
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});
function state(children: AgentChildSession[], entries: ProjectedTimelineEntry[]): AgentReplicaState {
  return {
    ...createReplicaState(),
    agent: {
      id: 'parent', providerId: 'codex', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
      status: 'running', activeTurn: null, pendingInteractions: [],
      capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
      runtimeInfo: { providerId: 'codex', sessionId: 'native-parent', status: 'running', childSessions: children },
    },
    timeline: { epoch: 'epoch', initialized: true, entries, nextSeq: 10, hasOlder: false, pendingLive: [] },
  };
}

describe('AgentTimeline child sessions', () => {
  it('places children once below the last reply of their originating turn and opens the selected native chat', async () => {
    const selected: string[] = [];
    const entries = [entry(1, 'turn-one', 'Starting review'), entry(2, 'turn-one', 'Review underway'), entry(3, 'turn-two', 'Other reply')];
    const container = await render(<AgentTimeline state={state([child('one', 'turn-one')], entries)} onOpenChildSession={(item) => { selected.push(item.nativeSessionId); }} />);
    const rows = container.querySelectorAll<HTMLButtonElement>('[data-child-session-id]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closest('details')).toBeNull();
    expect(rows[0]!.closest('[data-entry-key]')?.textContent).toContain('Review underway');
    expect(rows[0]!.textContent).toContain('Reviewer');
    await act(async () => rows[0]!.click());
    expect(selected).toEqual(['one']);
    await rerender(container, <AgentTimeline state={state([child('one', 'turn-one')], [...entries, entry(4, 'turn-one', 'Review finished')])} />);
    expect(container.querySelectorAll('[data-child-session-id]')).toHaveLength(1);
    expect(container.querySelector('[data-child-session-id]')?.closest('[data-entry-key]')?.textContent).toContain('Review finished');
  });

  it('starts session subagents collapsed, preserves expansion during updates, and resets for another session', async () => {
    const selected: string[] = [];
    const initial = state([child('one')], []);
    const onOpen = (item: Pick<AgentChildSession, 'nativeSessionId'>) => { selected.push(item.nativeSessionId); };
    const container = await render(<AgentTimeline state={initial} onOpenChildSession={onOpen} />);
    const details = container.querySelector<HTMLDetailsElement>('details[aria-label="Session subagents"]');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe('Session subagents 1 1 working');
    await act(async () => details!.querySelector('summary')!.click());
    expect(details!.open).toBe(true);
    await act(async () => details!.querySelector<HTMLButtonElement>('[data-child-session-id]')!.click());
    expect(selected).toEqual(['one']);
    await rerender(container, <AgentTimeline state={state([{ ...child('one'), status: 'idle' }], [])} onOpenChildSession={onOpen} />);
    expect(container.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
    await rerender(container, <AgentTimeline state={{ ...initial, agent: { ...initial.agent!, id: 'another-parent' } }} />);
    expect(container.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
  });

  it('keeps unknown or unloaded origins separate and preserves creation order as statuses change', async () => {
    const first = child('first', 'unloaded');
    const second = { ...child('second'), createdAt: '2026-09-10T00:00:01Z' };
    const container = await render(<AgentTimeline state={state([second, first], [entry(1, 'other', 'Unrelated reply')])} />);
    expect(container.querySelector('[data-entry-key] [data-child-session-id]')).toBeNull();
    expect([...container.querySelectorAll('[data-child-session-id]')].map((row) => row.getAttribute('data-child-session-id'))).toEqual(['first', 'second']);
    await rerender(container, <AgentTimeline state={state([{ ...second, status: 'waiting' }, first], [entry(1, 'other', 'Unrelated reply')])} />);
    expect([...container.querySelectorAll('[data-child-session-id]')].map((row) => row.getAttribute('data-child-session-id'))).toEqual(['first', 'second']);
    expect(container.querySelector('[aria-label="Session subagents"]')?.textContent).toContain('Waiting for response');
  });
  it('uses the recorded creation call as origin without associating later calls with the child', async () => {
    const spawned = { ...child('review'), parentCallId: 'spawn-review' };
    const spawn = { ...entry(2, 'creation-turn', ''), item: { type: 'tool_call' as const, callId: 'spawn-review', name: 'spawn_agent', status: 'completed' as const, error: null, detail: { type: 'other' as const, description: 'Native collaboration' } } };
    const send = { ...entry(4, 'later-turn', ''), item: { type: 'tool_call' as const, callId: 'send-review', name: 'send_input', status: 'completed' as const, error: null, detail: { type: 'other' as const, description: 'Native collaboration' } } };
    const entries = [entry(1, 'creation-turn', 'Delegating review'), spawn, entry(3, 'later-turn', 'Checking progress'), send];
    const container = await render(<AgentTimeline state={state([spawned], entries)} />);
    expect(container.querySelector('[data-child-session-id]')?.closest('[data-entry-key]')?.textContent).toContain('Delegating review');
    await rerender(container, <AgentTimeline state={state([{ ...spawned, status: 'waiting' }], entries)} />);
    expect(container.querySelector('[data-child-session-id]')?.closest('[data-entry-key]')?.textContent).toContain('Delegating review');
  });

  it('moves an unloaded origin from the session area to its reply after older history arrives', async () => {
    const children = [child('first', 'old-turn'), child('second', 'old-turn')];
    const container = await render(<AgentTimeline state={state(children, [entry(3, 'new-turn', 'New reply')])} />);
    expect(container.querySelector('[aria-label="Session subagents"]')).not.toBeNull();
    await rerender(container, <AgentTimeline state={state([...children].reverse(), [entry(1, 'old-turn', 'Original reply'), entry(3, 'new-turn', 'New reply')])} />);
    expect(container.querySelector('[aria-label="Session subagents"]')).toBeNull();
    expect([...container.querySelectorAll('[data-child-session-id]')].map((row) => row.getAttribute('data-child-session-id'))).toEqual(['first', 'second']);
    expect(container.querySelector('[data-child-session-id]')?.closest('[data-entry-key]')?.textContent).toContain('Original reply');
  });

  it('opens a closed child with saved history and labels the observation honestly', async () => {
    const opened: string[] = [];
    const saved = { ...child('saved'), status: 'closed' as const, observation: 'saved_history' as const };
    const container = await render(<AgentTimeline state={state([saved], [])} onOpenChildSession={(item) => { opened.push(item.nativeSessionId); }} />);
    const button = container.querySelector<HTMLButtonElement>('[data-child-session-id]')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Closed');
    expect(button.textContent).toContain('Saved history');
    await act(async () => button.click());
    expect(opened).toEqual(['saved']);
  });

});

it('reports working children while collapsed and clears the indicator when they stop', async () => {
  const children = [child('working'), { ...child('ready'), status: 'idle' as const }, { ...child('question'), status: 'waiting' as const }];
  const container = await render(<AgentTimeline state={state(children, [])} />);
  const details = container.querySelector<HTMLDetailsElement>('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toContain('1 working');
  await act(async () => details.querySelector('summary')!.click());
  expect(details.querySelector('[data-child-session-id="working"]')?.textContent).toContain('Working');
  await rerender(container, <AgentTimeline state={state(children.map(item => ({ ...item, status: 'idle' })), [])} />);
  expect(details.querySelector('summary')?.textContent).not.toContain('working');
  expect(details.open).toBe(true);
});

it('retains known children when the active snapshot has no direct child metadata', async () => {
  const container = await render(<AgentTimeline state={state([], [])} childrenFor={id => id === 'native-parent' ? [child('known')] : []} />);
  expect(container.querySelector('[data-child-session-id="known"]')?.textContent).toContain('Review known');
  expect(container.querySelector('summary')?.textContent).toContain('1 working');
});
