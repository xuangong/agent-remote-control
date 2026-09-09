import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { PlanningControl } from './PlanningControl.js';

const ready = {
  ...replicaState,
  agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities, planning: true }, runtimeInfo: { ...replicaState.agent!.runtimeInfo, planning: { active: false } } },
};

describe('PlanningControl', () => {
  it('waits for Provider state after command acknowledgement and then exposes the confirmed mode', async () => {
    const setPlanning = vi.fn().mockResolvedValue(undefined);
    function Host() {
      const [state, setState] = useState(ready);
      return <><PlanningControl state={state} sessionStatus="ready" onSetPlanning={setPlanning} /><button onClick={() => setState({ ...ready, agent: { ...ready.agent, runtimeInfo: { ...ready.agent.runtimeInfo, planning: { active: true } } } })}>Confirm</button></>;
    }
    const container = await render(<Host />);
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => { control.click(); control.click(); });
    expect(setPlanning).toHaveBeenCalledExactlyOnceWith(true);
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.disabled).toBe(true);
    expect(container.textContent).toContain('Waiting for Provider confirmation');
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Confirm')!.click());
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.disabled).toBe(false);
  });

  it.each([
    { label: 'running', state: { ...ready, agent: { ...ready.agent, status: 'running' as const } } },
    { label: 'active turn', state: { ...ready, agent: { ...ready.agent, activeTurn: { turnId: 'turn', startedAt: '2026-09-07T00:00:00Z' } } } },
    { label: 'pending interaction', state: { ...ready, pendingInteractions: [{ kind: 'plan_approval' as const, requestId: 'plan', plan: 'Plan', allowedActions: ['approve' as const] }] } },
    { label: 'Provider transition', state: { ...ready, agent: { ...ready.agent, runtimeInfo: { ...ready.agent.runtimeInfo, planning: { active: false, requested: true } } } } },
  ])('locks mode changes during $label', async ({ state }) => {
    const change = vi.fn();
    const container = await render(<PlanningControl state={state} sessionStatus="ready" onSetPlanning={change} />);
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
  });

  it('shows unsupported capability and keeps failed commands retryable without changing the mode', async () => {
    const unsupported = await render(<PlanningControl state={replicaState} sessionStatus="ready" onSetPlanning={async () => undefined} />);
    expect(unsupported.textContent).toContain('Planning is not supported');
    const change = vi.fn().mockRejectedValue(new Error('Provider refused'));
    const container = await render(<PlanningControl state={ready} sessionStatus="ready" onSetPlanning={change} />);
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => control.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Provider refused');
    expect(control.disabled).toBe(false);
    expect(control.getAttribute('aria-checked')).toBe('false');
  });
});
