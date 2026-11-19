import { rootClass } from './classes.js';

/** A thin line where the assistant continued in a new session ("· 换到新的会话继续 ·"); a separator named by its text. */
export function SessionChangeLine({ children, className }: { children: string; className?: string }) {
  return <div role="separator" aria-label={children} className={rootClass('orchard-session-change', className)}>
    <span aria-hidden="true">· {children} ·</span>
  </div>;
}
