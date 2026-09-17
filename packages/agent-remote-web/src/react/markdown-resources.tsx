import { useEffect, useState } from 'react';
import type { ResourceBinding } from '@agent-remote-controller/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
import { MarkdownImageFrame } from './MarkdownImageFrame.js';
import { canPreviewImage } from './ResourceCard.js';

export interface MarkdownResourceContext {
  readonly scopeKey: string;
  readonly bindings: readonly ResourceBinding[];
  readonly resources: AgentReplicaState['resources'];
  readonly resolveResource: (locator: string, sourceLocator?: string) => Promise<ResourceBinding>;
  readonly requestResource: (binding: ResourceBinding) => Promise<void>;
}

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  children?: HastNode[];
}

const resolutions = new Map<string, Promise<ResourceBinding>>();
const requests = new Map<string, Promise<void>>();
const MAX_CACHE_ENTRIES = 256;

export function markLocalMarkdownImages() {
  return (tree: HastNode): void => visit(tree);
}

function visit(node: HastNode): void {
  if (node.type === 'element' && node.tagName === 'img' && typeof node.properties?.src === 'string') {
    const locator = node.properties.src;
    if (isLocalLocator(locator)) {
      node.data = { ...node.data, localResourceLocator: locator };
      delete node.properties.src;
    }
  }
  node.children?.forEach(visit);
}

function isLocalLocator(locator: string): boolean {
  if (!locator || locator.startsWith('//') || locator.startsWith('#')) return false;
  try {
    const url = new URL(locator);
    return url.protocol === 'file:';
  } catch {
    return true;
  }
}

export function MarkdownResourceImage({
  node,
  alt,
  context,
  sourceLocator,
}: {
  readonly node?: unknown;
  readonly alt?: string;
  readonly context?: MarkdownResourceContext;
  readonly sourceLocator?: string;
}) {
  const imageNode = node as HastNode | undefined;
  const locator = typeof imageNode?.data?.localResourceLocator === 'string'
    ? imageNode.data.localResourceLocator
    : undefined;
  const key = JSON.stringify([context?.scopeKey, locator, sourceLocator]);
  const [result, setResult] = useState<{ key: string; binding?: ResourceBinding; failure?: string }>();
  const binding = result?.key === key ? result.binding : undefined;
  const failure = result?.key === key ? result.failure : undefined;

  useEffect(() => {
    let current = true;
    if (!locator || !context) return () => { current = false; };
    void load(context, locator, sourceLocator, (resolved) => {
      if (current) setResult({ key, binding: resolved });
    }).catch((error: unknown) => {
      if (current) setResult(previous => ({ key, binding: previous?.key === key ? previous.binding : undefined,
        failure: error instanceof Error && error.message ? error.message : 'Image resource is unavailable.' }));
    });
    return () => { current = false; };
  }, [context, key, locator, sourceLocator]);

  if (!locator || !context) return <span>{alt}</span>;
  const detail = binding ? context.resources[binding.resourceId] : undefined;
  const src = detail?.status === 'available' && 'contentBase64' in detail && canPreviewImage(detail.mediaType)
    ? `data:${detail.mediaType};base64,${detail.contentBase64}` : undefined;
  const reason = failure ?? (detail?.status === 'unavailable' ? detail.reason
    : detail?.status === 'failed' ? detail.message
    : binding?.status === 'unavailable' ? 'Image resource is unavailable.'
    : detail?.status === 'available' && !canPreviewImage(detail.mediaType) ? 'This resource is not a supported image.' : undefined);
  return <MarkdownImageFrame key={key} src={src} alt={alt ?? locator} failure={reason}
    dimensions={detail?.status === 'available' ? detail.imageDimensions : undefined} />;
}

async function load(
  context: MarkdownResourceContext,
  locator: string,
  sourceLocator: string | undefined,
  onResolved: (binding: ResourceBinding) => void,
): Promise<ResourceBinding> {
  const existing = sourceLocator === undefined ? context.bindings.find((binding) => binding.locator === locator) : undefined;
  const resolveKey = JSON.stringify([context.scopeKey, sourceLocator ?? null, locator]);
  let resolution = existing ? Promise.resolve(existing) : resolutions.get(resolveKey);
  if (!resolution) {
    resolution = context.resolveResource(locator, sourceLocator).catch((error) => {
      resolutions.delete(resolveKey);
      throw error;
    });
    cache(resolutions, resolveKey, resolution);
  }
  const binding = await resolution;
  onResolved(binding);
  if (binding.status === 'unavailable') return binding;
  const detail = context.resources[binding.resourceId];
  if (detail?.status === 'unavailable') return binding;
  if (detail?.status === 'available' && 'contentBase64' in detail) return binding;
  // Metadata can arrive while the same immutable resource is already in flight.
  const requestKey = JSON.stringify([context.scopeKey, binding.resourceId]);
  let request = requests.get(requestKey);
  if (!request) {
    request = context.requestResource(binding);
    cache(requests, requestKey, request);
    void request.then(
      () => { if (requests.get(requestKey) === request) requests.delete(requestKey); },
      () => { if (requests.get(requestKey) === request) requests.delete(requestKey); },
    );
  }
  await request;
  return binding;
}

function cache<T>(entries: Map<string, T>, key: string, value: T): void {
  entries.set(key, value);
  while (entries.size > MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value as string);
}
