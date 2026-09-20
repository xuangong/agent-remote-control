import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import type { DraftImage } from '../image-drafts.js';
import { ImageUploadStatus } from './ImageUploadStatus.js';

const part = (imageId: string) => ({ type: 'image' as const, imageId, label: imageId });
const image = (imageId: string, status: DraftImage['status'], size: number, progress = 0): DraftImage => ({ imageId, uploadId: imageId, status, progress, blob: new Blob([new Uint8Array(size)]) });

it('weights progress by bytes, counts repeated atoms once, and hides completed uploads', async () => {
  const parts = [part('small'), part('small'), part('large')];
  const images = { small: image('small', 'uploading', 10, .5), large: image('large', 'pending', 90), deleted: image('deleted', 'failed', 100) };
  const view = () => <ImageUploadStatus parts={parts} images={images} connected onOpen={() => {}} />;
  const container = await render(view());
  expect(container.textContent).toContain('Uploading images · 5%');
  images.small.status = 'ready'; images.large.status = 'uploading'; images.large.progress = 1;
  await rerender(container, view());
  expect(container.textContent).toContain('Checking images');
  images.large.status = 'ready';
  await rerender(container, view());
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('opens the failed image when other images are still uploading', async () => {
  const open = vi.fn();
  const container = await render(<ImageUploadStatus parts={[part('uploading'), part('failed'), part('failed')]}
    images={{ uploading: image('uploading', 'uploading', 20, .5), failed: image('failed', 'failed', 10) }} connected onOpen={open} />);
  expect(container.textContent).toContain('1 image failed · Review');
  await act(async () => container.querySelector('button')!.click());
  expect(open).toHaveBeenCalledWith('failed');
});

it('shows paused upload feedback while disconnected', async () => {
  const container = await render(<ImageUploadStatus parts={[part('pending')]} images={{ pending: image('pending', 'pending', 10) }} connected={false} onOpen={() => {}} />);
  expect(container.textContent).toContain('Image upload paused');
});
