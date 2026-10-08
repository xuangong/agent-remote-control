import { useRef, type RefObject } from 'react';
import { observationLabel, type SessionObservation } from '../tracking-state.js';
import { useAskDock } from '../hooks/useAskDock.js';

export function AskButton({ observation, hidden, disabled, onOpen, triggerRef, storageScope }: {
  triggerRef: RefObject<HTMLButtonElement>; observation?: SessionObservation; hidden: boolean; disabled: boolean; storageScope: string; onOpen(): void;
}) {
  const dock = useRef<HTMLDivElement>(null);
  useAskDock(dock, triggerRef, storageScope, hidden || disabled);
  const ready = observation?.connection === 'ready';
  const activity = ready ? observation.activity : undefined;
  const alert = ready ? observation.attention : undefined;
  const status = activity === 'running' ? 'working' : activity === 'waiting' || activity === 'starting' ? 'pending' : activity === 'idle' ? 'idle' : 'unknown';
  const label = observation ? observationLabel(observation) : 'Ask about this conversation';
  return <div ref={dock} className="lab-ask-floating" data-hidden={hidden || undefined} aria-hidden={hidden || undefined}
    data-status={status} data-alert={alert}>
    <button ref={triggerRef} className="lab-ask-trigger" type="button" aria-label="Ask about this session" aria-haspopup="dialog" aria-expanded={hidden}
      tabIndex={hidden ? -1 : undefined} disabled={disabled} onClick={onOpen}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
      aria-description="Drag anywhere in this session and release to dock at that height. Left and right arrow keys choose an edge; up and down move vertically."
      title={label}>
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16.5 9.2a6.5 6.5 0 0 1-9.3 5.9L3 16l.9-4.2a6.5 6.5 0 1 1 12.6-2.6Z" />
        <path d="M8 7.3a2 2 0 0 1 3.8.9c0 1.3-1.8 1.3-1.8 2.4M10 12.9h.01" />
      </svg>
      Ask
      <span className="agent-visually-hidden" role="status">{label}{alert ? '. New status needs attention.' : ''}</span>
    </button>
  </div>;
}
