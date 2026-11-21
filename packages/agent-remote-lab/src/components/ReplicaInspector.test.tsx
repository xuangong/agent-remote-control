import { describe, expect, it } from 'vitest';

import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { ReplicaInspector } from './ReplicaInspector.js';
import { TraceView } from './TraceView.js';

describe('ReplicaInspector', () => {
  it('presents public snapshot, synchronization, capabilities, and diagnostics in Replica Inspector', async () => {
    const state = { ...replicaState, diagnostics: [{ code: 'timeline_recovery_failed', message: 'Retrying Timeline recovery.', recoverable: true }] };
    const container = await render(<ReplicaInspector state={state} sessionStatus="disconnected" providerName="Recorded semantic Provider" />);
    expect(container.querySelector('[aria-label="Replica Inspector"]')).not.toBeNull();
    expect(container.textContent).toContain('Agent Snapshot');
    expect(container.textContent).toContain('Timeline synchronization');
    expect(container.textContent).toContain('Declared capabilities');
    expect(container.textContent).toContain('timeline_recovery_failed');
    expect(container.textContent).toContain('Reconnecting');
  });

  it('reads a ready session as its status, connection, synchronization epoch and declared operations', async () => {
    const container = await render(<ReplicaInspector state={replicaState} sessionStatus="ready" providerName="Recorded semantic Provider" />);
    const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect(text('connection-status')).toBe('Ready');
    expect(text('session-status')).toBe('idle');
    expect(text('timeline-epoch')).toBe('epoch-1');
    expect(container.textContent).toContain('send message available');
    expect(container.textContent).toContain('question available');
    expect(container.textContent).toContain('steer unavailable');
  });

  it('lists one Trace row per normalized Timeline entry, in Timeline order', async () => {
    const kinds = [
      { type: 'user_message' as const, text: 'One' }, { type: 'assistant_message' as const, text: 'Two', messageId: 'two' },
      { type: 'reasoning' as const, text: 'Three' }, { type: 'todo' as const, items: [{ text: 'Four', completed: false }] },
    ];
    const state = { ...replicaState, timeline: { ...replicaState.timeline, entries: kinds.map((item, index) => ({
      providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-09-02T00:00:0' + index + '.000Z',
      sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [], item })) } };
    const container = await render(<TraceView state={state} />);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-trace-entry-key]')];
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.querySelector('.lab-trace-sequence')?.textContent)).toEqual(['#1', '#2', '#3', '#4']);
  });

  it('keeps Trace focused on normalized Timeline entries', async () => {
    const state = {
      ...replicaState,
      timeline: {
        ...replicaState.timeline,
        entries: [{
          providerId: 'recorded', seqStart: 6, seqEnd: 6,
          timestamp: '2026-09-02T00:00:05.000Z',
          sourceSeqRanges: [{ startSeq: 6, endSeq: 6 }], collapsed: [], resources: [],
          item: { type: 'assistant_message' as const, text: 'Visible tail.', messageId: 'tail' },
        }],
      },
    };
    const container = await render(<TraceView state={state} />);
    expect(container.querySelector('[aria-label="Normalized Timeline trace"]')).not.toBeNull();
    expect(container.textContent).toContain('Assistant message');
    expect(container.textContent).not.toContain('Agent Snapshot');
  });

  it('shows only public replica diagnostics and synchronization facts', async () => {
    const state = {
      ...replicaState,
      diagnostics: [{ code: 'timeline_recovery_failed', message: 'Timeline recovery failed.', recoverable: true }],
      retiredEpochs: ['epoch-old'],
    };
    const container = await render(<ReplicaInspector state={state} sessionStatus="ready" />);

    expect(container.textContent).toContain('epoch-1');
    expect(container.textContent).toContain('epoch-old');
    expect(container.textContent).toContain('timeline_recovery_failed');
    expect(container.textContent).toContain('6');
  });
});

describe('ReplicaInspector in Chinese', () => {
  it('words its headings and connection state in Chinese and keeps identifiers as they are', async () => {
    const state = { ...replicaState, diagnostics: [{ code: 'timeline_recovery_failed', message: 'Retrying Timeline recovery.', recoverable: true }] };
    const container = await render(<LocaleContext.Provider value="zh"><ReplicaInspector state={state} sessionStatus="disconnected" /></LocaleContext.Provider>);
    expect(container.querySelector('[aria-label="Replica Inspector"]')).not.toBeNull();
    expect(container.textContent).toContain('Agent 快照');
    expect(container.textContent).toContain('时间线同步');
    expect(container.textContent).toContain('重连中');
    expect(container.textContent).toContain('timeline_recovery_failed');
    expect(container.textContent).not.toContain('Timeline synchronization');
  });
});
