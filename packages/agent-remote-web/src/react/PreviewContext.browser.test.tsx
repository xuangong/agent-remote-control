import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { render, rerender, unmount } from '../test/setup.js';
import { HttpPreviewClient } from '../client/preview-client.js';
import { PreviewDock, PreviewProvider, usePreviewController, type PreviewContextValue } from './PreviewContext.js';

vi.mock('./PreviewBrowser.js', () => ({
  PreviewBrowser: ({ url, error, visible, onMinimize }: { url?: string; error?: string; visible: boolean; onMinimize(): void }) =>
    <section data-browser data-visible={visible} data-url={url} data-error={error}><button onClick={onMinimize}>Minimize</button></section>,
}));

it('reuses pending and loaded previews through an earlier registration callback', async () => {
  const request = deferred<string>();
  const client = previewClient(vi.fn(() => request.promise));
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  const open = controller.open;
  let pending!: Promise<string>;
  await act(async () => {
    pending = open('preview', 'http://localhost:5173', 'agent');
    void open('preview', 'http://localhost:5173', 'agent');
  });
  expect(client.open).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="Session previews"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-browser] button')!.click());
  await act(async () => { request.resolve('entry'); await pending; });
  expect(container.querySelector('[data-browser]')?.getAttribute('data-visible')).toBe('false');
  const browser = container.querySelector('[data-browser]');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-preview-key]')!.click());
  expect(container.querySelector('[data-browser]')).toBe(browser);
  expect(browser?.getAttribute('data-visible')).toBe('true');
  expect(container.querySelector('[aria-label="Session previews"]')).toBeNull();
  await act(async () => { await open('preview', 'http://localhost:5173', 'agent'); });
  expect(client.enter).toHaveBeenCalledTimes(1);
});

it('ignores an open callback retained by a registration from a previous Host', async () => {
  const client = previewClient(vi.fn(async () => 'entry'));
  let controller!: PreviewContextValue;
  const children = <Probe capture={value => controller = value} />;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage>{children}</PreviewProvider>);
  const oldOpen = controller.open;
  await rerender(container, <PreviewProvider client={client} hostId="two" canManage>{children}</PreviewProvider>);
  await act(async () => { await controller.open('new', 'http://localhost:5173', 'agent'); });
  const browser = container.querySelector('[data-browser]');
  await act(async () => { await oldOpen('old', 'http://localhost:5173', 'agent'); });
  expect(client.open).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-browser]')).toBe(browser);
  expect(browser?.getAttribute('data-visible')).toBe('true');
});

it('aborts a closed pending preview and ignores its result after reopening', async () => {
  const oldEntry = deferred<string>();
  const newEntry = deferred<string>();
  const client = previewClient(vi.fn().mockImplementationOnce(() => oldEntry.promise).mockImplementationOnce(() => newEntry.promise));
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  let oldPending!: Promise<string>;
  let newPending!: Promise<string>;
  await act(async () => { oldPending = controller.open('preview', 'http://localhost:5173', 'agent'); });
  const oldSignal = vi.mocked(client.open).mock.calls[0]![3]!;
  await act(async () => container.querySelector<HTMLButtonElement>('[data-browser] button')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Close preview"]')!.click());
  expect(oldSignal.aborted).toBe(true);
  expect(container.querySelector('[data-browser]')).toBeNull();
  await act(async () => { newPending = controller.open('preview', 'http://localhost:5173', 'agent'); });
  await act(async () => { newEntry.resolve('new-entry'); await newPending; });
  await act(async () => { oldEntry.resolve('old-entry'); await oldPending; });
  expect(container.querySelector('[data-browser]')?.getAttribute('data-url')).toBe('new-entry');
  expect(client.enter).toHaveBeenCalledTimes(1);
});

function Probe({ capture }: { capture(value: PreviewContextValue): void }) {
  capture(usePreviewController()!);
  return <PreviewDock sessionId="agent" />;
}

function previewClient(open: ReturnType<typeof vi.fn>): HttpPreviewClient {
  return { snapshot: vi.fn(async () => ({ registrations: [] })), open, enter: vi.fn(async (entry: string) => entry), renew: vi.fn(async () => { throw new Error('Offline'); }) } as unknown as HttpPreviewClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}


it('renews retained previews while minimized, deduplicates sessions, and stops on close or manual unregister', async () => {
  vi.useFakeTimers();
  let now = Date.now();
  let registration = { id: 'preview', target: 'http://localhost:5173', status: 'active' as 'active' | 'unregistered',
    createdAt: now, expiresAt: now + 6000, revision: 1, pathMode: 'strip', sources: [], availability: 'online' };
  const renew = vi.fn(async () => { registration = { ...registration, expiresAt: Date.now() + 6000 }; return registration; });
  const client = { ...previewClient(vi.fn(async () => 'entry')), snapshot: vi.fn(async () => ({ registrations: [registration] })), renew } as unknown as HttpPreviewClient;
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  try {
    await act(async () => { await controller.open('preview', registration.target, 'agent'); });
    expect(renew).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-browser] button')!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(renew.mock.calls.length).toBeGreaterThan(1);
    expect(registration.expiresAt).toBeGreaterThan(now + 6000);
    await act(async () => { await controller.open('preview', registration.target, 'second-agent'); });
    const before = renew.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(renew).toHaveBeenCalledTimes(before + 1);
    registration = { ...registration, status: 'unregistered' };
    await act(async () => { await controller.refresh(); });
    const stopped = renew.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(renew).toHaveBeenCalledTimes(stopped);
    await unmount(container);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(renew).toHaveBeenCalledTimes(stopped);
  } finally { await unmount(container); vi.useRealTimers(); }
});


