import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

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

  it('keeps recovery state mounted while disabling native mutations', async () => {
    const state = {
      ...replicaState,
      pendingInteractions: [{
        kind: 'plan_approval' as const, requestId: 'plan-1', plan: 'Review this plan.',
        allowedActions: ['approve' as const, 'reject' as const],
      }],
      agent: {
        ...replicaState.agent!,
        status: 'running' as const,
        activeTurn: { turnId: 'turn-1', startedAt: '2026-09-17T00:00:00.000Z' },
        capabilities: {
          ...replicaState.agent!.capabilities,
          cancel: true, steer: true, commands: true, planning: true, sessionSettings: true,
        },
        runtimeInfo: {
          ...replicaState.agent!.runtimeInfo,
          connection: { state: 'reconnecting' as const, reason: 'transport_closed', attempt: 2 },
          planning: { active: false },
          settings: [{
            id: 'model', category: 'model' as const, label: 'Model', value: 'current', mutable: true,
            scope: 'session' as const, options: [{ value: 'current', label: 'Current' }, { value: 'next', label: 'Next' }],
          }],
        },
      },
    };
    const container = await render(<LabWorkbench
      state={state}
      sessionStatus="ready"
      messageDraft="Keep my recovery draft"
      actions={{
        sendMessage: vi.fn(), cancel: vi.fn(), setPlanning: vi.fn(),
        setSessionSetting: vi.fn(), listCommands: vi.fn(), executeCommand: vi.fn(),
        respondToInteraction: vi.fn(),
      }}
    />);

    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe('Reconnecting');
    expect(container.textContent).toContain('Native runtime is reconnecting. Changes are temporarily unavailable.');
    expect(container.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({
      disabled: true, value: 'Keep my recovery draft',
    });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="cancel-submit"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-action="approve"]')?.matches(':disabled')).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!.click());
    expect(container.querySelector<HTMLSelectElement>('[data-testid="session-setting-model"]')?.disabled).toBe(true);
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


it('collapses the input dock while preserving its draft and timeline', async () => {
  const container = await render(<LabWorkbench state={replicaState} sessionStatus="ready" messageDraft="Keep my draft" actions={{}} />);
  const input = container.querySelector('textarea')!;
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Hide message input"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  const body = container.querySelector<HTMLElement>('.lab-composer-body')!;
  expect(body.hidden).toBe(true);
  expect(toggle!.getAttribute('aria-label')).toBe('Show message input');
  expect(toggle!.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
  await act(async () => toggle!.click());
  expect(body.hidden).toBe(false);
  expect(container.querySelector('textarea')).toBe(input);
  expect(input.value).toBe('Keep my draft');
});
