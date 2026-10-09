import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { AgentSessionSettingChange } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { remoteSessionState } from '../client/session-state.js';
import { AgentSessionSettings, type SessionControlView } from './AgentSessionSettings.js';

const state: AgentReplicaState = { ...createReplicaState(), agent: {
  id: 'session', providerId: 'test', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
  pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle', model: 'Test model' },
} };

function Controls() {
  const [view, setView] = useState<SessionControlView>();
  return <AgentSessionSettings state={state} disabled={false} busy={false} view={view} onView={setView} onPendingChange={() => {}} />;
}

it.each(['page', 'dialog'] as const)('Escape dismisses only the focused settings among controls composed in the same %s', async surface => {
  const container = await render(<div role={surface === 'dialog' ? 'dialog' : undefined}><Controls /><Controls /></div>);
  const triggers = container.querySelectorAll<HTMLButtonElement>('[data-testid="session-model-button"]');
  for (const trigger of triggers) await act(async () => { trigger.focus(); trigger.click(); });
  expect([...triggers].map(trigger => trigger.getAttribute('aria-expanded'))).toEqual(['true', 'true']);

  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => triggers[1]!.dispatchEvent(escape));
  expect([...triggers].map(trigger => trigger.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  expect(document.activeElement).toBe(triggers[1]);
  expect(escape.defaultPrevented).toBe(true);
});

it('leaves Escape available to the outer composition when focus has moved outside the settings', async () => {
  const container = await render(<><Controls /><button type="button">Outer action</button></>);
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!;
  const outer = container.querySelector<HTMLButtonElement>(':scope > button')!;
  await act(async () => { trigger.focus(); trigger.click(); outer.focus(); });
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => outer.dispatchEvent(escape));
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(outer);
  expect(escape.defaultPrevented).toBe(false);
});

