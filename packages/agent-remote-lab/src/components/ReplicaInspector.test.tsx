import { describe, expect, it } from 'vitest';

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
