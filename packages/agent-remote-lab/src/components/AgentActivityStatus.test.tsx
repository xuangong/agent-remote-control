import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LiveControlPanel } from './LiveControlPanel.js';

const startedAt = '2026-09-10T00:00:00.000Z';
const active = {
  ...replicaState,
  agent: {
    ...replicaState.agent!, status: 'running' as const,
    activeTurn: { turnId: 'turn-1', startedAt },
    capabilities: { ...replicaState.agent!.capabilities, cancel: true },
  },
};

describe('composer activity', () => {
  it('counts elapsed wall time from the received turn start, including after remount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:09:09.000Z'));
    try {
      const container = await render(<LiveControlPanel state={active} onCancel={async () => {}} />);
      expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Working');
      expect(container.querySelector('[data-testid="turn-elapsed"]')?.textContent).toBe('9m 09s');
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(container.querySelector('[data-testid="turn-elapsed"]')?.textContent).toBe('9m 11s');
      const restored = await render(<LiveControlPanel state={active} onCancel={async () => {}} />);
      expect(restored.querySelector('[data-testid="turn-elapsed"]')?.textContent).toBe('9m 11s');
    } finally { vi.useRealTimers(); }
  });

  it('keeps Working after interrupt acknowledgement until the native turn ends', async () => {
    let acknowledge!: () => void;
    const cancel = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    function Session() {
      const [running, setRunning] = useState(true);
      return <><button onClick={() => setRunning(false)}>Native turn ended</button><LiveControlPanel
        state={running ? active : { ...active, agent: { ...active.agent, status: 'idle', activeTurn: null } }}
        draft="Keep this draft" onCancel={cancel}
      /></>;
    }
    const container = await render(<Session />);
    const interrupt = container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement;
    expect(interrupt.textContent).toBe('Interrupt');
    await act(async () => { interrupt.click(); interrupt.click(); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(interrupt.disabled).toBe(true);
    expect(interrupt.textContent).toBe('Interrupting…');
    await act(async () => acknowledge());
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Working');
    expect(interrupt.textContent).toBe('Interrupt requested');
    expect(interrupt.disabled).toBe(true);
    expect(container.querySelector('textarea')?.value).toBe('Keep this draft');
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Ready');
    expect(container.querySelector('[data-testid="turn-elapsed"]')).toBeNull();
  });

  it('reports a rejected interrupt and allows retry', async () => {
    const cancel = vi.fn().mockRejectedValueOnce(new Error('Native interrupt rejected.')).mockResolvedValue(undefined);
    const container = await render(<LiveControlPanel state={active} onCancel={cancel} />);
    const interrupt = container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement;
    await act(async () => interrupt.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Native interrupt rejected.');
    expect(interrupt.disabled).toBe(false);
    await act(async () => interrupt.click());
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(interrupt.disabled).toBe(true);
  });

  it('does not present disconnected state as live or allow interrupt', async () => {
    const cancel = vi.fn();
    const container = await render(<LiveControlPanel state={active} disabled onCancel={cancel} />);
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Connection unavailable');
    expect(container.querySelector('[data-testid="turn-elapsed"]')).toBeNull();
    const interrupt = container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement;
    expect(interrupt.disabled).toBe(true);
    await act(async () => interrupt.click());
    expect(cancel).not.toHaveBeenCalled();
  });

  it('shows Working without inventing a start time when the timestamp is unavailable', async () => {
    const container = await render(<LiveControlPanel state={{ ...active, agent: { ...active.agent, activeTurn: { turnId: 'turn-1' } } }} />);
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Working');
    expect(container.querySelector('[data-testid="turn-elapsed"]')).toBeNull();
    expect(container.textContent).toContain('Start time unavailable');
  });

  it('keeps waiting distinct from Working while retaining interrupt capability', async () => {
    const container = await render(<LiveControlPanel state={{ ...active, agent: { ...active.agent, status: 'waiting' } }} onCancel={async () => {}} />);
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Waiting for response');
    expect((container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
