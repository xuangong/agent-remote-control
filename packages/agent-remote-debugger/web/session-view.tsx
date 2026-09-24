import { useRef, useState, type ReactNode } from 'react';
import { TimelineDisplay, type TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';
import { ToastProvider } from '../../agent-remote-lab/src/components/Toast.js';
import { useTimelineDisplayMode } from '../../agent-remote-lab/src/hooks/useTimelineDisplayMode.js';

/** Debug controls overlay the shared view without changing its available space. */
export function DebugSessionView({ children, playbackControls }: { children: ReactNode; playbackControls?: ReactNode }) {
  const [mode, setMode] = useTimelineDisplayMode();
  const [expanded, setExpanded] = useState(!!playbackControls);
  const toggle = useRef<HTMLButtonElement>(null);
  const label = playbackControls ? 'playback controls' : 'debug controls';
  return <ToastProvider><TimelineDisplay.Provider value={mode}>
    <main className="ardb-session">{children}</main>
    <aside className="ardb-controls" aria-label={playbackControls ? 'Recording controls' : 'Debug controls'} onKeyDown={event => {
      if (event.key === 'Escape') { setExpanded(false); toggle.current?.focus(); }
    }}>
      <button ref={toggle} className="ardb-controls-toggle" type="button" aria-expanded={expanded} aria-controls="ardb-controls-panel"
        aria-label={`${expanded ? 'Hide' : 'Show'} ${label}`} onClick={() => setExpanded(value => !value)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
        {playbackControls ? 'Replay' : 'Debug'}
      </button>
      <div id="ardb-controls-panel" className="ardb-controls-panel" hidden={!expanded}>
        {playbackControls}
        <label className="ardb-display-mode">Timeline display
          <select value={mode} onChange={event => setMode(event.target.value as TimelineDisplayMode)}>
            <option value="preview">Preview</option><option value="simple">Simple</option><option value="content">Content only</option>
          </select>
        </label>
      </div>
    </aside>
  </TimelineDisplay.Provider></ToastProvider>;
}
