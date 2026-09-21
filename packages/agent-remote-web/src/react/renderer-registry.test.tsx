import { describe, expect, it, vi } from 'vitest';
import type {
  AgentStreamMessage,
  AgentTimelineItem,
  HistoryPage,
  ProjectedTimelineEntry,
} from '@orchardworks/agent-remote-protocol';

import {
  applyHistoryPage,
  createReplicaState,
  reduceTimelineEvent,
} from '../replica/reducer.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { RendererRegistry } from './renderer-registry.js';

function ThrowDuringRender(): never {
  throw new Error('Extension render failed');
}

function stateWithItems(items: readonly AgentTimelineItem[]) {
  return {
    ...createReplicaState(),
    timeline: {
      epoch: 'epoch-one', initialized: true, nextSeq: items.length + 1, hasOlder: false, pendingLive: [],
      entries: items.map((item, index) => ({
        providerId: 'provider-neutral', item,
        timestamp: `2026-09-02T00:00:0${index + 1}.000Z`, seqStart: index + 1, seqEnd: index + 1,
        sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [],
      })),
    },
  };
}

function stream(seq: number, item: AgentTimelineItem): AgentStreamMessage {
  return {
    protocolVersion: '1.5.0',
    type: 'agent_stream',
    payload: {
      agentId: 'agent-one', epoch: 'epoch-one', seq,
      timestamp: `2026-09-02T00:00:0${seq}.000Z`,
      event: { type: 'timeline', providerId: 'provider-neutral', item, resources: [] },
    },
  };
}

function page(entries: ProjectedTimelineEntry[], direction: HistoryPage['payload']['direction'] = 'tail'): HistoryPage {
  const end = entries.at(-1)?.seqEnd ?? 0;
  return {
    protocolVersion: '1.5.0',
    type: 'timeline_page',
    payload: {
      requestId: 'timeline-request', agentId: 'agent-one', direction, epoch: 'epoch-one',
      reset: false, staleCursor: false, gap: false,
      window: {
        minSeq: entries[0]?.seqStart ?? 0,
        maxSeq: direction === 'after' ? 2 : end,
        nextSeq: direction === 'after' ? 3 : end + 1,
      },
      startCursor: entries.length > 0 ? { epoch: 'epoch-one', seq: entries[0]?.seqStart ?? 0 } : null,
      endCursor: entries.length > 0 ? { epoch: 'epoch-one', seq: end } : null,
      hasOlder: false, hasNewer: false, entries, error: null,
    },
  };
}

function projectedTool(status: 'running' | 'completed'): ProjectedTimelineEntry {
  return {
    providerId: 'provider-neutral',
    item: {
      type: 'tool_call', callId: 'call-one', name: 'read', status, error: null,
      detail: { type: 'read', filePath: '/workspace/AGENTS.md' },
    },
    timestamp: '2026-09-02T00:00:01.000Z', seqStart: 1, seqEnd: 1,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
  };
}

describe('RendererRegistry', () => {
  it('isolates a reconciliation-time extension failure from the rest of the Timeline', async () => {
    const registry = new RendererRegistry();
    registry.register('assistant_message', () => <ThrowDuringRender />);
    const state = {
      ...createReplicaState(),
      timeline: {
        epoch: 'epoch-one', initialized: true, nextSeq: 3, hasOlder: false, pendingLive: [],
        entries: [{
          providerId: 'provider-neutral',
          item: { type: 'assistant_message' as const, text: 'Primary answer', messageId: 'answer' },
          timestamp: '2026-09-02T00:00:01.000Z', seqStart: 1, seqEnd: 1,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [],
        }, {
          providerId: 'provider-neutral',
          item: { type: 'user_message' as const, text: 'Timeline remains visible', messageId: 'prompt' },
          timestamp: '2026-09-02T00:00:02.000Z', seqStart: 2, seqEnd: 2,
          sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }], collapsed: [], resources: [],
        }],
      },
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const preventExpectedWindowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', preventExpectedWindowError);
    try {
      const container = await render(<AgentTimeline state={state} registry={registry} />);

      expect(container.textContent).toContain('Primary answer');
      expect(container.textContent).toContain('Timeline remains visible');
      expect(container.querySelector('.agent-extension-error')?.textContent).toBe('Detail renderer unavailable');
    } finally {
      window.removeEventListener('error', preventExpectedWindowError);
      consoleError.mockRestore();
    }
  });

  it('recovers only the replaced renderer while preserving other extensions', async () => {
    const registry = new RendererRegistry();
    registry.register('assistant_message', () => <ThrowDuringRender />);
    registry.register('user_message', () => <span>User extension remains available</span>);
    const state = stateWithItems([
      { type: 'assistant_message', text: 'Canonical answer', messageId: 'answer' },
      { type: 'user_message', text: 'Canonical prompt', messageId: 'prompt' },
    ]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const preventExpectedWindowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', preventExpectedWindowError);
    try {
      const container = await render(<AgentTimeline state={state} registry={registry} />);

      expect(container.querySelector('.agent-extension-error')).not.toBeNull();
      expect(container.textContent).toContain('User extension remains available');
      registry.register('assistant_message', () => <span>Assistant extension recovered</span>);
      await rerender(container, <AgentTimeline state={state} registry={registry} />);

      expect(container.textContent).toContain('Canonical answer');
      expect(container.textContent).toContain('Assistant extension recovered');
      expect(container.textContent).toContain('User extension remains available');
      expect(container.querySelector('.agent-extension-error')).toBeNull();
    } finally {
      window.removeEventListener('error', preventExpectedWindowError);
      consoleError.mockRestore();
    }
  });

  it('ignores reducer identity churn but retries after a semantic item update', async () => {
    const registry = new RendererRegistry();
    const renderer = vi.fn((item: AgentTimelineItem) => (
      item.type === 'tool_call' && item.status === 'running'
        ? <ThrowDuringRender />
        : <span>Extension rendered completed tool</span>
    ));
    registry.register('tool_call', renderer);
    const failedState = applyHistoryPage(createReplicaState(), page([projectedTool('running')])).state;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const preventExpectedWindowError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', preventExpectedWindowError);
    try {
      const container = await render(<AgentTimeline state={failedState} registry={registry} />);
      const callsAfterFailure = renderer.mock.calls.length;

      const unrelatedState = reduceTimelineEvent(failedState, stream(2, {
        type: 'assistant_message', text: 'Unrelated live event', messageId: 'other-answer',
      })).state;
      await rerender(container, <AgentTimeline state={unrelatedState} registry={registry} />);
      expect(renderer).toHaveBeenCalledTimes(callsAfterFailure);
      expect(container.textContent).toContain('Unrelated live event');
      expect(container.querySelector('.agent-extension-error')).not.toBeNull();

      const revisedState = applyHistoryPage(unrelatedState, page([projectedTool('completed')], 'after')).state;
      await rerender(container, <AgentTimeline state={revisedState} registry={registry} />);

      expect(container.textContent).toContain('Completed');
      expect(container.textContent).toContain('Extension rendered completed tool');
      expect(container.querySelector('.agent-extension-error')).toBeNull();
    } finally {
      window.removeEventListener('error', preventExpectedWindowError);
      consoleError.mockRestore();
    }
  });
});
