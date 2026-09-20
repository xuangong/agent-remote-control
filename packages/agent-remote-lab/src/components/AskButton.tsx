import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import { observationLabel, type SessionObservation } from '../tracking-state.js';

export function AskButton({ observation, hidden, disabled, onOpen }: {
  observation?: SessionObservation; hidden: boolean; disabled: boolean; onOpen(): void;
}) {
  const { root, style, handlers } = useTrackingPosition('agent-remote-ask-position', '.lab-ask-trigger');
  const ready = observation?.connection === 'ready';
  const activity = ready ? observation.activity : undefined;
  const alert = ready ? observation.attention : undefined;
  const status = activity === 'running' ? 'working' : activity === 'waiting' || activity === 'starting' ? 'pending' : activity === 'idle' ? 'idle' : 'unknown';
  const label = observation ? observationLabel(observation) : 'Ask about this conversation';
  return <div className="lab-ask-floating" ref={root} style={style} {...handlers} data-hidden={hidden || undefined} aria-hidden={hidden || undefined}
    data-status={status} data-alert={alert}>
    <button className="lab-ask-trigger" type="button" aria-label="Ask about this session" aria-haspopup="dialog" aria-expanded={hidden}
      tabIndex={hidden ? -1 : undefined} disabled={disabled} onClick={onOpen}
      title={`${label}. Drag to move, or focus and use arrow keys`}>
      <span aria-hidden="true">?</span> Ask
      <span className="agent-visually-hidden" role="status">{label}{alert ? '. New status needs attention.' : ''}</span>
    </button>
  </div>;
}