it('renews on browser wake and aborts a pending renewal when its last retained browser closes', async () => {
  vi.useFakeTimers();
  const registration = { id: 'preview', target: 'http://localhost:5173', status: 'active', createdAt: Date.now(),
    expiresAt: Date.now() + 3600000, revision: 1, pathMode: 'strip', sources: [], availability: 'online' };
  const request = deferred<typeof registration>();
  const renew = vi.fn().mockResolvedValueOnce(registration).mockImplementationOnce(() => request.promise);
  const client = { ...previewClient(vi.fn(async () => 'entry')), snapshot: vi.fn(async () => ({ registrations: [registration] })), renew } as unknown as HttpPreviewClient;
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  try {
    await act(async () => { await controller.open('preview', registration.target, 'agent'); });
    expect(renew).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event('pageshow')));
    expect(renew).toHaveBeenCalledTimes(2);
    const signal = renew.mock.calls[1]![3] as AbortSignal;
    await act(async () => container.querySelector<HTMLButtonElement>('[data-browser] button')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Close preview"]')!.click());
    expect(signal.aborted).toBe(true);
    await act(async () => { request.resolve(registration); await vi.advanceTimersByTimeAsync(600000); });
    expect(container.querySelector('[data-browser]')).toBeNull();
    expect(renew).toHaveBeenCalledTimes(2);
  } finally { await unmount(container); vi.useRealTimers(); }
});


it('continues renewing when the independent snapshot refresh stalls', async () => {
  vi.useFakeTimers();
  const registration = { id: 'preview', target: 'http://localhost:5173', status: 'active', createdAt: Date.now(),
    expiresAt: Date.now() + 6000, revision: 1, pathMode: 'strip', sources: [], availability: 'online' };
  const snapshot = deferred<{ registrations: typeof registration[] }>();
  const renew = vi.fn(async () => ({ ...registration, expiresAt: Date.now() + 6000 }));
  const client = { ...previewClient(vi.fn(async () => 'entry')), snapshot: vi.fn().mockResolvedValueOnce({ registrations: [registration] }).mockImplementation(() => snapshot.promise), renew } as unknown as HttpPreviewClient;
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  try {
    await act(async () => { await controller.open('preview', registration.target, 'agent'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(renew.mock.calls.length).toBeGreaterThan(1);
  } finally { await unmount(container); snapshot.resolve({ registrations: [] }); vi.useRealTimers(); }
});

it('renews retained browsers omitted from the active list and stops after confirmed removal', async () => {
  vi.useFakeTimers();
  const registration = { id: 'preview', target: 'http://localhost:5173', status: 'active', createdAt: Date.now(),
    expiresAt: Date.now() + 6000, revision: 1, pathMode: 'strip', sources: [], availability: 'online' };
  let listed = true;
  let removed = false;
  const unavailable = new HttpPreviewClient('https://control.test/', (async () => Response.json({ error: 'Unregistered' }, { status: 409 })) as typeof fetch);
  const renew = vi.fn(async () => {
    if (removed) return unavailable.renew('one', 'preview', registration.target);
    listed = true;
    return { ...registration, expiresAt: Date.now() + 6000 };
  });
  const client = { ...previewClient(vi.fn(async () => 'entry')), renew,
    snapshot: vi.fn(async () => ({ registrations: listed ? [registration] : [] })),
  } as unknown as HttpPreviewClient;
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  try {
    await act(async () => { await controller.open('preview', registration.target, 'agent'); });
    expect(renew).toHaveBeenCalledTimes(1);
    const browser = container.querySelector('[data-browser]')!;
    listed = false;
    await act(async () => { await controller.refresh(); });
    expect(controller.registrations).toEqual([]);
    expect(browser.hasAttribute('data-error')).toBe(false);
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    expect(renew).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-browser]')).toBe(browser);
    expect(browser.getAttribute('data-url')).toBe('entry');
    removed = true; listed = false;
    await act(async () => { await controller.refresh(); window.dispatchEvent(new Event('pageshow')); });
    expect(browser.getAttribute('data-error')).toContain('no longer available');
    const stopped = renew.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); window.dispatchEvent(new Event('pageshow')); });
    expect(renew).toHaveBeenCalledTimes(stopped);
  } finally { await unmount(container); vi.useRealTimers(); }
});


it('stops retained preview renewal immediately after local unregister even when the list refresh stalls', async () => {
  vi.useFakeTimers();
  const registration = { id: 'preview', target: 'http://localhost:5173', status: 'active', createdAt: Date.now(),
    expiresAt: Date.now() + 6000, revision: 1, pathMode: 'strip', sources: [], availability: 'online' };
  const snapshot = deferred<{ registrations: typeof registration[] }>();
  let removed = false;
  const renew = vi.fn(async () => registration);
  const client = { ...previewClient(vi.fn(async () => 'entry')), renew,
    unregister: vi.fn(async () => { removed = true; }),
    snapshot: vi.fn(() => removed ? snapshot.promise : Promise.resolve({ registrations: [registration] })),
  } as unknown as HttpPreviewClient;
  let controller!: PreviewContextValue;
  const container = await render(<PreviewProvider client={client} hostId="one" canManage><Probe capture={value => controller = value} /></PreviewProvider>);
  try {
    await act(async () => { await controller.open('preview', registration.target, 'agent'); });
    await act(async () => { void controller.unregister('preview'); });
    expect(container.querySelector('[data-browser]')?.getAttribute('data-error')).toContain('unregistered');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); window.dispatchEvent(new Event('pageshow')); });
    expect(renew).toHaveBeenCalledTimes(1);
  } finally { await unmount(container); snapshot.resolve({ registrations: [] }); vi.useRealTimers(); }
});
