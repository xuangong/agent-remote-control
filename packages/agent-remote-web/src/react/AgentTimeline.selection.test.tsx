import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { appendSessionExcerpts, createSessionExcerpt, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay } from './TimelineDisplay.js';
import { SessionExcerptNavigation } from './SessionExcerpts.js';

function entry(seq: number, type: 'user_message' | 'assistant_message' | 'reasoning', text: string, extra: object = {}): ProjectedTimelineEntry {
  return { providerId: 'codex', turnId: `turn-${seq}`, item: { type, text, ...extra } as ProjectedTimelineEntry['item'], resources: [],
    timestamp: '2026-10-27T00:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [] };
}
function state(entries: ProjectedTimelineEntry[]) {
  const initial = createReplicaState();
  return { ...initial, timeline: { ...initial.timeline, initialized: true, epoch: 'epoch', entries } };
}
const tool = (seq: number): ProjectedTimelineEntry => ({ ...entry(seq, 'user_message', ''), item: { type: 'tool_call', callId: `call-${seq}`, name: 'shell', status: 'completed', detail: { type: 'shell', command: 'ls' }, result: null, error: null } as ProjectedTimelineEntry['item'] });

function Selectable({ entries, mode, onChange }: { entries: ProjectedTimelineEntry[]; mode: 'preview' | 'content'; onChange(keys: string[]): void }) {
  const [selected, setSelected] = useState<Set<string>>();
  return <TimelineDisplay.Provider value={mode}><AgentTimeline state={state(entries)} entrySelection={{ selected, label: 'Quote', select(keys, value) {
    const next = new Set(selected); for (const key of keys) if (value) next.add(key); else next.delete(key);
    setSelected(next); onChange([...next]);
  } }} /></TimelineDisplay.Provider>;
}
const message = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].find(node => node.textContent?.includes(text))!;

it.each(['preview', 'content'] as const)('starts a selection from a message, toggles messages and selects a range of the messages shown in %s mode', async mode => {
  const entries = [entry(1, 'user_message', 'First prompt'), entry(2, 'reasoning', 'Thinking'), tool(3), entry(4, 'assistant_message', 'First reply'),
    entry(5, 'user_message', 'Second prompt'), entry(6, 'assistant_message', 'Second reply'), entry(7, 'user_message', 'Withdrawn', { withdrawn: { reason: 'stopped' } })];
  const changes = vi.fn();
  const container = await render(<Selectable entries={entries} mode={mode} onChange={changes} />);
  expect(container.querySelectorAll('[aria-label="Quote this message"]')).toHaveLength(mode === 'content' ? 4 : 5);
  expect(container.querySelector('[role="checkbox"]')).toBeNull();
  await act(async () => message(container, 'First prompt').querySelector<HTMLButtonElement>('[aria-label="Quote this message"]')!.click());
  const seqs = () => (changes.mock.lastCall![0] as string[]).map(key => Number(key.split(':')[2])).sort((a, b) => a - b);
  expect(seqs()).toEqual([1]);
  // While selecting, every selectable message has a checkbox and starting actions are gone.
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(mode === 'content' ? 4 : 5);
  expect(container.querySelector('[aria-label="Quote this message"]')).toBeNull();
  await act(async () => message(container, 'Second reply').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  // The range covers what is shown: tool calls only outside content mode, reasoning and withdrawn input never.
  expect(seqs()).toEqual(mode === 'content' ? [1, 4, 5, 6] : [1, 3, 4, 5, 6]);
  await act(async () => message(container, 'Second prompt').querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  expect(seqs()).not.toContain(5);
  expect(message(container, 'Second prompt').querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('false');
  expect(message(container, 'Second reply').dataset.selected).toBe('true');
});

it('shows excerpts quoted into a user message as attachments that can open their source', async () => {
  const quoted = createSessionExcerpt({ id: 'excerpt', source: { hostId: 'host', providerId: 'claude', nativeSessionId: 'source', title: 'Design review' }, capturedAt: 'now',
    entries: [entry(1, 'user_message', 'Original question'), entry(2, 'assistant_message', 'Original answer'), entry(3, 'user_message', 'Skipped'), entry(4, 'assistant_message', 'Later answer')],
    selected: item => item.seqStart !== 3 });
  const open = vi.fn();
  const container = await render(<SessionExcerptNavigation.Provider value={open}>
    <AgentTimeline state={state([entry(1, 'user_message', appendSessionExcerpts('Compare with this.', [quoted]))])} />
  </SessionExcerptNavigation.Provider>);
  const bubble = container.querySelector('.agent-message-user')!;
  expect(bubble.querySelector('.agent-markdown')?.textContent).toBe('Compare with this.');
  expect(bubble.textContent).not.toContain('session-excerpt');
  expect(bubble.querySelector('summary')?.textContent).toBe('QuotedDesign review3 messages in 2 parts');
  expect([...bubble.querySelectorAll('.agent-session-excerpt-text')].map(node => node.textContent)).toEqual(['Original question', 'Original answer', 'Later answer']);
  await act(async () => bubble.querySelector<HTMLButtonElement>('.agent-session-excerpt-open')!.click());
  expect(open).toHaveBeenCalledWith(quoted.source);
});
