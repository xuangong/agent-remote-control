import { useContext, type RefObject } from 'react';
import { observationLabel, type SessionObservation } from '../tracking-state.js';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import { ShortcutPlacement } from '../shell/shortcut-placement.js';

/** `unavailable` says why Ask cannot open for the named session. */
export function AskButton({ observation, sourceTitle, disabled, unavailable, onOpen, triggerRef }: {
  triggerRef: RefObject<HTMLButtonElement>; observation?: SessionObservation; sourceTitle?: string; disabled: boolean; unavailable?: string; onOpen(): void;
}) {
  const floating = useContext(ShortcutPlacement) === 'floating';
  const { root, style, handlers, edge } = useTrackingPosition('agent-remote:ask-position', undefined, { enabled: floating });
  const rootProps = floating ? { style, ...handlers, 'data-edge': edge, className: 'lab-tracking-floating lab-ask-floating' }
    : { className: 'lab-sidebar-shortcut lab-sidebar-shortcut-ask' };
  const ready = observation?.connection === 'ready';
  const activity = ready ? observation.activity : undefined;
  const alert = ready ? observation.attention : undefined;
  const status = activity === 'running' ? 'working' : activity === 'waiting' || activity === 'starting' ? 'pending' : activity === 'idle' ? 'idle' : 'unknown';
  const label = sourceTitle ? `Ask about ${sourceTitle}${unavailable ? ` · ${unavailable}` : observation ? ` · ${observationLabel(observation)}` : ''}`
    : disabled ? 'Select a session to use Ask' : 'Ask about the selected session';
  return <div ref={root} {...rootProps} data-pane-selection-ignore
    data-status={status} data-alert={alert}>
    <button ref={triggerRef} className="lab-session-popover-trigger lab-ask-trigger" type="button" aria-label="Ask about this session" aria-haspopup="dialog"
      disabled={disabled} onClick={onOpen}
      {...(floating ? { 'aria-keyshortcuts': 'ArrowLeft ArrowRight ArrowUp ArrowDown', 'aria-description': 'Drag to move, or focus and use arrow keys.' } : {})}
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
