import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { ResourceList } from './ResourceList.js';

const image = { resourceId: 'image', locator: 'codex-image:generated', status: 'available' as const };
const metadata = { status: 'available' as const, mediaType: 'image/png', byteLength: 4, sha256: 'digest' };

it('automatically requests available image bytes once and renders the response inline', async () => {
  const request = vi.fn(async () => {});
  const resources = { image: metadata };
  const container = await render(<ResourceList bindings={[image]} resources={resources} onRequest={request} />);
  expect(request).toHaveBeenCalledExactlyOnceWith(image);
  await rerender(container, <ResourceList bindings={[image]} resources={{ ...resources }} onRequest={request} />);
  expect(request).toHaveBeenCalledTimes(1);
  await rerender(container, <ResourceList bindings={[image]} resources={{ image: { ...metadata, contentBase64: 'AAAA' } }} onRequest={request} />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  expect(container.querySelector('img')?.alt).toBe(image.locator);
  expect(container.querySelector('[data-resource-download="image"]')).not.toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it('waits for image metadata and leaves other media as explicit resource requests', async () => {
  const request = vi.fn(async () => {});
  const resources: AgentReplicaState['resources'] = {
    image: { status: 'pending', retryAfterMs: 100 },
    svg: { ...metadata, mediaType: 'image/svg+xml' },
    text: { ...metadata, mediaType: 'text/plain' },
  };
  const bindings = [image, { ...image, resourceId: 'svg' }, { ...image, resourceId: 'text' }];
  const container = await render(<ResourceList bindings={bindings} resources={resources} onRequest={request} />);
  expect(request).not.toHaveBeenCalled();
  await rerender(container, <ResourceList bindings={bindings} resources={{ ...resources, image: metadata }} onRequest={request} />);
  expect(request).toHaveBeenCalledExactlyOnceWith(image);
});

it('keeps a failed automatic load retryable without retrying on each render', async () => {
  const request = vi.fn(async () => { throw new Error('Connection unavailable'); });
  const container = await render(<ResourceList bindings={[image]} resources={{ image: metadata }} onRequest={request} />);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection unavailable');
  await rerender(container, <ResourceList bindings={[image]} resources={{ image: metadata }} onRequest={request} />);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-resource-id="image"]')!.click());
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps the download available when image decoding fails', async () => {
  const container = await render(<ResourceList bindings={[image]} resources={{ image: { ...metadata, contentBase64: 'AAAA' } }} />);
  const preview = container.querySelector('img');
  expect(preview).not.toBeNull();
  await act(async () => preview!.dispatchEvent(new Event('error')));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Image preview unavailable');
  expect(container.querySelector('[data-resource-download="image"]')).not.toBeNull();
});
