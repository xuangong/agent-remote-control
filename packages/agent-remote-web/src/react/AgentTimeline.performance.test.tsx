import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState, reduceTimelineEvent } from '../replica/reducer.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

const renders = vi.hoisted(() => vi.fn());
vi.mock('./TimelineEntry.js', async original => {
  const module = await original<typeof import('./TimelineEntry.js')>();
  return { ...module, TimelineEntry: (props: Parameters<typeof module.TimelineEntry>[0]) => {
    renders(props.entryKey);
    return <module.TimelineEntry {...props} />;
  } };
});

describe('incremental timeline rendering', () => {
  it('renders only the changing reply while preserving historical rows and their actions', async () => {
    const entries: ProjectedTimelineEntry[] = Array.from({ length: 20 }, (_, index) => ({
      providerId: 'codex', seqStart: index + 1, seqEnd: index + 1, turnId: 'turn-' + index,
      timestamp: '2026-09-24T00:00:00Z', sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [],
      item: { type: 'assistant_message', messageId: String(index), text: `Reply ${index}` },
    }));
    const initial = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true, epoch: 'test', entries, nextSeq: 21 } };
    const inspect = vi.fn();
    const callbacks = () => ({
      onResourceResolve: async (locator: string) => ({ locator, resourceId: 'test', status: 'available' as const }),
      onResourceRequest: async () => {}, resolveSessionLink: () => undefined, childrenFor: () => [],
      onOpenChildSession: async () => {},
    });
    const container = await render(<AgentTimeline state={initial} onInspectEntry={inspect} {...callbacks()} />);
    renders.mockClear();
    const next = reduceTimelineEvent(initial, { protocolVersion: '1.6.0', type: 'agent_stream', payload: {
      agentId: 'agent', epoch: 'test', seq: 21, timestamp: '2026-09-24T00:00:01Z',
      event: { type: 'timeline', providerId: 'codex', turnId: 'turn-19', resources: [], item: { type: 'assistant_message', messageId: '19', text: ' continued' } },
    } }).state;
    const latestInspect = vi.fn();
    await rerender(container, <AgentTimeline state={next} onInspectEntry={latestInspect} {...callbacks()} />);
    expect(renders.mock.calls.map(call => call[0])).toEqual(['test:codex:20:19']);
    expect(container.textContent).toContain('Reply 19 continued');
    expect(container.querySelectorAll('.agent-timeline-entry')).toHaveLength(20);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Inspect event #1 in Trace"]')!.click());
    expect(latestInspect).toHaveBeenCalledWith('test:codex:1:0');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('does not repaint an expanded notice group when only the current assistant reply streams', async () => {
    const items: ProjectedTimelineEntry['item'][] = [
      { type: 'assistant_message', messageId: 'earlier', text: 'Earlier answer' },
      { type: 'error', message: 'First complete runtime diagnostic.' },
      { type: 'error', message: 'Second complete runtime diagnostic.' },
      { type: 'error', message: 'Third complete runtime diagnostic.' },
      { type: 'assistant_message', messageId: 'live', text: 'Current reply' },
    ];
    const entries: ProjectedTimelineEntry[] = items.map((item, index) => ({
      providerId: 'codex', seqStart: index + 1, seqEnd: index + 1, turnId: 'turn',
      timestamp: '2026-10-03T00:00:00Z', sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }],
      collapsed: [], resources: [], item,
    }));
    const base = createReplicaState();
    const initial = { ...base, timeline: { ...base.timeline, initialized: true, epoch: 'test', entries, nextSeq: 6 } };
    const inspect = vi.fn();
    const container = await render(<AgentTimeline state={initial} onInspectEntry={inspect} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.agent-notice-toggle')!.click());
    const historicalRows = [...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].slice(0, 4);
    expect(historicalRows).toHaveLength(4);
    renders.mockClear();
    const next = reduceTimelineEvent(initial, { protocolVersion: '1.6.0', type: 'agent_stream', payload: {
      agentId: 'agent', epoch: 'test', seq: 6, timestamp: '2026-10-03T00:00:01Z',
      event: { type: 'timeline', providerId: 'codex', turnId: 'turn', resources: [],
        item: { type: 'assistant_message', messageId: 'live', text: ' continues' } },
    } }).state;
    await rerender(container, <AgentTimeline state={next} onInspectEntry={inspect} />);
    expect(renders.mock.calls.map(([key]) => key)).toEqual(['test:codex:5:live']);
    expect(container.textContent).toContain('Current reply continues');
    expect(container.querySelector('.agent-notice-toggle')?.getAttribute('aria-expanded')).toBe('true');
    for (const row of historicalRows) {
      expect(container.querySelector(`[data-entry-key="${row.dataset.entryKey}"]`)).toBe(row);
    }
    expect([...container.querySelectorAll<HTMLParagraphElement>('.agent-notice-details')].every(detail => !detail.hidden)).toBe(true);
  });
});
