import { act, useState } from 'react';
import { CommunicationNavigationContext } from './CommunicationNavigation.js';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay } from './TimelineDisplay.js';
import { createReplicaState } from '../replica/reducer.js';
import { findTimelineMatches } from '../client/timeline-search.js';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

it('shows attributed agent tasks in content mode without user edit actions', async () => {
  const entry: ProjectedTimelineEntry = { providerId: 'codex', seqStart: 1, seqEnd: 1, turnId: 'turn', timestamp: '2026-09-29T00:00:00Z',
    item: { type: 'agent_communication', messageId: 'amsg-task', sender: '/root', recipient: '/root/review', text: 'Review **this change**.' },
    resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }] };
  const state = createReplicaState();
  state.timeline = { ...state.timeline, initialized: true, epoch: 'epoch', entries: [entry] };
  const edit = vi.fn();
  const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline state={state} onEditPrompt={edit} /></TimelineDisplay.Provider>);
  const message = container.querySelector('[aria-label="Agent communication"]');
  expect(message?.textContent).toContain('/root → /root/review');
  expect(message?.querySelector('strong')?.textContent).toBe('this change');
  expect(container.querySelector('.agent-edit-prompt')).toBeNull();
  expect(findTimelineMatches('epoch', [entry], 'Review', 'all')).toHaveLength(1);
  expect(findTimelineMatches('epoch', [entry], 'Review', 'messages')).toHaveLength(0);
});

it('keeps a letter in its timeline entry while direction changes and opens it once', async () => {
  const entry: ProjectedTimelineEntry = { providerId: 'codex', seqStart: 1, seqEnd: 1, turnId: 'turn', timestamp: '2026-09-29T00:00:00Z',
    item: { type: 'agent_communication', messageId: 'letter', sender: 'sender', recipient: 'recipient', text: 'Hello.' }, resources: [], collapsed: [], sourceSeqRanges: [] };
  const state = createReplicaState(); state.timeline = { ...state.timeline, epoch: 'epoch', entries: [entry] };
  let finish!: () => void;
  const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  function Harness() {
    const [direction, setDirection] = useState<'right'>();
    return <><button onClick={() => setDirection('right')}>Show receiver</button><CommunicationNavigationContext.Provider value={{ direction: () => direction, open }}><AgentTimeline state={state} /></CommunicationNavigationContext.Provider></>;
  }
  const container = await render(<Harness />);
  const timelineEntry = container.querySelector('[data-entry-key]');
  const letter = container.querySelector('.agent-communication-letter');
  expect(letter?.getAttribute('data-direction')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('[data-entry-key]')).toBe(timelineEntry);
  expect(container.querySelector('.agent-communication-letter')).toBe(letter);
  expect(letter?.getAttribute('data-direction')).toBe('right');
  await act(async () => { container.querySelector<HTMLButtonElement>('.agent-letter-open')!.click(); container.querySelector<HTMLButtonElement>('.agent-letter-open')!.click(); });
  expect(open).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledWith(entry);
  await act(async () => finish());
});
