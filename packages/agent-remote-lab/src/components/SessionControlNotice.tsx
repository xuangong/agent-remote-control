import { useId, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { leaseNoticeLabel, leaseView, type AgentReplicaState, type SessionHandoffState } from '@orchardworks/agent-client';

import type { SessionTakeControlOptions } from '@orchardworks/agent-client';
export type TakeControlOptions = SessionTakeControlOptions;

export function SessionControlNotice({ control, handoff, connected, onTakeControl }: {
  control: NonNullable<AgentReplicaState['sessionControl']>;
  connected: boolean;
  handoff?: SessionHandoffState;
  onTakeControl?: (options?: TakeControlOptions) => Promise<void>;
}) {
  const t = useTranslate();
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ identity?: string; message: string }>();
  const identity = control.nativeOwner?.generation ?? control.revision;
  const currentFailure = handoff?.message ? handoff : failure?.identity === identity ? failure : undefined;
  const unknown = handoff?.phase === 'unknown';
  const phase = handoff && ['taking', 'checking', 'restoring'].includes(handoff.phase) ? handoff.phase : pending ? 'taking' : undefined;
  const lease = leaseView(control);
  const native = lease.native;
  if (lease.state === 'control' || lease.state === 'checking') return null;
  const takeControl = async () => {
    if (phase || !connected || !onTakeControl) return;
    setPending(true); setFailure(undefined);
    try { await onTakeControl(); }
    catch (error) {
      setFailure({ identity, message: error instanceof Error ? error.message : t('sessions.control.takeFailed') });
    } finally { setPending(false); }
  };
  // Every phase of taking over says the same thing to the person who asked for it.
  const label = phase ? t('sessions.control.taking') : leaseNoticeLabel(lease.state, t);
  const description = !phase && native ? t('sessions.control.interruptNote')
    : !phase && !connected ? t('sessions.control.waitReady') : undefined;
  return <div className="lab-session-control" data-read-only="true" data-native={native || undefined} aria-busy={!!phase}>
    <div className="lab-session-control-row">
      <span className="lab-session-control-owner" role="status">
        <svg className="lab-session-control-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        <span className="agent-visually-hidden">{t('sessions.control.readOnly')}</span><span>{label}</span>
      </span>
      {control.access === 'read_only' && onTakeControl ? <button type="button" disabled={!!phase || !connected}
        aria-describedby={description ? descriptionId : undefined}
        aria-label={phase ? label : unknown ? t('sessions.control.checkStatusLabel') : native ? t('sessions.control.interruptLabel') : t('sessions.control.takeControl')}
        onClick={() => void takeControl()}>{phase ? t('sessions.control.wait') : unknown ? t('sessions.control.checkStatus') : currentFailure ? t('common.retry') : native ? t('sessions.control.interruptAndTake') : t('sessions.control.takeControl')}</button> : null}
    </div>
    {description ? <p id={descriptionId} className="lab-session-control-description">{description}</p> : null}
    {currentFailure ? <p className="lab-session-control-error" role="alert">{currentFailure.message}</p> : null}
  </div>;
}
