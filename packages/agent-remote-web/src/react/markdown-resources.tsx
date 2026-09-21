import { useContext, useEffect, useState } from 'react';
import type { ResourceBinding } from '@orchardworks/agent-remote-protocol';

import { FilePreviewContext } from './FilePreviewContext.js';
import { MarkdownImageFrame } from './MarkdownImageFrame.js';
import { canPreviewImage } from './ResourceCard.js';

export type { MarkdownResourceContext } from './local-resource.js';
import { cachedLocalResourceBinding, loadLocalResource, type MarkdownResourceContext } from './local-resource.js';
interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  children?: HastNode[];
}

export function markLocalMarkdownResources() {
  return (tree: HastNode): void => visit(tree);
}

function visit(node: HastNode, linked = false): void {
  if (node.type === 'element' && node.tagName === 'a' && typeof node.properties?.href === 'string' && isLocalLocator(node.properties.href)) {
    node.data = { ...node.data, localResourceLocator: node.properties.href };
    delete node.properties.href;
  }
  if (node.type === 'element' && node.tagName === 'img' && typeof node.properties?.src === 'string') {
    const locator = node.properties.src;
    if (isLocalLocator(locator)) {
      node.data = { ...node.data, localResourceLocator: locator, linked };
      delete node.properties.src;
    }
  }
  node.children?.forEach(child => visit(child, linked || node.tagName === 'a'));
}

export function isLocalLocator(locator: string): boolean {
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
  const preview = useContext(FilePreviewContext);
  const imageNode = node as HastNode | undefined;
  const locator = typeof imageNode?.data?.localResourceLocator === 'string'
    ? imageNode.data.localResourceLocator
    : undefined;
  const key = JSON.stringify([context?.scopeKey, locator, sourceLocator]);
  const [result, setResult] = useState<{ key: string; binding?: ResourceBinding; failure?: string }>();
  const binding = (result?.key === key ? result.binding : undefined)
    ?? (context && locator ? cachedLocalResourceBinding(context, locator, sourceLocator) : undefined);
  const failure = result?.key === key ? result.failure : undefined;

  useEffect(() => {
    let current = true;
    if (!locator || !context) return () => { current = false; };
    void loadLocalResource(context, locator, sourceLocator, (resolved) => {
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
  const frame = <MarkdownImageFrame key={key} src={src} alt={alt ?? locator} failure={reason}
    dimensions={detail?.status === 'available' ? detail.imageDimensions : undefined} />;
  return preview && !imageNode?.data?.linked ? <button type="button" className="agent-resource-image-open" aria-label={`Open image: ${alt ?? locator}`}
    onClick={() => preview.open({ locator, sourceLocator, context })}>{frame}</button> : frame;
}
