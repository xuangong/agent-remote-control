import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render } from '../test/setup.js';
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
