// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { OutgoingMessageItem } from './OutgoingMessageItem.js';

it('keeps failed text visible with manual retry and delete controls', async () => {
  const retry = vi.fn(async () => undefined); const remove = vi.fn();
  const container = await render(<OutgoingMessageItem message={{ id: 'failed', agentId: 'one', text: 'Do not lose my input', status: 'unconfirmed', afterKey: 'epoch-start:epoch' }} onRetry={retry} onDelete={remove} />);
  expect(container.textContent).toContain('Do not lose my input');
  expect(container.textContent).not.toContain('Disappears');
  expect(container.querySelector('[aria-label="Delivery error"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Retry message"]')!.click());
  expect(retry).toHaveBeenCalledWith('failed');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete message"]')!.click());
  expect(remove).toHaveBeenCalledWith('failed');
});

it('renders pending images in their original positions and uses authorized preview locators', async () => {
  const resolve = vi.fn(async () => { throw new Error('not authorized'); });
  const container = await render(<OutgoingMessageItem message={{ id: 'images', agentId: 'one', text: 'before after', content: [{ type: 'text', text: 'before ' }, { type: 'image', attachmentId: 'opaque', label: 'image #9' }, { type: 'text', text: ' after' }], status: 'unconfirmed', afterKey: 'epoch-start:epoch' }}
    resourceContext={{ scopeKey: 'one', bindings: [], resources: {}, resolveResource: resolve, requestResource: async () => {} }} />);
  expect(container.querySelector('.agent-message-ordered-content')?.textContent).toBe('before [image #9] after');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Preview image #9"]')!.click());
  expect(resolve).toHaveBeenCalledWith('input-image:opaque', undefined);
  expect(container.textContent).toContain('not authorized');
});

it('explains a retry the Host could not settle in plain words, as the message records it, rather than the Host\'s raw reply', async () => {
  const { RemoteOperationError } = await import('../client/transport.js');
  const raw = 'The operation may have reached the native runtime. Inspect native state before creating a new intent.';
  const guidance = 'This message may not have arrived. If it is not in the conversation, Retry sends it again.';
  const message = { id: 'unsure', agentId: 'one', text: 'Ship it', status: 'unconfirmed' as const, afterKey: 'epoch-start:epoch', error: 'Delivery is not confirmed. Check the conversation before sending again.' };
  // The client records the plain explanation on the message as the retry fails; the item shows that, not the Host's words.
  let rerender!: (next: typeof message) => Promise<void>;
  const retry = vi.fn(async () => { await rerender({ ...message, error: guidance }); throw new RemoteOperationError('operation_outcome_unknown', raw, true); });
  const host = document.createElement('div'); document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  rerender = async next => { await act(async () => root.render(<OutgoingMessageItem message={next} onRetry={retry} />)); };
  await rerender(message);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Retry message"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delivery error"]')!.click());
  expect(host.querySelector('.agent-delivery-error')?.textContent).toBe(guidance);
  expect(host.querySelector<HTMLElement>('[aria-label="Delivery error"]')!.title).toBe(guidance);
  expect(host.textContent).not.toContain('native runtime');
  await act(async () => root.unmount()); host.remove();
});
