import { useEffect, useRef, useState } from 'react';
import { errorWords, remoteSessionState, type RemoteSessionState, type AgentReplicaState, type RemoteSessionStatus, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from './locale.js';

export interface AgentPlanningControlProps {
  readonly sessionState?: RemoteSessionState;
  readonly state: AgentReplicaState;
  readonly sessionStatus: RemoteSessionStatus;
  readonly onSetPlanning?: (active: boolean) => Promise<void>;
}

export function AgentPlanningControl({ state, sessionState, sessionStatus, onSetPlanning }: AgentPlanningControlProps) {
  const t = useTranslate();
  const [target, setTarget] = useState<boolean>();
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const inFlight = useRef(false);
  const agent = state.agent;
  const planning = agent?.runtimeInfo.planning;
  const session = sessionState ?? remoteSessionState(state, sessionStatus);
  const connection = session.runtime;
  const recoveryMessage = planningRecoveryMessage(connection?.state, t);
  const supported = agent?.capabilities.planning === true;
  const pending = submitting || target !== undefined || planning?.requested !== undefined;
  const canChange = planning !== undefined && session.operations.set_planning.allowed
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
      setFailure(errorWords(error, t, 'composer.planning.changeFailed'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return <section className="agent-planning-control" aria-label={t('composer.planning.region')}>
    <div>
      <span>{planning?.active ? t('composer.planning.planning') : planning ? t('composer.planning.normal') : t('composer.planning.mode')}</span>
      <button type="button" role="switch" aria-label={t('composer.planning.mode')} aria-checked={planning?.active === true} disabled={!canChange} onClick={() => void change()}>{planning?.active ? t('common.on') : t('common.off')}</button>
    </div>
    <p className="agent-composer-note" role="status">{!supported ? t('composer.planning.unsupported')
      : !planning ? t('composer.planning.waitingState')
      : session.readOnly ? t('composer.planning.readOnly')
      : recoveryMessage ?? (pending ? t('composer.planning.waitingConfirm')
      : !canChange ? t('composer.planning.idleOnly')
      : t('composer.planning.confirmed'))}</p>
    {failure ? <p className="agent-composer-note" role="alert">{failure}</p> : null}
  </section>;
}

function planningRecoveryMessage(state: 'connected' | 'reconnecting' | 'restoring' | 'unavailable' | undefined, t: Translate): string | undefined {
  if (state === 'reconnecting') return t('composer.planning.reconnecting');
  if (state === 'restoring') return t('composer.planning.restoring');
  if (state === 'unavailable') return t('composer.planning.unavailable');
  return undefined;
}
