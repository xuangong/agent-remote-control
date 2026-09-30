import { act, useState } from 'react';
import { CommunicationNavigationContext } from './CommunicationNavigation.js';
import { expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay, TimelineLettersVisible, type TimelineDisplayMode } from './TimelineDisplay.js';
import { createReplicaState } from '../replica/reducer.js';
import { findTimelineMatches } from '../client/timeline-search.js';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { TimelineItemRenderer } from './TimelineItemRenderer.js';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';

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

const envelopeHeader = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:';
function replyEntry(text: string): ProjectedTimelineEntry {
  return { providerId: 'codex', seqStart: 1, seqEnd: 1, timestamp: '2026-09-29T00:00:00Z',
    item: { type: 'agent_communication', messageId: 'reply', sender: '/root/review', recipient: '/root', text },
    resources: [], collapsed: [], sourceSeqRanges: [] };
}

it.each([true, false])('shows the letter title and payload with collapsed metadata (projected: %s)', async projected => {
  const entry = replyEntry(`${envelopeHeader}\nReview **complete**.`);
  const container = await render(<TimelineItemRenderer item={entry.item} entry={projected ? entry : undefined} />);
  const body = container.querySelector('.agent-letter-body')!;
  expect(body.textContent).toBe('Review complete.');
  expect(body.querySelector('strong')?.textContent).toBe('complete');
  const details = container.querySelector('details')!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.querySelector('.agent-letter-participants')).toBeNull();
  expect(details.querySelector('pre')?.textContent).toBe(envelopeHeader);
  const heading = container.querySelector('.agent-letter-heading')!;
  expect(heading.textContent).toBe('/root/review → /root');
  expect(heading.querySelector('.agent-letter-envelope')).not.toBeNull();
  expect(heading.closest('details')).toBeNull();
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(true);
  await act(async () => details.querySelector('summary')!.click());
  expect(details.open).toBe(false);
  expect(entry.item).toHaveProperty('text', `${envelopeHeader}\nReview **complete**.`);
});

it('keeps details interaction separate from letter navigation', async () => {
  const entry = replyEntry(`${envelopeHeader}\nReview complete.`);
  const open = vi.fn(async () => {});
  const container = await render(<CommunicationNavigationContext.Provider value={{ direction: () => undefined, open }}>
    <TimelineItemRenderer item={entry.item} entry={entry} />
  </CommunicationNavigationContext.Provider>);
  const details = container.querySelector('details')!;
  expect(details).not.toBeNull();
  await act(async () => details.querySelector('summary')!.click());
  await act(async () => details.querySelector('pre')!.click());
  expect(open).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLElement>('.agent-letter-body')!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith(entry);
});

it.each([
  ['inline payload', `${envelopeHeader} Review complete.`, 'Review complete.'],
  ['CRLF and indented code', `${envelopeHeader.replaceAll('\n', '\r\n')}\r\n    keep indentation`, 'keep indentation\n'],
  ['nested payload labels', `${envelopeHeader}\nPayload: Keep this label.`, 'Payload: Keep this label.'],
  ['empty payload', `${envelopeHeader}\n`, ''],
])('preserves %s', async (_name, text, expected) => {
  const entry = replyEntry(text!);
  const container = await render(<TimelineItemRenderer item={entry.item} entry={entry} />);
  expect(container.querySelector('.agent-letter-body')?.textContent).toBe(expected);
});

it.each([
  'Review this change.\nPayload: This is ordinary content.',
  'Message Type: FINAL_ANSWER\nTask name: /root\nPayload:\nMissing sender.',
  `${envelopeHeader.slice(0, -8)}Pay`,
  `Example:\n${envelopeHeader}\nKeep the whole example.`,
])('preserves unrecognized communication text: %s', async text => {
  const entry = replyEntry(text);
  const container = await render(<TimelineItemRenderer item={entry.item} entry={entry} />);
  expect(container.querySelector('.agent-letter-body')?.textContent?.replaceAll('\n', '')).toBe(text.replaceAll('\n', ''));
  expect(container.querySelector('details pre')).toBeNull();
});

it.each(['preview', 'simple', 'content'] as const)('toggles letters independently of %s mode without changing the replica', async (mode: TimelineDisplayMode) => {
  const letter = replyEntry('Agent reply.');
  const message = { ...letter, seqStart: 2, seqEnd: 2, item: { type: 'assistant_message' as const, text: 'Assistant answer.' } };
  const state = createReplicaState();
  state.timeline = { ...state.timeline, epoch: 'epoch', initialized: true, entries: [letter, message] };
  const key = timelineEntryKey('epoch', letter);
  const view = (visible: boolean, searchEntryKey?: string) => <TimelineDisplay.Provider value={mode}>
    <TimelineLettersVisible.Provider value={visible}><AgentTimeline state={state} searchEntryKey={searchEntryKey} inspectedEntryKey={key} /></TimelineLettersVisible.Provider>
  </TimelineDisplay.Provider>;
  const container = await render(view(true));
  expect(container.querySelectorAll('.agent-communication-letter')).toHaveLength(1);
  const assistant = container.querySelector('.agent-message-assistant');
  await rerender(container, view(false));
  expect(container.querySelector('.agent-communication-letter')).toBeNull();
  expect(container.querySelector('.agent-message-assistant')).toBe(assistant);
  expect(state.timeline.entries).toEqual([letter, message]);
  expect(findTimelineMatches('epoch', state.timeline.entries, 'Agent reply', 'all')).toHaveLength(1);
  await rerender(container, view(false, key));
  expect(container.querySelectorAll('.agent-communication-letter')).toHaveLength(1);
  await rerender(container, view(false));
  expect(container.querySelector('.agent-communication-letter')).toBeNull();
  await rerender(container, view(true));
  expect(container.querySelectorAll('.agent-communication-letter')).toHaveLength(1);
});
