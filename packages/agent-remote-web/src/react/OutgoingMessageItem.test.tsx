import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { OutgoingMessageItem } from './OutgoingMessageItem.js';

it('keeps failed text visible with manual retry and delete controls', async () => {
  const retry = vi.fn(async () => undefined); const remove = vi.fn();
  const container = await render(<OutgoingMessageItem message={{ id: 'failed', agentId: 'one', text: 'Do not lose my input', status: 'unconfirmed', epoch: 'epoch', afterSeq: 1 }} onRetry={retry} onDelete={remove} />);
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
  const container = await render(<OutgoingMessageItem message={{ id: 'images', agentId: 'one', text: 'before after', content: [{ type: 'text', text: 'before ' }, { type: 'image', attachmentId: 'opaque', label: 'image #9' }, { type: 'text', text: ' after' }], status: 'unconfirmed', epoch: 'epoch', afterSeq: 1 }}
    resourceContext={{ scopeKey: 'one', bindings: [], resources: {}, resolveResource: resolve, requestResource: async () => {} }} />);
  expect(container.querySelector('.agent-message-ordered-content')?.textContent).toBe('before [image #9] after');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Preview image #9"]')!.click());
  expect(resolve).toHaveBeenCalledWith('input-image:opaque', undefined);
  expect(container.textContent).toContain('not authorized');
});
