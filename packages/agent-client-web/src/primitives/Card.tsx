import type { ReactNode } from 'react';
import { rootClass } from './classes.js';

/** A rounded card on the panel: plain on the fill, or tinted with the brand for the name card and approvals. */
export function Card({ tone = 'plain', children, className }: { tone?: 'plain' | 'tint'; children: ReactNode; className?: string }) {
  return <div className={rootClass('orchard-card', className)} data-tone={tone}>{children}</div>;
}
