import { useContext, useEffect, useState } from 'react';
import type { ResourceBinding } from '@orchardworks/agent-remote-protocol';

import { FilePreviewContext } from './FilePreviewContext.js';
import { ImagePreview } from './ImagePreview.js';
import { MarkdownImageFrame } from './MarkdownImageFrame.js';
import { canPreviewImage } from './ResourceCard.js';
import { useNearViewport } from './useNearViewport.js';

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
    node.data = { ...node.data, imageResourceLocator: node.properties.src, linked };
    delete node.properties.src;
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
  const candidate = typeof imageNode?.data?.imageResourceLocator === 'string'
    ? imageNode.data.imageResourceLocator
    : undefined;
  // Opaque provider locators are readable only through this entry's resource bindings.
  const locator = candidate && (isLocalLocator(candidate) || context?.bindings.some(binding => binding.locator === candidate))
    ? candidate : undefined;
  const key = JSON.stringify([context?.scopeKey, locator, sourceLocator]);
  const { ref: frameRef, near } = useNearViewport(key);
  const [result, setResult] = useState<{ key: string; binding?: ResourceBinding; failure?: string;
    detail?: Awaited<ReturnType<typeof loadLocalResource>>['detail']; resources?: MarkdownResourceContext['resources'] }>();
  const [openedKey, setOpenedKey] = useState<string>();
  useEffect(() => { setOpenedKey(undefined); }, [key]);
  const binding = (result?.key === key ? result.binding : undefined)
    ?? (context && locator ? cachedLocalResourceBinding(context, locator, sourceLocator) : undefined);
  const failure = result?.key === key ? result.failure : undefined;

  useEffect(() => {
    let current = true;
    if (!near || !locator || !context) return () => { current = false; };
    void loadLocalResource(context, locator, sourceLocator, (resolved) => {
      if (current) setResult({ key, binding: resolved });
    }).then(({ binding, detail }) => {
      if (current) setResult({ key, binding, detail, resources: context.resources });
    }).catch((error: unknown) => {
      if (current) setResult(previous => ({ key, binding: previous?.key === key ? previous.binding : undefined,
        failure: error instanceof Error && error.message ? error.message : 'Image resource is unavailable.' }));
    });
    return () => { current = false; };
  }, [context, key, locator, sourceLocator, near]);

  if (!locator || !context) return <span>{alt}</span>;
  const detail = result?.key === key && result.resources === context.resources && result.detail
    ? result.detail : binding ? context.resources[binding.resourceId] : undefined;
  const src = detail?.status === 'available' && 'contentBase64' in detail && canPreviewImage(detail.mediaType)
    ? `data:${detail.mediaType};base64,${detail.contentBase64}` : undefined;
  const reason = failure ?? (detail?.status === 'unavailable' ? detail.reason
    : detail?.status === 'failed' ? detail.message
    : binding?.status === 'unavailable' ? 'Image resource is unavailable.'
    : detail?.status === 'available' && !canPreviewImage(detail.mediaType) ? 'This resource is not a supported image.' : undefined);
  const frame = <MarkdownImageFrame key={key} frameRef={frameRef} src={src} alt={alt ?? locator} failure={reason}
    dimensions={detail?.status === 'available' ? detail.imageDimensions : undefined} />;
  return !imageNode?.data?.linked ? <>
    <button type="button" className="agent-resource-image-open" aria-label={`Open image: ${alt ?? locator}`} disabled={!src && !preview}
      onClick={() => { if (src) setOpenedKey(key); else preview?.open({ locator, sourceLocator, context }); }}>{frame}</button>
    {openedKey === key && src ? <ImagePreview src={src} label={alt ?? locator} onClose={() => setOpenedKey(undefined)} /> : null}
  </> : frame;
}
