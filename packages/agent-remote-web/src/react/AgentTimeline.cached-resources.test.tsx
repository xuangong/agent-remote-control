import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { createReplicaState } from '../replica/reducer.js';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { TimelineDisplay } from './TimelineDisplay.js';

const binding = { locator: 'native-image:cached', resourceId: 'picture', status: 'available' as const };
const bytes = { status: 'available' as const, mediaType: 'image/png', byteLength: 1, sha256: 'picture', contentBase64: 'AA==' };
function snapshot(epoch: string, loaded = true) {
  const base = createReplicaState();
  return { ...base, resources: loaded ? { picture: bytes } : {}, timeline: { ...base.timeline, epoch, initialized: true, entries: [{
    providerId: 'test', seqStart: 1, seqEnd: 1, sourceSeqRanges: [], collapsed: [], resources: [binding],
    timestamp: '2026-10-11T00:00:00Z', item: { type: 'assistant_message' as const, text: '![Cached diagram](native-image:cached)' },
  }] } };
}

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});

it('renders and opens cached Markdown images without live resource actions or duplicate attachments', async () => {
  const container = await render(<TimelineDisplay.Provider value="content"><AgentTimeline state={snapshot('cached-inline')} /></TimelineDisplay.Provider>);
  expect(container.querySelector('.agent-message img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(container.querySelector('.agent-resources')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open image: Cached diagram"]')!.click());
  expect(document.querySelector('dialog[aria-label="Image preview"] img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
});

it('waits for live resource actions before loading uncached image bytes', async () => {
  const current = snapshot('cached-missing', false);
  const request = vi.fn(async () => bytes);
  const resolve = vi.fn(async () => binding);
  const view = (live: boolean) => <TimelineDisplay.Provider value="content"><AgentTimeline state={current}
    onResourceResolve={live ? resolve : undefined} onResourceRequest={live ? request : undefined} /></TimelineDisplay.Provider>;
  const container = await render(view(false));
  expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Reconnect to load');
  expect(container.querySelector('img')).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  await rerender(container, view(true));
  expect(container.querySelector('.agent-message img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(resolve).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});

it('does not let an in-flight live request populate a display-only preview after authority is removed', async () => {
  const current = snapshot('cached-retired', false);
  let finish!: (detail: ResourceResponseState) => void;
  const request = vi.fn(() => new Promise<ResourceResponseState>(resolve => { finish = resolve; }));
  const view = (live: boolean) => <TimelineDisplay.Provider value="content"><AgentTimeline state={current}
    onResourceResolve={live ? async () => binding : undefined} onResourceRequest={live ? request : undefined} /></TimelineDisplay.Provider>;
  const container = await render(view(true));
  expect(request).toHaveBeenCalledOnce();
  await rerender(container, view(false));
  expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Reconnect to load');
  await act(async () => finish(bytes));
  expect(container.querySelector('img')).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

it('never carries cached bytes or an open preview into a different timeline scope', async () => {
  const view = (epoch: string, loaded: boolean) => <TimelineDisplay.Provider value="content"><AgentTimeline state={snapshot(epoch, loaded)} /></TimelineDisplay.Provider>;
  const container = await render(view('cached-first-scope', true));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open image: Cached diagram"]')!.click());
  await rerender(container, view('cached-other-scope', false));
  expect(container.querySelector('img')).toBeNull();
  expect(document.querySelector('dialog[aria-label="Image preview"]')).toBeNull();
});
