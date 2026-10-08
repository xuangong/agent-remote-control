import { createContext, useContext, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ToastProvider } from '../../agent-remote-lab/src/components/Toast.js';
import { SessionWorkbench } from '../../agent-remote-lab/src/components/SessionWorkbench.js';
import { useSessionDisplayPreferences } from '../../agent-remote-lab/src/hooks/useSessionDisplayPreferences.js';

export const DebugControlsState = createContext<{ expanded: boolean; setExpanded(value: boolean | ((value: boolean) => boolean)): void } | undefined>(undefined);

export function DebugWorkbench({ displaySessionKey, ...props }: ComponentProps<typeof SessionWorkbench> & { displaySessionKey: string }) {
  const [displayPreferences, onDisplayPreferencesChange] = useSessionDisplayPreferences(`${location.origin}:ardb`,
    displaySessionKey, props.defaultDisplayMode);
  return <SessionWorkbench {...props} displayPreferences={displayPreferences} onDisplayPreferencesChange={onDisplayPreferencesChange} />;
}

/** Debug controls overlay the shared view without changing its available space. */
export function DebugSessionView({ children, playbackControls, liveControls, modeControls, recordingActive = false }: { children: ReactNode; playbackControls?: ReactNode; liveControls?: ReactNode; modeControls?: ReactNode; recordingActive?: boolean }) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const shared = useContext(DebugControlsState);
  const expanded = shared?.expanded ?? localExpanded;
  const setExpanded = shared?.setExpanded ?? setLocalExpanded;
  const toggle = useRef<HTMLButtonElement>(null);
  const label = playbackControls ? 'playback controls' : 'debug controls';
  return <ToastProvider>
    <main className="ardb-session">{children}</main>
    <aside className="ardb-controls ardb-controls-replay" aria-label={playbackControls ? 'Recording controls' : 'Debug controls'} onKeyDown={event => {
      if (event.key === 'Escape') { setExpanded(false); toggle.current?.focus(); }
    }}>
      <button ref={toggle} className="ardb-controls-toggle" type="button" aria-expanded={expanded} aria-controls="ardb-controls-panel"
        title={playbackControls ? 'Replay controls' : 'Debug controls'} aria-label={`${expanded ? 'Hide' : 'Show'} ${label}`} onClick={() => setExpanded(value => !value)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? 'm6 15 6-6 6 6' : playbackControls ? 'm8 5 10 7-10 7Z' : 'm6 9 6 6 6-6'} /></svg>
        {recordingActive ? <span className="ardb-recording-dot" aria-label="Recording active" /> : null}
      </button>
      <div id="ardb-controls-panel" className="ardb-controls-panel" hidden={!expanded}>
        {modeControls}
        {playbackControls}
        {liveControls}
      </div>
    </aside>
  </ToastProvider>;
}