it('dismisses settings from another control in the same composer without affecting other composers', async () => {
  const container = await render(<>{[0, 1].map(index => <section key={index} className="agent-composer">
    <Controls /><button type="button" aria-label={`Composer action ${index}`}>/</button>
  </section>)}</>);
  const triggers = container.querySelectorAll<HTMLButtonElement>('[data-testid="session-model-button"]');
  for (const trigger of triggers) await act(async () => { trigger.focus(); trigger.click(); });
  const action = container.querySelector<HTMLButtonElement>('[aria-label="Composer action 1"]')!;
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { action.focus(); action.dispatchEvent(escape); });
  expect([...triggers].map(trigger => trigger.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  expect(document.activeElement).toBe(triggers[1]);
  expect(escape.defaultPrevented).toBe(true);
});

it('shows usage only inside Session status and keeps it readable during read-only and disconnected states', async () => {
  const replica: AgentReplicaState = { ...state, timeline: { ...state.timeline, initialized: true },
    agent: { ...state.agent!, lastUsage: { tokenScope: 'session', totalTokens: 12_345 } } };
  const props = { state: replica, disabled: false, busy: false, readOnly: true, onView() {}, onPendingChange() {} };
  const container = await render(<AgentSessionSettings {...props} view="model" />);
  expect(container.querySelector('[aria-label="Session tokens"]')).toBeNull();

  await rerender(container, <AgentSessionSettings {...props} view="status" />);
  const status = container.querySelector('[aria-label="Session status"]')!;
  expect(status.querySelector('[aria-label="Session tokens"] data')?.getAttribute('value')).toBe('12345');
  expect(status.querySelector('.agent-session-usage-stale')).toBeNull();

  await rerender(container, <AgentSessionSettings {...props} disabled view="status" />);
  expect(status.querySelector('[aria-label="Session tokens"] data')?.getAttribute('value')).toBe('12345');
  expect(status.querySelector('.agent-session-usage-stale')?.textContent).toBe('Last known');
  expect(status.querySelector('.agent-session-usage [disabled]')).toBeNull();

  await rerender(container, <AgentSessionSettings {...props} view="status" sessionState={{ ...remoteSessionState(replica, 'ready'), runtime: { state: 'restoring' } }} />);
  expect(status.querySelector('[aria-label="Session tokens"] data')?.getAttribute('value')).toBe('12345');
  expect(status.querySelector('.agent-session-usage-stale')?.textContent).toBe('Last known');
});

it('preserves native session settings alongside usage updates and reconnecting snapshots', async () => {
  let replica: AgentReplicaState = { ...state, timeline: { ...state.timeline, initialized: true }, agent: { ...state.agent!,
    lastUsage: { tokenScope: 'session', totalTokens: 100 },
    runtimeInfo: { ...state.agent!.runtimeInfo, model: 'gpt-6-astra', settings: [
      { id: 'model', category: 'model', label: 'Model', value: 'gpt-6-astra', options: [{ value: 'gpt-6-astra', label: 'GPT-6-Astra' }], mutable: true, scope: 'session' },
      { id: 'effort', category: 'model', label: 'Reasoning effort', value: 'ultra', options: [{ value: 'ultra', label: 'ultra' }], mutable: true, scope: 'session' },
      { id: 'approval', category: 'permissions', label: 'Approval policy', value: 'never', options: [{ value: 'never', label: 'Never ask' }], mutable: true, scope: 'session' },
      { id: 'sandbox', category: 'permissions', label: 'Sandbox', value: 'dangerFullAccess', options: [{ value: 'dangerFullAccess', label: 'Full access' }], mutable: true, scope: 'session' },
    ] },
  } };
  const props = { disabled: false, busy: false, view: 'status' as const, onView() {}, onPendingChange() {} };
  const container = await render(<AgentSessionSettings {...props} state={replica} />);
  const status = container.querySelector('[aria-label="Session status"]')!;
  const expected = [['Model', 'GPT-6-Astra'], ['Reasoning effort', 'ultra'], ['Approval policy', 'Never ask'], ['Sandbox', 'Full access']];
  const assertSettings = () => {
    for (const [label, value] of expected) {
      const term = [...status.querySelectorAll('dt')].find(item => item.textContent === label)!;
      expect(term.nextElementSibling?.textContent).toBe(value);
      expect(term.compareDocumentPosition(status.querySelector('.agent-session-usage')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  };
  assertSettings();
  for (const connection of ['ready', 'connecting', 'ready'] as const) {
    replica = { ...replica, agent: { ...replica.agent!, lastUsage: { tokenScope: 'session', totalTokens: 150 } } };
    await rerender(container, <AgentSessionSettings {...props} state={replica} sessionState={remoteSessionState(replica, connection)} />);
    assertSettings();
    expect(status.querySelector('[aria-label="Session tokens"] data')?.getAttribute('value')).toBe('150');
    expect(status.querySelector('.agent-session-usage-stale') !== null).toBe(connection === 'connecting');
  }
});

const modelChange: AgentSessionSettingChange = {
  settingId: 'model', category: 'model', label: 'Model', requestId: 'change-model', targetValue: 'model-b', confirmedValue: 'model-a', status: 'pending',
  requestedAt: '2026-10-09T00:00:00Z', deadlineAt: '2026-10-09T00:00:30Z',
};
function settingsState(changes: AgentSessionSettingChange[] = []): AgentReplicaState {
  return { ...state, timeline: { ...state.timeline, initialized: true }, agent: { ...state.agent!, settingChanges: changes,
    capabilities: { ...state.agent!.capabilities, sessionSettings: true },
    runtimeInfo: { ...state.agent!.runtimeInfo, model: 'model-a', settings: [
      { id: 'model', category: 'model', label: 'Model', value: 'model-a', options: [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }], mutable: true, scope: 'session' },
      { id: 'approval', category: 'permissions', label: 'Approval policy', value: 'ask', options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }], mutable: true, scope: 'session' },
    ] },
  } };
}
function Settings({ replica, onSelect = async () => {}, onPendingChange = () => {} }: {
  replica: AgentReplicaState; onSelect?(id: string, value: string): Promise<void>; onPendingChange?(pending: boolean): void;
}) {
  const [view, setView] = useState<SessionControlView>();
  return <AgentSessionSettings state={replica} disabled={false} busy={false} view={view} onView={setView} onSelect={onSelect} onPendingChange={onPendingChange} />;
}

it('shows shared pending targets in every settings surface and allows selecting the confirmed value again', async () => {
  const replica = settingsState([modelChange]);
  const onSelect = vi.fn(async () => {}); const onPendingChange = vi.fn();
  const container = await render(<><Settings replica={replica} onSelect={onSelect} onPendingChange={onPendingChange} /><Settings replica={replica} /></>);
  const buttons = container.querySelectorAll<HTMLButtonElement>('[data-testid="session-model-button"]');
  for (const button of buttons) {
    expect(button.textContent).toContain('Model B');
    expect(button.getAttribute('aria-label')).toContain('pending');
    await act(async () => button.click());
  }
  const selects = container.querySelectorAll<HTMLSelectElement>('select[aria-label="Model"]');
  expect([...selects].map(select => [select.value, select.disabled])).toEqual([['model-b', false], ['model-b', false]]);
  expect(onPendingChange).not.toHaveBeenCalled();
  await act(async () => { selects[0]!.value = 'model-a'; selects[0]!.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('model', 'model-a');
  expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  expect(replica.agent!.runtimeInfo.settings![0]!.value).toBe('model-a');
});

it.each(['failed', 'timed_out'] as const)('restores confirmed values after %s and clears only the opened category notification', async status => {
  const changes: AgentSessionSettingChange[] = [
    { ...modelChange, status, message: 'Model change could not be confirmed.' },
    { ...modelChange, settingId: 'approval', category: 'permissions', label: 'Approval policy', requestId: 'change-permissions', targetValue: 'allow', confirmedValue: 'ask', status, message: 'Permission change could not be confirmed.' },
  ];
  const replica = settingsState(changes);
  replica.agent!.runtimeInfo.settings![0]!.value = null;
  const container = await render(<Settings replica={replica} />);
  const model = container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!;
  const permissions = container.querySelector<HTMLButtonElement>('[data-testid="session-permissions-button"]')!;
  expect(model.textContent).toContain('Model A');
  expect(model.getAttribute('aria-label')).toContain('unread');
  expect(permissions.getAttribute('aria-label')).toContain('unread');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => model.click());
  expect(model.getAttribute('aria-label')).not.toContain('unread');
  expect(permissions.getAttribute('aria-label')).toContain('unread');
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!.value).toBe('model-a');
  expect(container.querySelector('[aria-label="Model settings"]')!.textContent).toContain('Model change could not be confirmed.');
  await act(async () => model.click());
  expect(model.getAttribute('aria-label')).not.toContain('unread');
  await act(async () => permissions.click());
  expect(permissions.getAttribute('aria-label')).not.toContain('unread');
});

it('updates normal values on late native confirmation and shows a new unread outcome for a newer request', async () => {
  const failed = { ...modelChange, status: 'timed_out' as const };
  let replica = settingsState([failed]);
  const container = await render(<Settings replica={replica} />);
  const button = container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!;
  await act(async () => { button.click(); });
  await act(async () => { button.click(); });
  replica = settingsState([failed]);
  replica.agent!.runtimeInfo.settings![0]!.value = 'model-b';
  await rerender(container, <Settings replica={replica} />);
  expect(button.textContent).toContain('Model B');
  expect(button.getAttribute('aria-label')).not.toContain('pending');
  expect(button.getAttribute('aria-label')).not.toContain('unread');
  await rerender(container, <Settings replica={settingsState([{ ...failed, requestId: 'new-change' }])} />);
  expect(button.getAttribute('aria-label')).toContain('unread');
});

it('keeps sign-in recovery for public permission failures inside the matching panel', async () => {
  const replica = settingsState([{ ...modelChange, settingId: 'approval', category: 'permissions', label: 'Approval policy', requestId: 'permissions', status: 'failed', code: 'reauthentication_required', message: 'Sign in again.' }]);
  const renderError = vi.fn((error: unknown) => (error as {code?: string}).code === 'reauthentication_required' ? <button>Sign in again</button> : null);
  const props = { state: replica, disabled: false, busy: false, onView() {}, onPendingChange() {}, renderError };
  const container = await render(<AgentSessionSettings {...props} view="model" />);
  expect(container.textContent).not.toContain('Sign in again');
  await rerender(container, <AgentSessionSettings {...props} view="permissions" />);
  expect(renderError).toHaveBeenCalledWith(expect.objectContaining({ code: 'reauthentication_required' }));
  expect(container.querySelector('[aria-label="Permission settings"]')!.textContent).toContain('Sign in again');
});

it('clears pending presentation after confirmation without holding local submission busy', async () => {
  let accept!: () => void;
  const onSelect = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
  const onPendingChange = vi.fn();
  const container = await render(<Settings replica={settingsState()} onSelect={onSelect} onPendingChange={onPendingChange} />);
  const button = container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!;
  await act(async () => button.click());
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
  await act(async () => { select.value = 'model-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onPendingChange.mock.calls).toEqual([[true]]);
  await rerender(container, <Settings replica={settingsState([modelChange])} onSelect={onSelect} onPendingChange={onPendingChange} />);
  expect(select.value).toBe('model-b');
  await act(async () => accept());
  expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  expect(select.disabled).toBe(false);
  expect(select.closest('[data-setting-state="pending"]')).not.toBeNull();
  const confirmed = settingsState();
  confirmed.agent!.runtimeInfo.settings![0]!.value = 'model-b';
  await rerender(container, <Settings replica={confirmed} onSelect={onSelect} onPendingChange={onPendingChange} />);
  expect(select.value).toBe('model-b');
  expect(select.closest('[data-setting-state="pending"]')).toBeNull();
  expect(button.getAttribute('aria-label')).toBe('Model');
  expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
});

it('retains local admission error recovery without fabricating a public pending change', async () => {
  const error = Object.assign(new Error('Recent sign-in required.'), { code: 'reauthentication_required' });
  const renderError = vi.fn(() => <button>Sign in</button>);
  const onPendingChange = vi.fn();
  const container = await render(<AgentSessionSettings state={settingsState()} disabled={false} busy={false} view="permissions" onView={() => {}}
    onPendingChange={onPendingChange} onSelect={async () => { throw error; }} renderError={renderError} />);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Approval policy"]')!;
  await act(async () => { select.value = 'allow'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(renderError).toHaveBeenCalledWith(error);
  expect(container.querySelector('[aria-label="Permission settings"]')!.textContent).toContain('Sign in');
  expect(select.value).toBe('ask');
  expect(select.closest('[data-setting-state="pending"]')).toBeNull();
  expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
});

it('reads outcomes arriving in the open category and isolates read state across sessions', async () => {
  const container = await render(<Settings replica={settingsState([modelChange])} />);
  const button = container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!;
  await act(async () => button.click());
  const failed = settingsState([{ ...modelChange, status: 'failed', message: 'Native model change failed.' }]);
  await rerender(container, <Settings replica={failed} />);
  expect(button.getAttribute('aria-label')).not.toContain('unread');
  expect(container.querySelector('[aria-label="Model settings"]')!.textContent).toContain('Native model change failed.');
  await act(async () => button.click());
  expect(button.getAttribute('aria-label')).not.toContain('unread');
  const otherSession = { ...failed, agent: { ...failed.agent!, id: 'other-session' } };
  await rerender(container, <Settings replica={otherSession} />);
  expect(button.getAttribute('aria-label')).toContain('unread');
  await act(async () => button.click());
  await act(async () => button.click());
  await rerender(container, <Settings replica={failed} />);
  expect(button.getAttribute('aria-label')).not.toContain('unread');
});

it.each(['pending', 'failed', 'timed_out'] as const)('retains %s requests after the native setting descriptor disappears', async status => {
  const change: AgentSessionSettingChange = { ...modelChange, settingId: 'reasoning_effort', category: 'model', label: 'Reasoning effort', targetValue: 'high', confirmedValue: 'medium', status,
    ...(status === 'pending' ? {} : {message: 'The selected model no longer supports this setting.'}),
  };
  const replica = settingsState([change]);
  const container = await render(<Settings replica={replica} />);
  const model = container.querySelector<HTMLButtonElement>('[data-testid="session-model-button"]')!;
  expect(model.getAttribute('aria-label')).toContain(status === 'pending' ? 'pending' : 'unread');
  await act(async () => model.click());
  const panel = container.querySelector('[aria-label="Model settings"]')!;
  expect(panel.textContent).toContain('Reasoning effort');
  expect(panel.querySelector('select[aria-label="Reasoning effort"]')).toBeNull();
  if (status === 'pending') {
    expect(panel.textContent).toContain('high');
    expect(panel.textContent).toContain('Current: medium');
  } else {
    expect(panel.textContent).toContain('The selected model no longer supports this setting.');
    expect(model.getAttribute('aria-label')).not.toContain('unread');
    await act(async () => model.click());
    expect(model.getAttribute('aria-label')).not.toContain('unread');
  }
});

it('keeps sign-in recovery visible when a failed permission descriptor disappears', async () => {
  const replica = settingsState([{ ...modelChange, settingId: 'removed_approval', category: 'permissions', label: 'Native tool approvals', status: 'failed', code: 'reauthentication_required', message: 'Sign in again.' }]);
  const renderError = vi.fn(() => <button>Restore sign-in</button>);
  const container = await render(<AgentSessionSettings state={replica} disabled={false} busy={false} view="permissions" onView={() => {}} onPendingChange={() => {}} renderError={renderError} />);
  const panel = container.querySelector('[aria-label="Permission settings"]')!;
  expect(panel.textContent).toContain('Native tool approvals');
  expect(panel.textContent).toContain('Restore sign-in');
  expect(panel.querySelector('select[aria-label="Native tool approvals"]')).toBeNull();
});
