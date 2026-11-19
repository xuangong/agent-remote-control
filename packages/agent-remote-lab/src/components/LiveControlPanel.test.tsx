import { act, useState } from 'react';
import { SESSION_CONNECTION_PATTERN } from '@orchardworks/agent-client/testing';
import { remoteSessionState } from '@orchardworks/agent-client';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LiveControlPanel } from './LiveControlPanel.js';

describe('LiveControlPanel', () => {
  it('sends Enter once, clears the editor at once and keeps it focused and enabled while the acknowledgement is pending', async () => {
    const acknowledgement = deferred<void>();
    const sendMessage = vi.fn(() => acknowledgement.promise);
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(replicaState, 'ready')} state={replicaState} onSendMessage={sendMessage} />);
    const input = container.querySelector('textarea')!;
    await type(input, '  A new message  ');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('A new message');
    expect(input.value).toBe('');
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    await type(input, 'Typed meanwhile');
    await act(async () => acknowledgement.resolve());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('Typed meanwhile');
    expect(document.activeElement).toBe(input);
  });

  it('allows newlines and IME confirmation without sending a message', async () => {
    const sendMessage = vi.fn();
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(replicaState, 'ready')} state={replicaState} onSendMessage={sendMessage} />);
    const input = container.querySelector('textarea')!;
    await type(input, '\u4f60\u597d');
    for (const init of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
      await act(async () => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(sendMessage).not.toHaveBeenCalled();
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(sendMessage).toHaveBeenCalledWith('\u4f60\u597d');
  });

  it('keeps a rejected message in the Check delivery queue chip, never replays it, and leaves the editor and cancel independent', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Try again.')).mockResolvedValue(undefined);
    const active = { ...replicaState, agent: { ...replicaState.agent!, activeTurn: { turnId: 'turn-1', startedAt: '2026-09-03T00:00:00.000Z' }, capabilities: { ...replicaState.agent!.capabilities, cancel: true } } };
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(active, 'ready')} state={active} onSendMessage={sendMessage} onCancel={async () => {}} />);
    const input = container.querySelector('textarea')!;
    await type(input, 'Keep my draft');
    await act(async () => (container.querySelector('[data-testid="prompt-submit"]') as HTMLButtonElement).click());
    await act(async () => {});
    const chip = () => container.querySelector('[data-testid="pending-send"]');
    expect(input.value).toBe('');
    expect(chip()?.textContent).toContain('Keep my draft');
    expect(chip()?.textContent).toContain('Check delivery');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Try again.');
    await act(async () => (container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement).click());
    expect(chip()?.textContent).toContain('Keep my draft');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => chip()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss message after checking delivery"]')!.click());
    expect(chip()).toBeNull();
  });

  it('isolates drafts and late command completion across Agent changes', async () => {
    const acknowledgement = deferred<void>();
    function Sessions() {
      const [id, setId] = useState('agent-1');
      return <><button onClick={() => setId(id === 'agent-1' ? 'agent-2' : 'agent-1')}>Switch Agent</button><LiveControlPanel sessionState={remoteSessionState({ ...replicaState, agent: { ...replicaState.agent!, id } }, 'ready')} state={{ ...replicaState, agent: { ...replicaState.agent!, id } }} onSendMessage={() => acknowledgement.promise} /></>;
    }
    const container = await render(<Sessions />);
    const input = container.querySelector('textarea')!;
    const switchAgent = container.querySelector('button')!;
    await type(input, 'Agent one draft');
    await act(async () => switchAgent.click());
    expect(input.value).toBe('');
    await type(input, 'Agent two draft');
    await act(async () => switchAgent.click());
    expect(input.value).toBe('Agent one draft');
    await act(async () => (container.querySelector('[data-testid="prompt-submit"]') as HTMLButtonElement).click());
    await act(async () => switchAgent.click());
    switchAgent.focus();
    expect(input.value).toBe('Agent two draft');
    expect(input.disabled).toBe(false);
    await act(async () => acknowledgement.resolve());
    expect(input.value).toBe('Agent two draft');
    expect(document.activeElement).toBe(switchAgent);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('submits text through the generic client callback and exposes unsupported controls', async () => {
    const sendMessage = vi.fn();
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(replicaState, 'ready')}
      state={replicaState}
      onSendMessage={sendMessage}
      onCancel={vi.fn()}
    />);
    const input = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setValue?.call(input, 'Continue through the shared stack.');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => (container.querySelector('[data-testid="prompt-submit"]') as HTMLButtonElement).click());

    expect(sendMessage).toHaveBeenCalledWith('Continue through the shared stack.');
    expect(container.querySelector('[data-testid="queue-submit"]')).toBeNull();
    expect((container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps message submission unavailable before an Agent Snapshot exists', async () => {
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(undefined, 'ready')} />);
    expect((container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement).disabled).toBe(true);
    expect(container.textContent).toContain('Open or attach to an Agent first.');
  });

  it.each(['reconnecting', 'restoring', 'unavailable'] as const)('keeps the draft and lets a send wait while the native runtime is %s, saying no connection word', async connectionState => {
    const state = {
      ...replicaState,
      agent: {
        ...replicaState.agent!,
        runtimeInfo: {
          ...replicaState.agent!.runtimeInfo,
          connection: { state: connectionState, reason: 'transport_closed' },
        },
      },
    };
    const onDraftChange = vi.fn();
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(state, 'ready')} state={state} draft="Keep my recovery draft" onDraftChange={onDraftChange} onSendMessage={vi.fn()} />);
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;

    expect(input).toMatchObject({ disabled: false, value: 'Keep my recovery draft', placeholder: 'Message…' });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
    await type(input, 'Edited while recovering');
    expect(onDraftChange).toHaveBeenLastCalledWith('Edited while recovering');
    expect(container.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
    expect(container.textContent).not.toContain('Open or attach to an Agent first.');
    expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Ready');
  });

  it('dispatches a send once, clears the editor and reports no success message while the acknowledgement is pending', async () => {
    const acknowledgement = deferred<void>();
    const sendMessage = vi.fn(() => acknowledgement.promise);
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(replicaState, 'ready')} state={replicaState} onSendMessage={sendMessage} />);
    const input = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Wait for Relay acknowledgement.');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));

    await act(async () => (container.querySelector('[data-testid="prompt-submit"]') as HTMLButtonElement).click());

    await act(async () => {});
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('Wait for Relay acknowledgement.');
    expect(input.value).toBe('');
    expect(container.textContent).not.toContain('Message sent.');

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(container.querySelector('[data-testid="pending-send"]')).toBeNull();
  });

  it('reports rejected shared client confirmations for send and cancel', async () => {
    const activeState = {
      ...replicaState,
      agent: {
        ...replicaState.agent!,
        status: 'running' as const,
        activeTurn: { turnId: 'turn-1', startedAt: '2026-09-03T00:00:00.000Z' },
        capabilities: { ...replicaState.agent!.capabilities, steer: true, cancel: true },
      },
    };
    const sendMessage = vi.fn(() => Promise.reject(new Error('Send was rejected.')));
    const cancel = vi.fn(() => Promise.reject(new Error('Cancel was rejected.')));
    const container = await render(<LiveControlPanel sessionState={remoteSessionState(activeState, 'ready')} state={activeState} onSendMessage={sendMessage} onCancel={cancel} />);
    const input = container.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Retry after rejection.');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));

    await act(async () => (container.querySelector('[data-testid="prompt-submit"]') as HTMLButtonElement).click());
    await act(async () => {});
    const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map(alert => alert.textContent).join(' | ');
    expect(alerts()).toContain('Send was rejected.');
    expect(container.querySelector('[data-testid="pending-send"]')?.textContent).toContain('Retry after rejection.');
    expect(container.textContent).not.toContain('Message sent.');

    await act(async () => (container.querySelector('[data-testid="cancel-submit"]') as HTMLButtonElement).click());
    expect(alerts()).toContain('Cancel was rejected.');
    expect(container.textContent).not.toContain('Turn cancellation requested.');
  });
});

