import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { render, rerender } from '../test/setup.js';
import type { HttpPreviewClient } from '../client/preview-client.js';
import { PreviewDock, PreviewProvider, usePreviewController, type PreviewContextValue } from './PreviewContext.js';

vi.mock('./PreviewBrowser.js', () => ({
  PreviewBrowser: ({ url, visible, onMinimize }: { url?: string; visible: boolean; onMinimize(): void }) =>
    <section data-browser data-visible={visible} data-url={url}><button onClick={onMinimize}>Minimize</button></section>,
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
  await act(async () => container.querySelector<HTMLButtonElement>('[data-browser] button')!.click());
  await act(async () => { request.resolve('entry'); await pending; });
  expect(container.querySelector('[data-browser]')?.getAttribute('data-visible')).toBe('false');
  const browser = container.querySelector('[data-browser]');
  await act(async () => { await open('preview', 'http://localhost:5173', 'agent'); });
  expect(container.querySelector('[data-browser]')).toBe(browser);
  expect(browser?.getAttribute('data-visible')).toBe('true');
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
  return { snapshot: vi.fn(async () => ({ registrations: [] })), open, enter: vi.fn(async (entry: string) => entry) } as unknown as HttpPreviewClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
