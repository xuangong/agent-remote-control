import type { ReactNode } from 'react';

/** Presentation shared by product sessions, standalone debugging, and recordings. */
export function SessionViewFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className="lab-session-view">
    <div className={`lab-workbench-layout${className ? ` ${className}` : ''}`}>{children}</div>
  </div>;
}
