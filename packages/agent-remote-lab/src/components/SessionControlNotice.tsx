import { useId, useState } from 'react';
import type { AgentReplicaState, SessionHandoffState } from '@orchardworks/agent-remote-web';

import type { SessionTakeControlOptions } from '@orchardworks/agent-remote-web/react';
export type TakeControlOptions = SessionTakeControlOptions;

export function SessionControlNotice({ control, handoff, connected, onTakeControl }: {
  control: NonNullable<AgentReplicaState['sessionControl']>;
  connected: boolean;
  handoff?: SessionHandoffState;
  onTakeControl?: (options?: TakeControlOptions) => Promise<void>;
}) {
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ identity?: string; message: string }>();
  const identity = control.nativeOwner?.generation ?? control.revision;
  const currentFailure = handoff?.message ? handoff : failure?.identity === identity ? failure : undefined;
  const unknown = handoff?.phase === 'unknown';
  const phase = handoff && ['taking', 'checking', 'restoring'].includes(handoff.phase) ? handoff.phase : pending ? 'taking' : undefined;
  const native = !!control.nativeOwner;
  if (control.access === 'control') return null;
  const takeControl = async () => {
    if (phase || !connected || !onTakeControl) return;
    setPending(true); setFailure(undefined);
    try { await onTakeControl(); }
    catch (error) {
      setFailure({ identity, message: error instanceof Error ? error.message : 'Could not take control. Try again when connected.' });
    } finally { setPending(false); }
  };
  const label = phase === 'restoring' ? 'Restoring session…' : phase === 'checking' ? 'Checking session…'
    : phase === 'taking' ? 'Taking control…'
    : control.access === 'unsupported' ? 'Controller update needed'
    : control.access === 'checking' ? 'Checking control…'
    : control.nativeOwner?.kind === 'native_cli' ? 'Native CLI has control'
    : control.nativeOwner ? 'Another Controller has control'
    : control.available ? 'Ready to take control'
    : control.ownerKind === 'web' ? 'Another page has control'
    : control.ownerKind === 'headless' ? 'Remote CLI has control' : 'Another client has control';
  const description = control.access === 'unsupported' ? 'Update this Host’s Controller to enable session control.'
    : phase === 'restoring' ? 'Control will be available after synchronization.'
    : !phase && native ? 'Taking over interrupts its running work.'
    : !phase && !connected ? 'Reconnect to take control.' : undefined;
  return <div className="lab-session-control" data-read-only="true" data-native={native || undefined} aria-busy={!!phase}>
    <div className="lab-session-control-row">
      <span className="lab-session-control-owner" role="status">
        <svg className="lab-session-control-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
        <span className="agent-visually-hidden">Read only</span><span>{label}</span>
      </span>
      {control.access === 'read_only' && onTakeControl ? <button type="button" disabled={!!phase || !connected}
        aria-describedby={description ? descriptionId : undefined}
        aria-label={phase ? label : unknown ? 'Check session status' : native ? 'Interrupt and take control' : 'Take control'}
        onClick={() => void takeControl()}>{phase ? 'Please wait…' : unknown ? 'Check status' : currentFailure ? 'Retry' : native ? 'Interrupt & take over' : 'Take control'}</button> : null}
    </div>
    {description ? <p id={descriptionId} className="lab-session-control-description">{description}</p> : null}
    {currentFailure ? <p className="lab-session-control-error" role="alert">{currentFailure.message}</p> : null}
  </div>;
}