async function type(input: HTMLTextAreaElement, value: string): Promise<void> {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve: (value) => resolve(value as T) };
}

it('offers console commands independently of provider capabilities and scopes both composers', async () => {
  const execute = vi.fn(async () => ({}));
  const command = { id: 'console:side', name: 'side', description: 'Open side chat', kind: 'command' as const, aliases: ['btw'] };
  const container = await render(<><LiveControlPanel sessionState={remoteSessionState(replicaState, 'ready')} state={replicaState} consoleCommands={[command]} onExecuteConsoleCommand={execute} />
    <LiveControlPanel sessionState={remoteSessionState(replicaState, 'ready')} state={replicaState} /></>);
  const inputs = container.querySelectorAll('textarea');
  expect(inputs[0]!.id).not.toBe(inputs[1]!.id);
  await type(inputs[0]!, '/btw explain');
  await act(async () => inputs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(execute).toHaveBeenCalledWith('console:side', ' explain');
});

it('updates direct input permissions without losing drafts or disabling console navigation', async () => {
  const send = vi.fn(async () => {});
  const execute = vi.fn(async () => ({}));
  const listCommands = vi.fn(async () => []);
  const command = { id: 'console:side', name: 'side', description: 'Open side chat', kind: 'command' as const };
  function Permissions() {
    const [readOnly, setReadOnly] = useState(false);
    return <><button onClick={() => setReadOnly((value) => !value)}>Toggle input permission</button>
      <LiveControlPanel sessionState={remoteSessionState({ ...replicaState, agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities, sendMessage: !readOnly, commands: true } } }, 'ready')} state={{ ...replicaState, agent: { ...replicaState.agent!, capabilities: { ...replicaState.agent!.capabilities, sendMessage: !readOnly, commands: true } } }}
        consoleCommands={[command]} onExecuteConsoleCommand={execute} onSendMessage={send} onListCommands={listCommands} />
    </>;
  }
  const container = await render(<Permissions />);
  const input = container.querySelector('textarea')!;
  await type(input, 'Keep this draft');
  await act(async () => container.querySelector('button')!.click());
  expect(input.disabled).toBe(true);
  expect(input.value).toBe('Keep this draft');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(send).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.click());
  expect(listCommands).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Loading native commands');
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(execute).toHaveBeenCalledWith('console:side', '');
  expect(input.value).toBe('Keep this draft');
  await act(async () => container.querySelector('button')!.click());
  expect(input.disabled).toBe(false);
  expect(container.textContent).not.toContain('This session is read-only.');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(send).toHaveBeenCalledExactlyOnceWith('Keep this draft');
});
