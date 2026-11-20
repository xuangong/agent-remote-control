import { useEffect, useState, type Ref } from 'react';
import type { ImageDimensions } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from './locale.js';

export function MarkdownImageFrame({ src, alt, dimensions, failure, frameRef }: {
  readonly src?: string;
  readonly alt: string;
  readonly dimensions?: ImageDimensions;
  readonly failure?: string;
  readonly frameRef?: Ref<HTMLSpanElement>;
}) {
  const t = useTranslate();
  const [retainedDimensions, setRetainedDimensions] = useState(dimensions);
  const [decoded, setDecoded] = useState<{ src: string; failed: boolean }>();
  useEffect(() => { if (dimensions) setRetainedDimensions(dimensions); }, [dimensions]);
  const size = dimensions ?? retainedDimensions;
  const result = decoded?.src === src ? decoded : undefined;
  const reason = failure ?? (result?.failed ? t('timeline.image.undecodable') : undefined);
  const state = reason ? 'failed' : src && result ? 'loaded' : 'loading';
  return <span
    ref={frameRef}
    className={`agent-markdown-image${size ? ' agent-markdown-image-sized' : ''}`}
    data-image-state={state}
    aria-busy={state === 'loading'}
    // The natural width, kept inside the column and the screen's height: a bubble that holds only the image still has its size.
    style={size ? { aspectRatio: `${size.width} / ${size.height}`,
      width: `${size.width}px`, maxWidth: `min(100%, ${70 * size.width / size.height}vh)` } : undefined}
  >
    {src && <img className="agent-resource-image" src={src} alt={alt}
      width={size?.width} height={size?.height} loading="lazy" decoding="async"
      onLoad={() => setDecoded({ src, failed: false })}
      onError={() => setDecoded({ src, failed: true })} />}
    {state !== 'loaded' && <span className="agent-markdown-image-status" role={reason ? 'img' : 'status'}
      aria-label={reason ? `${alt}: ${reason}` : t('timeline.image.loadingNamed', { alt })} title={reason ?? alt}>
      <span aria-hidden="true">{reason ? t('timeline.image.unavailable') : t('timeline.image.loading')}</span>
    </span>}
  </span>;
}
