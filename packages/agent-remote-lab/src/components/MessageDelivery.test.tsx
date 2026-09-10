import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { LiveControlPanel } from './LiveControlPanel.js';

const active = { ...replicaState, agent: { ...replicaState.agent!, status: 'running' as const, activeTurn: { turnId: 'turn' }, capabilities: { ...replicaState.agent!.capabilities, steer: true, queueMessage: true } } };
async function type(container: HTMLElement, value: string) {
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('uses one ordinary send path in idle and busy sessions and exposes queue only while busy', async () => {
  const send = vi.fn(async () => {});
  function Session() {
    const [running, setRunning] = useState(false);
    return <><button onClick={() => setRunning(true)}>Start native turn</button><LiveControlPanel state={running ? active : replicaState} onSendMessage={send} /></>;
  }
  const container = await render(<Session />);
  expect(container.querySelector('[data-testid="queue-submit"]')).toBeNull();
  await type(container, 'Start');
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(send).toHaveBeenLastCalledWith('Start');
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  await type(container, 'Change direction now');
  await act(async () => container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(send).toHaveBeenLastCalledWith('Change direction now');
  expect(container.querySelector('[data-testid="steer-submit"]')).toBeNull();
  expect(container.querySelector('[data-testid="queue-submit"]')).not.toBeNull();
});

it('sends a next-turn intent to the native Provider, prevents duplicates and preserves rejected drafts', async () => {
  let reject!: (error: Error) => void;
  const send = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const container = await render(<LiveControlPanel state={active} onSendMessage={send} />);
  await type(container, 'Do this next');
  const queue = container.querySelector('[data-testid="queue-submit"]') as HTMLButtonElement;
  expect(queue).not.toBeNull();
  await act(async () => { queue.click(); queue.click(); });
  expect(send).toHaveBeenCalledExactlyOnceWith('Do this next', { delivery: 'next_turn' });
  expect(container.querySelector('textarea')?.disabled).toBe(true);
  await act(async () => reject(new Error('Native queue unavailable')));
  expect(container.querySelector('textarea')?.value).toBe('Do this next');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Native queue unavailable');
});

it('does not offer a synthetic queue for a Provider without native support or intercept Tab', async () => {
  const send = vi.fn();
  const container = await render(<LiveControlPanel state={{ ...active, agent: { ...active.agent, capabilities: { ...active.agent.capabilities, queueMessage: false } } }} onSendMessage={send} />);
  await type(container, 'Ordinary draft');
  expect(container.querySelector('[data-testid="queue-submit"]')).toBeNull();
  expect(container.querySelector('[data-testid="steer-submit"]')).toBeNull();
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => container.querySelector('textarea')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
