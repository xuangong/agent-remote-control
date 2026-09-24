import { useContext, type ReactNode } from 'react';
import { TimelineDisplay, type TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';

/** Presentation shared by product sessions, standalone debugging, and recordings. */
export function SessionViewFrame({ children, className = '', displayMode }: {
  children: ReactNode;
  className?: string;
  displayMode?: TimelineDisplayMode;
}) {
  const inheritedMode = useContext(TimelineDisplay);
  return <TimelineDisplay.Provider value={displayMode ?? inheritedMode}>
    <div className={`lab-session-view lab-workbench-layout${className ? ` ${className}` : ''}`}>{children}</div>
  </TimelineDisplay.Provider>;
}
