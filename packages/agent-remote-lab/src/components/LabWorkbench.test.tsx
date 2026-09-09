import { describe, expect, it } from 'vitest';

import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LabWorkbench } from './LabWorkbench.js';

describe('LabWorkbench', () => {
  it.each([
    ['starting', 'connecting', 'Connecting'],
    ['idle', 'catching_up', 'Synchronizing'],
    ['idle', 'idle', 'Disconnected'],
    ['starting', 'ready', 'Starting'],
    ['closed', 'ready', 'Closed'],
    ['running', 'ready', 'Working'],
    ['waiting', 'ready', 'Waiting for response'],
    ['idle', 'ready', 'Ready'],
  ] as const)('reports %s Agent state with %s synchronization accurately', async (agentStatus, sessionStatus, expected) => {
    const state = { ...replicaState, agent: { ...replicaState.agent!, status: agentStatus } };
    const container = await render(<LabWorkbench state={state} sessionStatus={sessionStatus} actions={{}} />);
    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe(expected);
  });

  it('indicates a pending answer even before an Agent status change arrives', async () => {
    const state = { ...replicaState, pendingInteractions: [{ kind: 'plan_approval' as const, requestId: 'plan-1', plan: 'Review this plan.', allowedActions: ['approve' as const] }] };
    const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{}} />);
    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe('Waiting for response');
  });

  it('focuses the empty state on opening a Provider instead of showing an unavailable composer', async () => {
    const container = await render(<LabWorkbench sessionStatus="idle" actions={{}} />);

    expect(container.textContent).toContain('Start with a Provider');
    expect((container.querySelector('.lab-composer-dock') as HTMLElement).hidden).toBe(true);
  });

  it('names the Agent being attached instead of presenting a session-start empty state', async () => {
    const container = await render(<LabWorkbench sessionStatus="connecting" attachingAgentId="remembered-agent" actions={{}} />);

    expect(container.textContent).toContain('Connecting to remembered-agent');
    expect(container.textContent).not.toContain('Start with a Provider');
  });

  it('alerts with a generic connection failure before readiness and preserves the diagnostic', async () => {
    const state = {
      ...replicaState,
      diagnostics: [{ code: 'incompatible_protocol_version', message: 'Protocol version is incompatible.', recoverable: false }],
    };
    const container = await render(<LabWorkbench state={state} sessionStatus="connecting" actions={{}} />);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Agent connection failed');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Protocol version is incompatible.');
  });

  it('keeps Timeline synchronization reconnecting after a historical unrecoverable diagnosis', async () => {
    const state = {
      ...replicaState,
      diagnostics: [{ code: 'incompatible_protocol_version', message: 'Protocol version is incompatible.', recoverable: false }],
    };
    const container = await render(<LabWorkbench state={state} sessionStatus="disconnected" actions={{}} />);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Timeline synchronization is reconnecting.');
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('Agent connection failed');
    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe('Reconnecting');
  });

  it.each([
    ['Provider observation stream failed.', 'Provider observation stream failed.'],
    [undefined, 'The Agent did not provide a failure reason.'],
  ])('alerts with the failed Agent reason while retaining Timeline', async (lastError, expectedReason) => {
    const agent = replicaState.agent;
    if (!agent) throw new Error('The Workbench fixture requires an Agent Snapshot.');
    const state = {
      ...replicaState,
      agent: { ...agent, status: 'failed' as const, ...(lastError === undefined ? {} : { lastError }) },
    };
    const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{}} />);
    const alert = container.querySelector('[role="alert"]');

    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('Agent failed');
    expect(alert!.textContent).toContain(expectedReason);
    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe('Agent failed');
    expect(container.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
  });
});
