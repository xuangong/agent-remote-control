import { act, useState } from 'react';
import { expect, it } from 'vitest';
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
