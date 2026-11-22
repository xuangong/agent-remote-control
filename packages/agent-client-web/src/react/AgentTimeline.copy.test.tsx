// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '@orchardworks/agent-client';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

function entry(seq: number, type: 'user_message' | 'assistant_message' | 'reasoning', text: string, extra: Record<string, unknown> = {}): ProjectedTimelineEntry {
  return { providerId: 'codex', turnId: 'turn', item: type === 'reasoning' ? { type, text } : { type, text, messageId: `m${seq}`, ...extra } as ProjectedTimelineEntry['item'], resources: [],
    timestamp: '2026-09-28T00:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [] };
}
function state(entries: ProjectedTimelineEntry[]) {
  const initial = createReplicaState();
  return { ...initial, timeline: { ...initial.timeline, initialized: true, epoch: 'epoch', entries, hasOlder: false } };
}
afterEach(() => { vi.unstubAllGlobals(); });

it('copies a sent message or a reply as its text, and offers no Copy on reasoning or a message that was not sent', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const container = await render(<AgentTimeline state={state([entry(1, 'user_message', 'Draft the notes'), entry(2, 'reasoning', 'Thinking'),
    entry(3, 'assistant_message', 'Here are the notes.'), entry(4, 'user_message', 'Stopped before it ran', { withdrawn: true })])} />);
  const copies = [...container.querySelectorAll<HTMLButtonElement>('[data-copy-action]')];
  // Each message has the action twice: beside the message for a mouse, beside the time for a touch screen.
  expect(copies.map(button => button.closest('[data-entry-key]')?.getAttribute('data-entry-key'))).toEqual([...new Set(copies.map(button => button.closest('[data-entry-key]')?.getAttribute('data-entry-key')))].flatMap(key => [key, key]));
  expect(new Set(copies.map(button => button.closest('[data-entry-key]')?.querySelector('.agent-markdown')?.textContent))).toEqual(new Set(['Draft the notes', 'Here are the notes.']));
  await act(async () => copies.at(-1)!.click());
  expect(writeText).toHaveBeenCalledWith('Here are the notes.');
  expect(copies.at(-1)!.getAttribute('aria-label')).toBe('Copied');
});
