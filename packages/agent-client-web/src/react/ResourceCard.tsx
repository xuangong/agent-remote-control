import { useState } from 'react';
import type { ResourceBinding } from '@orchardworks/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
import { ImagePreview } from './ImagePreview.js';

export interface ResourceCardProps {
  readonly binding: ResourceBinding;
  readonly label?: string;
  readonly detail?: AgentReplicaState['resources'][string];
  readonly pending: boolean;
  readonly failure?: string;
  readonly onRequest?: () => Promise<void>;
}

const statusLabels = {
  pending: 'Pending', available: 'Available', failed: 'Failed', unavailable: 'Unavailable',
} as const;

const imageMediaTypes = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);
const inertPreviewMediaTypes = new Set([
  ...imageMediaTypes.keys(),
  'text/plain',
  'application/json',
]);

export function ResourceCard({ binding, detail, label, pending, failure, onRequest }: ResourceCardProps) {
  const [failedPreview, setFailedPreview] = useState<string>();
  const [openedImage, setOpenedImage] = useState<string>();
  const status = detail?.status ?? binding.status;
  const mediaType = detail?.status === 'available' ? detail.mediaType.split(';', 1)[0]?.trim().toLowerCase() : undefined;
  const filename = resourceFilename(binding.locator);
  const title = label?.trim() || filename || (mediaType?.startsWith('image/') ? 'Image' : 'Attachment');
  const imageUrl = detail?.status === 'available' && 'contentBase64' in detail && canPreviewImage(detail.mediaType)
    ? resourceDataUrl(detail.mediaType, detail.contentBase64) : undefined;
  return <li className={`agent-state-${status}`} aria-busy={pending}>
    <div><code>{title}</code><span className="agent-state-label">{statusLabels[status]}</span></div>
    {detail?.status === 'available' ? <small>{detail.mediaType} · {detail.byteLength} bytes</small> : null}
    {detail?.status === 'failed' ? <small role="alert">{detail.message}</small> : null}
    {detail?.status === 'unavailable' ? <small>{detail.reason}</small> : null}
    {failure ? <small role="alert">{failure}</small> : null}
    {imageUrl ? failedPreview === imageUrl ? <small role="alert">Image preview unavailable. Download the resource to view it.</small> : <button
      type="button" className="agent-resource-image-open" aria-label={`Open image: ${title}`} onClick={() => setOpenedImage(imageUrl)}>
      <img className="agent-resource-image" src={imageUrl} alt={title} loading="lazy" decoding="async"
        onError={() => setFailedPreview(imageUrl)} />
    </button> : null}
    {imageUrl && openedImage === imageUrl ? <ImagePreview src={imageUrl} label={title} onClose={() => setOpenedImage(undefined)} /> : null}
    {detail?.status === 'available' && 'contentBase64' in detail ? <div className="agent-resource-actions">
      {canOpenResource(detail.mediaType) ? <a
        data-resource-open={binding.resourceId}
        href={resourceDataUrl(detail.mediaType, detail.contentBase64)}
        target="_blank"
        rel="noreferrer"
      >Open resource</a> : null}
      <a
        data-resource-download={binding.resourceId}
        href={resourceDataUrl(detail.mediaType, detail.contentBase64)}
        download={filename ?? fallbackDownloadName(mediaType)}
      >Download resource</a>
    </div> : status === 'available' ? <button
      type="button"
      data-resource-id={binding.resourceId}
      disabled={!onRequest || pending}
      onClick={async () => { await onRequest?.(); }}
    >{pending ? 'Loading resource…' : 'Load resource'}</button> : null}
  </li>;
}

function resourceDataUrl(mediaType: string, contentBase64: string): string {
  return `data:${mediaType};base64,${contentBase64}`;
}

function canOpenResource(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]?.trim().toLowerCase();
  return normalized !== undefined && inertPreviewMediaTypes.has(normalized);
}

export function canPreviewImage(mediaType: string): boolean {
  return imageMediaTypes.has(mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '');
}

function resourceFilename(locator: string): string | undefined {
  let path = locator;
  if (!/^[a-z]:[\\/]/i.test(locator)) {
    try {
      const url = new URL(locator);
      if (!['file:', 'http:', 'https:'].includes(url.protocol)) return undefined;
      path = url.pathname;
    } catch { /* Relative file paths are already readable locators. */ }
  }
  let name = path.split(/[\\/]/).at(-1)?.trim();
  if (!name) return undefined;
  try { name = decodeURIComponent(name); } catch { /* Preserve literal percent signs in file names. */ }
  return /^[a-f\d-]{32,}(?:\.[^.]+)?$/i.test(name) ? undefined : name;
}

function fallbackDownloadName(mediaType: string | undefined): string {
  const extension = imageMediaTypes.get(mediaType ?? '');
  return extension ? `image.${extension}` : 'attachment';
}
