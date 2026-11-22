import type { ReactNode } from 'react';

/**
 * Presentation shared by product sessions, standalone debugging, and recordings. `nativeSession` names the session shown
 * (`<providerId>/<nativeSessionId>`), so whichever pane or layout holds the conversation, it can be found by its session.
 */
export function SessionViewFrame({ children, className = '', nativeSession }: { children: ReactNode; className?: string; nativeSession?: string }) {
  return <div className="lab-session-view" data-native-session={nativeSession}>
    <div className={`lab-workbench-layout${className ? ` ${className}` : ''}`}>{children}</div>
  </div>;
}
