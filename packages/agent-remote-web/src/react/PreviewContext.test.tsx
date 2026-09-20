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

it('aborts a stalled snapshot and resumes automatic refreshing after its deadline', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const client = { snapshot: vi.fn()
    .mockImplementationOnce((_host: string, pendingSignal: AbortSignal) => {
      signal = pendingSignal;
      return new Promise((_resolve, reject) => pendingSignal?.addEventListener('abort', () => reject(pendingSignal.reason)));
    })
    .mockResolvedValue({ epoch: 'one', revision: 1, registrations: [activeRegistration()] }),
  } as unknown as HttpPreviewClient;
  try {
    const container = await render(<PreviewProvider client={client} hostId="host" canManage><Probe /></PreviewProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('preview-one');
  } finally { vi.useRealTimers(); }
});

it('cancels pending snapshot requests when switching Hosts or unmounting', async () => {
  const signals: AbortSignal[] = [];
  const client = { snapshot: vi.fn((_host: string, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
  }) } as unknown as HttpPreviewClient;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe /></PreviewProvider>);
  await rerender(container, <PreviewProvider client={client} hostId="two" canManage><Probe /></PreviewProvider>);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  await rerender(container, <></>);
  expect(signals[1]?.aborted).toBe(true);
});

function activeRegistration(id = 'preview-one'): PreviewRegistration {
  return { id, target: 'http://localhost:5173', status: 'active', createdAt: 1_789_516_800_000,
    expiresAt: 1_789_520_400_000, revision: 2, pathMode: 'strip', sources: [{ sessionId: 'agent', itemId: 'one' }], availability: 'online' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

it('does not poll while the page is hidden and refreshes once on return', async () => {
  vi.useFakeTimers();
  let visibility = 'visible';
  const property = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const client = { snapshot: vi.fn(async () => ({ epoch: 'one', revision: 1, registrations: [] })) } as unknown as HttpPreviewClient;
  try {
    await render(<PreviewProvider client={client} hostId="host-one" canManage><Probe /></PreviewProvider>);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  } finally { property.mockRestore(); vi.useRealTimers(); }
});

it('uses a quiet interval until preview controls are opened', async () => {
  vi.useFakeTimers();
  const client = { snapshot: vi.fn(async () => ({ epoch: 'one', revision: 1, registrations: [] })) } as unknown as HttpPreviewClient;
  try {
    const container = await render(<PreviewProvider client={client} hostId="host" canManage polling={false}><Probe /></PreviewProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    await rerender(container, <PreviewProvider client={client} hostId="host" canManage polling><Probe /></PreviewProvider>);
    expect(client.snapshot).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(client.snapshot).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});
