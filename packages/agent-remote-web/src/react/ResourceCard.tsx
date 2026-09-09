import type { ResourceBinding } from '@borgee/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';

export interface ResourceCardProps {
  readonly binding: ResourceBinding;
  readonly detail?: AgentReplicaState['resources'][string];
  readonly pending: boolean;
  readonly failure?: string;
  readonly onRequest?: () => Promise<void>;
}

const statusLabels = {
  pending: 'Pending', available: 'Available', failed: 'Failed', unavailable: 'Unavailable',
} as const;

const inertPreviewMediaTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/json',
]);

export function ResourceCard({ binding, detail, pending, failure, onRequest }: ResourceCardProps) {
  const status = detail?.status ?? binding.status;
  return <li className={`agent-state-${status}`} aria-busy={pending}>
    <div><code>{binding.locator}</code><span className="agent-state-label">{statusLabels[status]}</span></div>
    {detail?.status === 'available' ? <small>{detail.mediaType} · {detail.byteLength} bytes</small> : null}
    {detail?.status === 'failed' ? <small role="alert">{detail.message}</small> : null}
    {detail?.status === 'unavailable' ? <small>{detail.reason}</small> : null}
    {failure ? <small role="alert">{failure}</small> : null}
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
        download={resourceDownloadName(binding.locator)}
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

function resourceDownloadName(locator: string): string {
  return locator.split(/[\\/]/).at(-1) ?? 'resource';
}
