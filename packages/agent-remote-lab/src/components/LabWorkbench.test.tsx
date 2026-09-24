import { ToastProvider } from './Toast.js';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionControlNotice } from './SessionControlNotice.js';
import { LabWorkbench } from './LabWorkbench.js';

it('offers sign-in inside the permission panel while preserving the session and draft', async () => {
  window.history.replaceState(null, '', '/?host=studio&provider=codex&session=native-1&debug=1');
  const setSessionSetting = vi.fn<(id: string, value: string) => Promise<void>>().mockRejectedValueOnce(Object.assign(new Error('Sign in again before changing session permissions.'), { code: 'reauthentication_required' })).mockRejectedValueOnce(new Error('Provider unavailable.')).mockResolvedValue(undefined);
  const state = { ...replicaState, pendingInteractions: [], agent: { ...replicaState.agent!, status: 'idle' as const, activeTurn: null,
    capabilities: { ...replicaState.agent!.capabilities, sessionSettings: true },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, settings: [{ id: 'sandbox', category: 'permissions' as const, label: 'Sandbox', value: 'readOnly', mutable: true, scope: 'session' as const,
      options: [{ value: 'readOnly', label: 'Read only' }, { value: 'dangerFullAccess', label: 'Full access' }] }] } } };
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" messageDraft="Keep my draft" actions={{ setSessionSetting }} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="session-permissions-button"]')!.click());
  const select = container.querySelector<HTMLSelectElement>('[data-testid="session-setting-sandbox"]')!;
  await act(async () => { select.value = 'dangerFullAccess'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(setSessionSetting).toHaveBeenCalledExactlyOnceWith('sandbox', 'dangerFullAccess');
  const panel = container.querySelector('[aria-label="Permission settings"]')!;
  const signIn = panel.querySelector<HTMLAnchorElement>('.lab-reauthentication a');
  expect(signIn?.getAttribute('href')).toBe('/auth/login?reauthenticate=1&host=studio&provider=codex&session=native-1');
  expect(signIn?.textContent).toBe('Sign in again');
  expect(container.querySelectorAll('.lab-reauthentication')).toHaveLength(1);
  expect(panel.textContent).toContain('Return to this session, then retry your change.');
  expect(panel.textContent).not.toContain('Sign in again before changing session permissions.');
  signIn!.addEventListener('click', event => event.preventDefault());
  await act(async () => signIn!.click());
  expect(sessionStorage.getItem('agent-remote-sign-in-return')).toBe('/?host=studio&provider=codex&session=native-1');
  sessionStorage.removeItem('agent-remote-sign-in-return');
  expect(container.querySelector('.lab-conversation-status')?.textContent).toBe('Ready');
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.value).toBe('Keep my draft');
  expect(select.value).toBe('readOnly');
  expect(setSessionSetting).toHaveBeenCalledTimes(1);
  await act(async () => { select.value = 'dangerFullAccess'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(panel.querySelector('.lab-reauthentication')).toBeNull();
  expect(panel.querySelector('[role="alert"]')?.textContent).toBe('Provider unavailable.');
  await act(async () => { select.value = 'dangerFullAccess'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(setSessionSetting).toHaveBeenCalledTimes(3);
});

describe('LabWorkbench', () => {
  it.each([
    ['starting', 'connecting', 'Opening session'],
    ['idle', 'catching_up', 'Synchronizing'],
    ['idle', 'disconnected', 'Reconnecting'],
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
    if (sessionStatus !== 'ready') {
      expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe(expected);
      expect(container.querySelector('[data-testid="cancel-submit"]')?.matches(':disabled')).toBe(true);
    }
  });

  it('indicates a pending answer even before an Agent status change arrives', async () => {
    const state = { ...replicaState, pendingInteractions: [{ kind: 'plan_approval' as const, requestId: 'plan-1', plan: 'Review this plan.', allowedActions: ['approve' as const] }] };
    const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{}} />);
    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe('Waiting for response');
  });

  it.each([
    {
      connectionState: 'reconnecting' as const,
      heading: 'Reconnecting',
      notice: 'Native runtime is reconnecting. Changes are temporarily unavailable.',
      composerNotice: 'Native runtime is reconnecting. Your draft is preserved.',
    },
    {
      connectionState: 'restoring' as const,
      heading: 'Restoring',
      notice: 'Native runtime is restoring this session. Changes are temporarily unavailable.',
      composerNotice: 'Native runtime is restoring this session. Your draft is preserved.',
    },
    {
      connectionState: 'unavailable' as const,
      heading: 'Unavailable',
      notice: 'Native runtime is unavailable. Changes are unavailable.',
      composerNotice: 'Native runtime is unavailable. Your draft is preserved.',
    },
  ])('keeps $connectionState recovery mounted and restricts control operations', async ({ connectionState, heading, notice, composerNotice }) => {
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
          connection: { state: connectionState, reason: 'transport_closed', attempt: 2 },
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

    expect(container.querySelector('.lab-workbench-heading > span')?.textContent).toBe(heading);
    expect(container.textContent).toContain(notice);
    expect(container.textContent).toContain(composerNotice);
    expect(container.textContent).not.toContain('Open or attach to an Agent first.');
    expect(container.querySelector('[aria-label="Agent timeline"]')).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')).toMatchObject({
      disabled: false, value: 'Keep my recovery draft',
    });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')?.disabled).toBe(connectionState === 'unavailable');
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

    expect(container.textContent).toContain('Opening session remembered-agent');
    expect(container.textContent).not.toContain('Start with a Provider');
  });

  it('shows content loading after negotiation before the first snapshot', async () => {
    const container = await render(<LabWorkbench sessionStatus="catching_up" attachingAgentId="remembered-agent" actions={{}} />);
    expect(container.textContent).toContain('Loading conversation remembered-agent');
    expect(container.textContent).not.toContain('Connecting');
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


it('does not notify a late action failure in a different session', async () => {
  let reject!: (error: Error) => void;
  const sendMessage = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  function Sessions() {
    const [id, setId] = useState('first');
    return <ToastProvider><button onClick={() => setId('second')}>Switch session</button>
      <LabWorkbench state={{ ...replicaState, agent: { ...replicaState.agent!, id } }} sessionStatus="ready" actions={{ sendMessage }} />
    </ToastProvider>;
  }
  const container = await render(<Sessions />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Pending message');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  await act(async () => reject(new Error('Previous session failed.')));
  expect(container.querySelector('.lab-toast')).toBeNull();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it.each(['connecting', 'catching_up', 'disconnected', 'idle'] as const)('locks cached-session operations while %s without blocking a separate ready window', async status => {
  const pending = { kind: 'plan_approval' as const, requestId: 'approval', plan: 'Cached approval', allowedActions: ['approve' as const] };
  const state = { ...replicaState, agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities, cancel: true } }, pendingInteractions: [pending] };
  const send = vi.fn(async () => {}), cancel = vi.fn(async () => {}), approve = vi.fn(async () => {}), fork = vi.fn(async () => ({}));
  let synchronize!: () => void;
  function Harness() {
    const [current, setCurrent] = useState<typeof status | 'ready'>(status); synchronize = () => setCurrent('ready');
    return <><section data-window="pending"><LabWorkbench state={state} sessionStatus={current} messageDraft="/side"
      actions={{ sendMessage: send, cancel, respondToInteraction: approve }}
      consoleCommands={[{ id: 'console:side', name: 'side', kind: 'command', description: 'Side conversation' }]} onExecuteConsoleCommand={fork} /></section>
      <section data-window="ready"><LabWorkbench state={state} sessionStatus="ready" messageDraft="Ready window input" actions={{ sendMessage: send, respondToInteraction: approve }} /></section></>;
  }
  const container = await render(<Harness />);
  const pendingWindow = container.querySelector('[data-window="pending"]')!;
  const readyWindow = container.querySelector('[data-window="ready"]')!;
  expect(pendingWindow.querySelector('[aria-label="Pending interactions"]')).not.toBeNull();
  expect(pendingWindow.textContent).not.toContain('Interaction unavailable');
  expect(pendingWindow.textContent).toContain('Waiting for connection to respond.');
  expect(pendingWindow.querySelector('[data-action="approve"]')?.matches(':disabled')).toBe(true);
  expect(pendingWindow.textContent).toContain('Cached approval');
  expect(pendingWindow.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  expect(pendingWindow.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  expect(pendingWindow.querySelector('fieldset')!.disabled).toBe(true);
  expect(readyWindow.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  expect(readyWindow.querySelector('fieldset')!.disabled).toBe(false);
  await act(async () => {
    pendingWindow.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click();
    pendingWindow.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.click();
  });
  expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
  await act(async () => synchronize());
  expect(pendingWindow.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  expect(pendingWindow.querySelector('fieldset')!.disabled).toBe(false);
  await act(async () => pendingWindow.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(fork).toHaveBeenCalledWith('console:side', '');
});

it('keeps replay input read-only even when the recorded Agent can send and recover', async () => {
  const state = { ...replicaState, agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities, sendMessage: true },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, connection: { state: 'reconnecting' as const } } } };
  const container = await render(<LabWorkbench readOnly state={state} sessionStatus="disconnected" messageDraft="Recorded input" actions={{ sendMessage: async () => { throw new Error('Playback must not send'); } }} />);
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  expect(container.querySelector('[data-testid="prompt-input"]')?.getAttribute('placeholder')).toContain('read-only');
});

it('shows live read-only ownership, keeps the draft, and offers takeover without interrupting', async () => {
  const takeControl = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const state = { ...replicaState, sessionControl: { access: 'read_only' as const, available: false, revision: 'one' } };
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" messageDraft="Keep my draft"
    actions={{ takeControl, cancel, sendMessage: async () => {} }} />);
  expect(container.textContent).toContain('Read only');
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  expect(input.readOnly).toBe(true);
  expect(input.value).toBe('Keep my draft');
  expect(input.placeholder).not.toContain('recording');
  expect(container.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  const composer = container.querySelector('[aria-label="Live provider controls"]')!;
  expect(composer.textContent).toContain('Read only');
  expect(container.querySelector('.lab-workbench-heading')?.textContent).not.toContain('Take control');
  const button = [...composer.querySelectorAll('button')].find(button => button.textContent === 'Take control')!;
  await act(async () => button.click());
  expect(takeControl).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it('keeps the composer free of ownership notices when this page has control', async () => {
  const state = { ...replicaState, sessionControl: { access: 'control' as const, available: false, revision: 'two' } };
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{ takeControl: async () => {} }} />);
  expect(container.querySelector('.lab-session-control')).toBeNull();
  expect(container.textContent).not.toContain('Take control');
  expect(container.textContent).not.toContain('You have control');
});

it.each([
  ['web', 'Another page has control'],
  ['headless', 'Remote CLI has control'],
  ['unknown', 'Another client has control'],
  [undefined, 'Another client has control'],
] as const)('describes a %s owner without assuming it is a native CLI', async (ownerKind, label) => {
  const state = { ...replicaState, sessionControl: { access: 'read_only' as const, available: false, revision: 'one', ownerKind } };
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{ takeControl: async () => {} }} />);
  const composer = container.querySelector('[aria-label="Live provider controls"]')!;
  expect(composer.textContent).toContain(label);
  expect(composer.querySelector('.lab-session-control')?.textContent).not.toContain('Interrupt');
});

it('shows immediate native takeover in the chatbox and explains the interruption', async () => {
  const takeControl = vi.fn(async () => {});
  const state = {...replicaState,sessionControl:{access:'read_only' as const,available:false,revision:'r',nativeOwner:{kind:'native_cli' as const,generation:'native-generation'}}};
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{takeControl}} />);
  const composer = container.querySelector('[aria-label="Live provider controls"]')!;
  expect(composer.textContent).toContain('Native CLI');
  expect(composer.textContent).toContain('Interrupt & take over');
  expect(composer.textContent).not.toContain('safe');
  const button = [...composer.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='Interrupt and take control')!;
  await act(async()=>button.click()); expect(takeControl).toHaveBeenCalledOnce();
});

it('shows takeover for a cold target without enabling the previous conversation', async () => {
  const container = await render(<LabWorkbench sessionStatus="idle" actions={{}} nativeTakeover={<span>Target session is open in the CLI</span>} />);
  const composer=container.querySelector('[aria-label="Live provider controls"]')!;
  expect(composer.closest('[hidden]')).toBeNull();
  expect(composer.textContent).toContain('Target session');
  expect(container.querySelector('[data-testid="prompt-submit"]')).toBeNull();
});

it('keeps takeover reachable when the composer is collapsed and hides empty input chrome', async () => {
  const state = {...replicaState, sessionControl: {access: 'read_only' as const, available: false, ownerKind: 'web' as const}};
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" actions={{takeControl: async () => {}}} />);
  const input = container.querySelector('[data-testid="prompt-input"]')!;
  expect(input.closest('[hidden]')).not.toBeNull();
  expect(container.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide message input"]')!.click());
  expect(container.querySelector('.lab-session-control')!.closest('[hidden]')).toBeNull();
});

it('keeps takeover drafts selectable without allowing edits', async () => {
  const state = {...replicaState, sessionControl: {access: 'read_only' as const, available: false}};
  const container = await render(<LabWorkbench state={state} sessionStatus="ready" messageDraft="Keep and copy this" actions={{takeControl: async () => {}}} />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  expect(input.readOnly).toBe(true);
  expect(input.disabled).toBe(false);
  expect(input.value).toBe('Keep and copy this');
  expect(input.closest('[hidden]')).toBeNull();
});

it('checks uncertain native handoffs without sending another interruption and reports synchronization', async () => {
  let finish!: () => void;
  const calls: boolean[] = [];
  const control = {access: 'read_only' as const, available: false, nativeOwner: {kind: 'native_cli' as const, generation: 'native-one'}};
  const container = await render(<SessionControlNotice control={control} connected onTakeControl={async options => {
    calls.push(options?.checkOnly === true);
    if (!options?.checkOnly) throw Object.assign(new Error('No reply'), {code: 'native_handoff_unknown'});
    options.onRestoring?.();
    await new Promise<void>(resolve => {finish = resolve;});
  }} />);
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('not confirmed');
  expect(container.querySelector('button')!.textContent).toBe('Check status');
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(container.textContent).toContain('Restoring session');
  expect(calls).toEqual([false, true]);
  await act(async () => finish());
});
