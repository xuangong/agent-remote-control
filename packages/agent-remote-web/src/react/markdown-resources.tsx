import { useEffect, useState } from 'react';
import type { ResourceBinding } from '@agent-remote-controller/agent-remote-protocol';

import type { AgentReplicaState } from '../replica/types.js';
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
    void load(context, locator, sourceLocator).then((resolved) => {
      if (!current) return;
      setResult({ key, binding: resolved });
    }, (error: unknown) => {
      if (current) setResult({ key, failure: error instanceof Error && error.message ? error.message : 'Image resource is unavailable.' });
    });
    return () => { current = false; };
  }, [context, key, locator, sourceLocator]);

  if (!locator || !context) return <span>{alt}</span>;
  const detail = binding ? context.resources[binding.resourceId] : undefined;
  if (detail?.status === 'available' && 'contentBase64' in detail && canPreviewImage(detail.mediaType)) {
    return <img
      className="agent-resource-image"
      src={`data:${detail.mediaType};base64,${detail.contentBase64}`}
      alt={alt ?? locator}
      loading="lazy"
      decoding="async"
    />;
  }
  if (detail?.status === 'unavailable' || binding?.status === 'unavailable') {
    const reason = detail?.status === 'unavailable' ? detail.reason : 'Image resource is unavailable.';
    return <span role="img" aria-label={`${alt ?? locator}: ${reason}`}>{alt ?? locator}</span>;
  }
  if (failure) return <span role="img" aria-label={`${alt ?? locator}: ${failure}`}>{alt ?? locator}</span>;
  return <span role="status">{alt ?? locator}</span>;
}

async function load(
  context: MarkdownResourceContext,
  locator: string,
  sourceLocator: string | undefined,
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
  if (binding.status === 'unavailable') return binding;
  const detail = context.resources[binding.resourceId];
  if (detail?.status === 'unavailable') return binding;
  if (detail?.status === 'available' && 'contentBase64' in detail) return binding;
  const requestKey = JSON.stringify([context.scopeKey, binding.resourceId, detail?.status === 'available' ? detail.sha256 : null]);
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
