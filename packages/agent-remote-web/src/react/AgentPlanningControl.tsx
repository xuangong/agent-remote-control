import { useEffect, useRef, useState } from 'react';
import type { AgentReplicaState } from '../replica/types.js';
import type { RemoteSessionStatus } from '../client/remote-session-client.js';

export interface AgentPlanningControlProps {
  readonly state: AgentReplicaState;
  readonly sessionStatus: RemoteSessionStatus;
  readonly onSetPlanning?: (active: boolean) => Promise<void>;
}

export function AgentPlanningControl({ state, sessionStatus, onSetPlanning }: AgentPlanningControlProps) {
  const [target, setTarget] = useState<boolean>();
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const inFlight = useRef(false);
  const agent = state.agent;
  const planning = agent?.runtimeInfo.planning;
  const supported = agent?.capabilities.planning === true;
  const pending = submitting || target !== undefined || planning?.requested !== undefined;
  const canChange = supported && planning !== undefined && sessionStatus === 'ready'
    && agent?.status === 'idle' && !agent.activeTurn && state.pendingInteractions.length === 0
    && !pending && onSetPlanning !== undefined;

  useEffect(() => {
    if (target !== undefined && planning?.active === target && planning.requested === undefined) setTarget(undefined);
  }, [planning?.active, planning?.requested, target]);

  async function change(): Promise<void> {
    if (!canChange || inFlight.current || !onSetPlanning) return;
    inFlight.current = true;
    setSubmitting(true);
    setFailure(undefined);
    const requested = !planning.active;
    setTarget(requested);
    try {
      await onSetPlanning(requested);
    } catch (error) {
      setTarget(undefined);
      setFailure(error instanceof Error && error.message ? error.message : 'Planning mode could not be changed.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return <section className="agent-planning-control" aria-label="Session planning mode">
    <div>
      <span>{planning?.active ? 'Planning' : planning ? 'Normal chat' : 'Planning mode'}</span>
      <button type="button" role="switch" aria-label="Planning mode" aria-checked={planning?.active === true} disabled={!canChange} onClick={() => void change()}>{planning?.active ? 'On' : 'Off'}</button>
    </div>
    <p className="agent-composer-note" role="status">{!supported ? 'Planning is not supported by this session.'
      : !planning ? 'Waiting for Provider planning state.'
      : pending ? 'Waiting for Provider confirmation.'
      : !canChange ? 'Planning can change only while connected and idle, with no pending interactions.'
      : 'Provider confirmed. Changes apply to the next message.'}</p>
    {failure ? <p className="agent-composer-note" role="alert">{failure}</p> : null}
  </section>;
}
