import type { CSSProperties } from 'react';
import { orchardType } from '../theme/tokens.js';
import { rootClass } from './classes.js';
import { OrchardMark } from './OrchardMark.js';

/** The mark and "orchard" in lowercase rounded type; running text says "Orchard". */
export function Wordmark({ size = orchardType.wordmark.size, className }: { size?: number; className?: string }) {
  return <span className={rootClass('orchard-wordmark', className)}
    style={{ '--orchard-wordmark-size': `${size}px` } as CSSProperties}>
    <OrchardMark size={Math.round(size * 1.55)} />
    <span className="orchard-wordmark-text">orchard</span>
  </span>;
}
