import type { ReactNode } from 'react';

/**
 * Presentation shared by product sessions, standalone debugging, and recordings. `sessionAddress` names the session shown as the
 * command line and session links do (`<hostId>/<providerId>/<nativeSessionId>`), so whichever pane or layout holds the
 * conversation, it can be found by its session.
 */
export function SessionViewFrame({ children, className = '', sessionAddress }: { children: ReactNode; className?: string; sessionAddress?: string }) {
  return <div className="lab-session-view" data-session-address={sessionAddress}>
    <div className={`lab-workbench-layout${className ? ` ${className}` : ''}`}>{children}</div>
  </div>;
}
