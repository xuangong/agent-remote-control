import { useEffect, useState } from 'react';
import type { ImageDimensions } from '@agent-remote-controller/agent-remote-protocol';

export function MarkdownImageFrame({ src, alt, dimensions, failure }: {
  readonly src?: string;
  readonly alt: string;
  readonly dimensions?: ImageDimensions;
  readonly failure?: string;
}) {
  const [retainedDimensions, setRetainedDimensions] = useState(dimensions);
  const [decoded, setDecoded] = useState<{ src: string; failed: boolean }>();
  useEffect(() => { if (dimensions) setRetainedDimensions(dimensions); }, [dimensions]);
  const size = dimensions ?? retainedDimensions;
  const result = decoded?.src === src ? decoded : undefined;
  const reason = failure ?? (result?.failed ? 'The image could not be decoded.' : undefined);
  const state = reason ? 'failed' : src && result ? 'loaded' : 'loading';
  return <span
    className={`agent-markdown-image${size ? ' agent-markdown-image-sized' : ''}`}
    data-image-state={state}
    aria-busy={state === 'loading'}
    style={size ? { aspectRatio: `${size.width} / ${size.height}`,
      width: `min(100%, ${size.width}px, ${70 * size.width / size.height}vh)` } : undefined}
  >
    {src && <img className="agent-resource-image" src={src} alt={alt}
      width={size?.width} height={size?.height} loading="lazy" decoding="async"
      onLoad={() => setDecoded({ src, failed: false })}
      onError={() => setDecoded({ src, failed: true })} />}
    {state !== 'loaded' && <span className="agent-markdown-image-status" role={reason ? 'img' : 'status'}
      aria-label={reason ? `${alt}: ${reason}` : `Loading image: ${alt}`} title={reason ?? alt}>
      <span aria-hidden="true">{reason ? 'Image unavailable' : 'Loading image…'}</span>
    </span>}
  </span>;
}
