import type { ReactNode } from 'react';
import { rootClass } from './classes.js';

/** A rounded panel floating on the warm ground; at phone width it fills the screen edge to edge and clears the safe areas. */
export function FloatingPanel({ as: Element = 'section', label, children, className }: {
  as?: 'aside' | 'section' | 'div'; label?: string; children: ReactNode; className?: string;
}) {
  return <Element className={rootClass('orchard-panel', className)} {...(label ? { 'aria-label': label } : {})}>{children}</Element>;
}
