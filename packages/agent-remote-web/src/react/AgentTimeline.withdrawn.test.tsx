import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

function entry(seq: number, turnId: string | undefined, text: string, withdrawn = false): ProjectedTimelineEntry {
  return { providerId: 'claude', ...(turnId ? { turnId } : {}), item: { type: 'user_message', text, messageId: text, ...(withdrawn ? { withdrawn: { reason: 'stopped' as const } } : {}) }, resources: [],
    timestamp: '2026-10-21T00:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [] };
}
function state(entries: ProjectedTimelineEntry[]) {
  const initial = createReplicaState();
  return { ...initial, timeline: { ...initial.timeline, initialized: true, epoch: 'epoch', entries } };
}
afterEach(() => { vi.unstubAllGlobals(); });

it('shows withdrawn input as not sent and copies its text', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const container = await render(<AgentTimeline state={state([entry(1, 'turn', 'Run the tests'), entry(2, 'turn', 'Also update the README', true)])} />);
  const withdrawn = container.querySelector('.agent-message-withdrawn');
  expect(withdrawn?.getAttribute('aria-label')).toBe('User message, not sent');
  expect(withdrawn?.querySelector('[role="note"]')?.textContent).toContain('Not sent. The work was stopped before this message ran.');
  expect(container.querySelectorAll('.agent-message-withdrawn')).toHaveLength(1);
  await act(async () => (withdrawn!.querySelector('.agent-message-withdrawn-copy') as HTMLButtonElement).click());
  expect(writeText).toHaveBeenCalledWith('Also update the README');
  expect(withdrawn!.querySelector('.agent-message-withdrawn-copy')?.textContent).toBe('Copied');
});

it('never offers to rewind to withdrawn input', async () => {
  const container = await render(<AgentTimeline state={state([entry(1, 'turn', 'Stopped first', true), entry(2, 'next', 'Real prompt')])} onEditPrompt={async () => {}} />);
  const editable = [...container.querySelectorAll('[data-prompt-editable]')].map(node => node.querySelector('.agent-markdown')?.textContent);
  expect(editable).toEqual(['Real prompt']);
});
