import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay } from './TimelineDisplay.js';

function entry(seq: number, turnId: string, type: 'user_message' | 'assistant_message' | 'reasoning', text: string): ProjectedTimelineEntry {
  return { providerId: 'codex', turnId, item: type === 'reasoning' ? { type, text } : { type, text, messageId: text }, resources: [],
    timestamp: '2026-09-28T00:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [] };
}
function state(entries: ProjectedTimelineEntry[], hasOlder = false) {
  const initial = createReplicaState();
  return { ...initial, timeline: { ...initial.timeline, initialized: true, epoch: 'epoch', entries, hasOlder } };
}
function editable(container: HTMLElement) {
  return [...container.querySelectorAll('[data-prompt-editable]')].map(node => node.querySelector('.agent-message-user .agent-markdown')?.textContent);
}

it.each(['preview', 'content'] as const)('offers editing only for the first prompt per turn in %s mode', async mode => {
  const edit = vi.fn(async () => {});
  const prompt = entry(1, 'turn', 'user_message', 'First prompt');
  const initial = [prompt, entry(2, 'turn', 'assistant_message', 'Working')];
  const view = (entries: ProjectedTimelineEntry[]) => <TimelineDisplay.Provider value={mode}><AgentTimeline state={state(entries)} onEditPrompt={edit} /></TimelineDisplay.Provider>;
  const container = await render(view(initial));
  const updated = [...initial, entry(3, 'turn', 'user_message', 'Steer'), entry(4, 'next', 'user_message', 'Next prompt')];
  await rerender(container, view(updated));
  expect(editable(container)).toEqual(['First prompt', 'Next prompt']);
  expect(container.querySelectorAll('[data-prompt-editable]')[0]?.querySelectorAll('[data-prompt-edit-action]')).toHaveLength(2);
  await act(async () => (container.querySelector('[data-prompt-edit-action]') as HTMLButtonElement).click());
  expect(edit).toHaveBeenCalledWith(prompt);
  await rerender(container, view([...updated]));
  expect(editable(container)).toEqual(['First prompt', 'Next prompt']);
});

it('waits for older history before treating the first visible message as a turn boundary', async () => {
  const steer = entry(3, 'turn', 'user_message', 'Steer');
  const next = entry(4, 'next', 'user_message', 'Next prompt');
  const edit = vi.fn(async () => {});
  const container = await render(<AgentTimeline state={state([steer, next], true)} onEditPrompt={edit} />);
  expect(editable(container)).toEqual(['Next prompt']);
  await rerender(container, <AgentTimeline state={state([entry(1, 'turn', 'user_message', 'First prompt'), entry(2, 'turn', 'assistant_message', 'Working'), steer, next])} onEditPrompt={edit} />);
  expect(editable(container)).toEqual(['First prompt', 'Next prompt']);
});

it('does not mistake a prompt following loaded turn activity for a first prompt in content mode', async () => {
  const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline state={state([
    entry(1, 'turn', 'reasoning', 'Already working'), entry(2, 'turn', 'user_message', 'Steer'),
  ])} onEditPrompt={async () => {}} /></TimelineDisplay.Provider>);
  expect(editable(container)).toEqual([]);
});
