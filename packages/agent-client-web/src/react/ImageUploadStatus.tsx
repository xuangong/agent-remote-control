import type { DraftImage } from '../image-drafts.js';
import type { DraftPart } from './composer-document.js';

export function ImageUploadStatus({ parts, images, connected, onOpen }: {
  parts: readonly DraftPart[];
  images: Readonly<Record<string, DraftImage>>;
  connected: boolean;
  onOpen(imageId: string): void;
}) {
  const ids = [...new Set(parts.flatMap(part => part.type === 'image' ? [part.imageId] : []))];
  const pending = ids.filter(id => images[id]?.status !== 'ready');
  if (!pending.length) return null;
  const failed = pending.filter(id => !images[id] || images[id].status === 'failed' || images[id].status === 'unavailable');
  const uploading = pending.find(id => images[id]?.status === 'uploading');
  const total = ids.reduce((sum, id) => sum + (images[id]?.blob?.size ?? 0), 0);
  const loaded = ids.reduce((sum, id) => sum + (images[id]?.blob?.size ?? 0) * (images[id]?.status === 'ready' ? 1 : images[id]?.progress ?? 0), 0);
  const percent = total ? Math.floor(loaded / total * 100) : 0;
  const label = failed.length ? `${failed.length} image${failed.length === 1 ? '' : 's'} failed · Review`
    : !connected ? 'Image upload paused'
      : uploading ? percent >= 100 ? 'Checking images…' : `Uploading image${ids.length === 1 ? '' : 's'} · ${percent}%`
        : 'Waiting to upload…';
  return <div className="agent-image-upload-status" role="status" data-failed={failed.length > 0}>
    <button type="button" onClick={() => onOpen(failed[0] ?? uploading ?? pending[0]!)}>
      <span>{label}</span><span aria-hidden="true">›</span>
    </button>
  </div>;
}
