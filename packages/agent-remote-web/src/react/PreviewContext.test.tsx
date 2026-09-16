import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { render, rerender } from '../test/setup.js';
import type { HttpPreviewClient, PreviewRegistration, PreviewSnapshot } from '../client/preview-client.js';
import { PreviewProvider, usePreviewController } from './PreviewContext.js';

it('loads authoritative Host previews and synchronizes registration mutations', async () => {
  const snapshots: PreviewSnapshot[] = [{ epoch: 'host-one', revision: 1, registrations: [] }];
  const registration = activeRegistration();
  const client = {
    snapshot: vi.fn(async () => snapshots.at(-1)!),
    register: vi.fn(async () => { snapshots.push({ epoch: 'host-one', revision: 2, registrations: [registration] }); return registration; }),
    unregister: vi.fn(async () => ({ ...registration, status: 'unregistered' as const })),
    open: vi.fn(async () => 'https://preview.test/entry'),
  } as unknown as HttpPreviewClient;
  const container = await render(<PreviewProvider client={client} hostId="host-one" canManage><Probe /></PreviewProvider>);
  await act(async () => Promise.resolve());
  expect(container.textContent).toContain('0 previews');

  await act(async () => container.querySelector<HTMLButtonElement>('[data-action="register"]')?.click());
  expect(container.textContent).toContain('1 previews');
  expect(client.snapshot).toHaveBeenCalledTimes(2);
});

it('ignores a snapshot that completes after the provider switches Hosts', async () => {
  const hostOne = deferred<PreviewSnapshot>();
  const hostTwo = deferred<PreviewSnapshot>();
  const client = {
    snapshot: vi.fn((hostId: string) => hostId === 'host-one' ? hostOne.promise : hostTwo.promise),
  } as unknown as HttpPreviewClient;
  const container = await render(<PreviewProvider client={client} hostId="host-one" canManage><Probe /></PreviewProvider>);

  await rerender(container, <PreviewProvider client={client} hostId="host-two" canManage><Probe /></PreviewProvider>);
  await act(async () => hostTwo.resolve({ epoch: 'host-two', revision: 1, registrations: [activeRegistration('preview-two')] }));
  expect(container.textContent).toContain('preview-two');

  await act(async () => hostOne.resolve({ epoch: 'host-one', revision: 1, registrations: [activeRegistration('preview-one')] }));
  expect(container.textContent).toContain('preview-two');
  expect(container.textContent).not.toContain('preview-one');
});

it('keeps the newest snapshot when requests for one Host complete out of order', async () => {
  const first = deferred<PreviewSnapshot>();
  const second = deferred<PreviewSnapshot>();
  const client = {
    snapshot: vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise),
  } as unknown as HttpPreviewClient;
  const container = await render(<PreviewProvider client={client} hostId="host-one" canManage><Probe /></PreviewProvider>);

  await act(async () => container.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click());
  await act(async () => second.resolve({ epoch: 'host-one', revision: 2, registrations: [activeRegistration('preview-two')] }));
  expect(container.textContent).toContain('preview-two');

  await act(async () => first.resolve({ epoch: 'host-one', revision: 1, registrations: [activeRegistration('preview-one')] }));
  expect(container.textContent).toContain('preview-two');
  expect(container.textContent).not.toContain('preview-one');
});

function Probe() {
  const controller = usePreviewController();
  if (!controller) return null;
  return <><span>{controller.registrations.length} previews:{controller.registrations.map(item => item.id).join(',')}</span><button data-action="register" onClick={() => void controller.register('agent', { target: 'http://localhost:5173', itemId: 'one' })}>Register</button><button data-action="refresh" onClick={() => void controller.refresh()}>Refresh</button></>;
}

function activeRegistration(id = 'preview-one'): PreviewRegistration {
  return { id, target: 'http://localhost:5173', status: 'active', createdAt: '2026-09-16T00:00:00Z',
    expiresAt: '2026-09-16T01:00:00Z', revision: 2, pathMode: 'strip', sources: [{ sessionId: 'agent', itemId: 'one' }], availability: 'online' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
