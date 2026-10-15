import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenedSession, SuccessionActionResult, SuccessionDescription, SuccessionPrepareInput } from '../directory-client.js';
import type { SessionSuccessionDirectory } from '../session-succession-directory.js';
import './session-succession.css';
import type { NativePrefixSelection } from '@orchardworks/agent-remote-protocol';

type Action = 'prepare' | 'commit' | 'cancel' | 'status' | 'reconcile';
const statusDelays = [1000, 2000, 4000, 8000, 15000];
const isTerminal = (value?: SuccessionActionResult) => !!value && ['committed', 'cancelled', 'rejected'].includes(value.record.phase);
const providerName = (id: string) => ({ codex: 'Codex', 'claude-code': 'Claude Code', claude: 'Claude Code', copilot: 'Copilot', opencode: 'OpenCode' })[id] ?? id;
function preferredTarget(description: SuccessionDescription, initialProvider?: string): string {
  const requested = initialProvider?.toLowerCase();
  if (requested) return description.targets.find(item => item.providerId === requested)?.providerId
    ?? (requested === 'claude' ? description.targets.find(item => item.providerId === 'claude-code')?.providerId : undefined) ?? '';
  return description.targets.find(item => item.providerId === description.role.current.providerId)?.providerId
    ?? description.targets[0]?.providerId ?? '';
}

/** Retains one operation until both its outcome and the current conversation are confirmed. */
export function SessionSuccessionDialog({ source, directory, assertAccess, assertSource, resume, resumeCancellation, initialProvider, blockedReason, visible = true, onIntent, onSettled, onClose, onOpen, onGatedChange, preparation, autoPrepare = false, onPreparing }: {
  source: OpenedSession; directory: SessionSuccessionDirectory; assertAccess(): void; assertSource(): void;
  preparation?: NativePrefixSelection; autoPrepare?: boolean; onPreparing?(operation: SuccessionPrepareInput): Promise<void>;
  resume?: SuccessionPrepareInput; resumeCancellation?: boolean; initialProvider?: string; blockedReason?: string; visible?: boolean;
  onIntent(operation: SuccessionPrepareInput, cancelRequested: boolean): void;
  onSettled(result: SuccessionActionResult): Promise<void>; onClose(retain?: boolean): void | Promise<void>; onOpen?(): void; onGatedChange?(gated: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), label = useId(), detailsId = useId();
  const [description, setDescription] = useState<SuccessionDescription>();
  const [target, setTarget] = useState(''), [intent, setIntent] = useState(resume);
  const [result, setResult] = useState<SuccessionActionResult>();
  const [uncertain, setUncertain] = useState(!!resume);
  const [busy, setBusy] = useState(false), [cancelBusy, setCancelBusy] = useState(false);
  const [error, setError] = useState<string>(), [detailsOpen, setDetailsOpen] = useState(false);
  const [cancellation, setCancellation] = useState(resumeCancellation === true);
  const [projection, setProjection] = useState<'idle' | 'syncing' | 'failed' | 'done'>('idle');
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== 'hidden');
  const [wake, setWake] = useState(0);
  const operation = useRef(resume), inFlight = useRef(false), cancelling = useRef(false);
  const settled = useRef<SuccessionActionResult>(), cancelRequested = useRef(resumeCancellation === true);
  const mounted = useRef(false), projecting = useRef(false), projected = useRef(false);
  const closing = useRef(false), cleanupRequested = useRef(false);
  const statusAttempts = useRef(0), recoverImmediately = useRef(!!resume), accessBlocked = useRef(false);
  const callbacks = useRef({ assertAccess, assertSource, onIntent, onSettled, onClose, onGatedChange, onPreparing });
  callbacks.current = { assertAccess, assertSource, onIntent, onSettled, onClose, onGatedChange, onPreparing };
  const automaticPreparation = useRef(false);
  const terminal = isTerminal(result);
  const gated = !!intent && (!terminal || projection !== 'done');
  const statusExhausted = !!intent && !terminal && !busy && statusAttempts.current > statusDelays.length;
  const showChooser = visible && !intent && !autoPrepare;
  const expanded = visible && detailsOpen;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { callbacks.current.onGatedChange?.(gated); }, [gated, onGatedChange]);
  useEffect(() => {
    if (!showChooser) return;
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, [showChooser]);
  useEffect(() => {
    if (operation.current) return;
    let active = true;
    void (async () => {
      try {
        callbacks.current.assertAccess();
        callbacks.current.assertSource();
        const value = await directory.describeSuccession(source.providerId, source.nativeSessionId, preparation);
        if (!active || !mounted.current) return;
        callbacks.current.assertSource();
        setDescription(value);
        setTarget(preferredTarget(value, initialProvider));
      } catch (failure) {
        if (active && mounted.current) setError(failure instanceof Error ? failure.message : 'Handoff availability could not be confirmed.');
      }
    })();
    return () => { active = false; };
  }, [directory, source.providerId, source.nativeSessionId, initialProvider, preparation]);
  useEffect(() => {
    const awaken = () => {
      setPageVisible(document.visibilityState !== 'hidden');
      if (accessBlocked.current && statusAttempts.current <= statusDelays.length) { accessBlocked.current = false; statusAttempts.current = 0; }
      setWake(value => value + 1);
    };
    document.addEventListener('visibilitychange', awaken);
    window.addEventListener('focus', awaken);
    window.addEventListener('online', awaken);
    return () => {
      document.removeEventListener('visibilitychange', awaken);
      window.removeEventListener('focus', awaken);
      window.removeEventListener('online', awaken);
    };
  }, []);
  const priorVisible = useRef(visible);
  useEffect(() => {
    if (visible && !priorVisible.current && operation.current) setDetailsOpen(true);
    if (!visible) setDetailsOpen(false);
    priorVisible.current = visible;
  }, [visible]);

  async function refreshSettled() {
    if (!mounted.current || projecting.current || projected.current) return;
    const value = settled.current;
    if (!value || !isTerminal(value)) return;
    projecting.current = true;
    setProjection('syncing');
    setError(undefined);
    try {
      callbacks.current.assertAccess();
      await callbacks.current.onSettled(value);
      if (!mounted.current) return;
      if (value.record.phase === 'committed' || cleanupRequested.current) await callbacks.current.onClose(false);
      if (!mounted.current) return;
      projected.current = true;
      setProjection('done');
      callbacks.current.onGatedChange?.(false);
    } catch (failure) {
      if (mounted.current) {
        setProjection('failed');
        setError(failure instanceof Error ? failure.message : 'The current conversation could not be refreshed.');
      }
    } finally { projecting.current = false; }
  }
  async function accept(value: SuccessionActionResult) {
    if (!mounted.current) return;
    if (value.record.operationId !== operation.current?.operationId) throw new Error('The Handoff response has a different operation identity. Check the original operation.');
    if (isTerminal(settled.current) && settled.current?.record.phase !== value.record.phase) return;
    settled.current = value;
    setResult(value);
    setUncertain(value.record.phase === 'unknown');
    if (isTerminal(value)) await refreshSettled();
  }
  async function run(action: Action, automatic = false) {
    if (!mounted.current || projecting.current || closing.current) return;
    if (action === 'prepare' && blockedReason) { setError(blockedReason); return; }
    if (action === 'cancel') {
      if (cancelling.current || isTerminal(settled.current)) return;
      cancelling.current = true;
      setCancelBusy(true);
    } else {
      if (inFlight.current || cancelling.current) return;
      inFlight.current = true;
    }
    if (!automatic) statusAttempts.current = 0;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'cancel' && operation.current) {
        cancelRequested.current = true;
        setCancellation(true);
        callbacks.current.onIntent(operation.current, true);
      }
      try { callbacks.current.assertAccess(); accessBlocked.current = false; }
      catch (failure) { accessBlocked.current = true; throw failure; }
      if (action === 'commit' && cancelRequested.current) throw new Error('Cancellation was requested. Check or reconcile this operation before continuing.');
      if (action === 'prepare') {
        callbacks.current.assertSource();
        if (operation.current) throw new Error('A Handoff is already retained. Check the original operation.');
        if (!description || description.eligibility.status !== 'ready' || !description.targets.some(item => item.providerId === target)) throw new Error('An eligible target has not been confirmed.');
        if (preparation && (description.role.current.providerId !== source.providerId || description.role.current.nativeSessionId !== source.nativeSessionId)) {
          throw new Error('The selected prompt belongs to a retired native session. Reopen its current view before editing.');
        }
        const pending = { operationId: crypto.randomUUID(), providerId: description.role.current.providerId,
          nativeSessionId: description.role.current.nativeSessionId, expectedRevision: description.role.revision, targetProviderId: target,
          ...(preparation ? { preparation } : {}) };
        await callbacks.current.onPreparing?.(pending);
        if (!mounted.current) return;
        callbacks.current.assertAccess();
        callbacks.current.assertSource();
        callbacks.current.onIntent(pending, false);
        operation.current = pending;
        setIntent(pending);
        setDetailsOpen(false);
        const prepared = await directory.prepareSuccession(pending);
        if (!mounted.current) return;
        await accept(prepared);
        if (prepared.record.phase === 'ready' && !cancelRequested.current && settled.current?.record.phase === 'ready') {
          callbacks.current.assertAccess();
          callbacks.current.assertSource();
          await accept(await directory.actOnSuccession('commit', pending));
        }
      } else if (operation.current) {
        if (action === 'commit' && operation.current.preparation?.kind === 'native_prefix') callbacks.current.assertSource();
        const value = await directory.actOnSuccession(action, operation.current);
        await accept(value);
      }
    } catch (failure) {
      if (mounted.current) {
        if (operation.current && !isTerminal(settled.current)) setUncertain(true);
        setError(failure instanceof Error ? failure.message : 'The outcome could not be confirmed. Check the same Handoff before continuing.');
      }
    } finally {
      if (action === 'cancel') cancelling.current = false;
      else inFlight.current = false;
      if (mounted.current) { setCancelBusy(cancelling.current); setBusy(inFlight.current || cancelling.current); setWake(value => value + 1); }
    }
  }
  const runCurrent = useRef(run);
  runCurrent.current = run;
  useEffect(() => {
    if (!autoPrepare || !description || operation.current || automaticPreparation.current) return;
    automaticPreparation.current = true;
    if (description.eligibility.status === 'ready') void runCurrent.current('prepare');
  }, [autoPrepare, description]);
  useEffect(() => {
    if (!intent || terminal || busy || !pageVisible || statusAttempts.current > statusDelays.length) return;
    const observe = () => {
      if (!mounted.current || inFlight.current || cancelling.current || document.visibilityState === 'hidden') return;
      recoverImmediately.current = false;
      statusAttempts.current += 1;
      void runCurrent.current('status', true);
    };
    if (recoverImmediately.current) { observe(); return; }
    const timer = window.setTimeout(observe, statusDelays[Math.min(statusAttempts.current, statusDelays.length - 1)]);
    return () => window.clearTimeout(timer);
  }, [intent, terminal, busy, pageVisible, wake]);

  async function close() {
    if (closing.current) return;
    closing.current = true;
    const retain = !!operation.current && (!isTerminal(settled.current) || !projected.current);
    if (!retain) cleanupRequested.current = true;
    try {
      await callbacks.current.onClose(retain);
      if (mounted.current) setDetailsOpen(false);
    } catch (failure) {
      if (mounted.current) {
        if (isTerminal(settled.current)) { projected.current = false; setProjection('failed'); }
        setError(failure instanceof Error ? failure.message : 'The operation snapshot could not be released. Retry cleanup.');
      }
    } finally { closing.current = false; }
  }
  function openDetails() { setDetailsOpen(true); onOpen?.(); }
  const targetId = intent?.targetProviderId ?? target;
  const targetLabel = description?.targets.find(item => item.providerId === targetId)?.displayName ?? providerName(targetId || source.providerId);
  const cwd = description?.role.workspace.canonicalCwd ?? result?.role.workspace.canonicalCwd;
  const phase = result?.record.phase;
  const terminalMessage = phase === 'committed' ? 'Handoff complete.' : phase === 'cancelled' ? 'Handoff cancelled.' : 'Handoff could not be completed.';
  const progress = terminal ? `${terminalMessage}${projection === 'failed' ? ' Refresh the conversation to continue.' : projection !== 'done' ? ' Refreshing the conversation…' : ''}`
    : statusExhausted ? 'Automatic checks stopped. Open Details to continue this Handoff.'
    : cancellation ? 'Cancellation requested. Confirming the outcome…'
    : busy && !result && !uncertain ? `Handing off to ${targetLabel}…`
    : phase === 'ready' && !uncertain ? 'Handoff is ready. Review the next step in Details.'
    : !uncertain && phase && phase !== 'unknown' ? `Handing off to ${targetLabel}…`
    : 'Handoff is not yet confirmed. Your conversation is preserved.';

  if (showChooser) return createPortal(<dialog ref={dialog} className="lab-favorite-dialog lab-handoff-chooser" aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id={label}>Hand off conversation</h2><button type="button" aria-label="Close Handoff" onClick={close}>×</button></header>
    <form onSubmit={event => { event.preventDefault(); void run('prepare'); }}>
      <p className="lab-handoff-source">Continue from {source.title || 'this conversation'}.</p>
      {description ? <>
        <label>Provider<select aria-label="Successor provider" value={target} disabled={busy || description.eligibility.status !== 'ready'} onChange={event => setTarget(event.target.value)}>
          {!target ? <option value="" disabled>Choose a provider</option> : null}
          {description.targets.map(item => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}
        </select></label>
        <p className="lab-handoff-workspace">{cwd}</p>
        {initialProvider && !target ? <p role="status">The requested provider “{initialProvider}” is not available. Choose an available provider to continue.</p> : null}
        {description.eligibility.status !== 'ready' ? <p role="status">{description.eligibility.reason}</p> : null}
      </> : <p role="status">Checking availability…</p>}
      <p className="lab-handoff-context">Conversation context carries over with your next message. This step sends no message.</p>
      {blockedReason ? <p role="status">{blockedReason}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer><button type="button" onClick={close}>Cancel</button><button type="submit" className="lab-favorite-primary" disabled={busy || !!blockedReason || description?.eligibility.status !== 'ready' || !target}>Hand off</button></footer>
    </form>
  </dialog>, document.body);
  if (!intent) return autoPrepare ? <section className="lab-handoff-notice" aria-label="Edit prompt">
    <p role={error ? 'alert' : 'status'}>{error ?? (description?.eligibility.status !== 'ready' ? description?.eligibility.reason : undefined) ?? 'Preparing selected prompt…'}</p>
    {error && !busy ? <button type="button" onClick={cleanupRequested.current ? close : () => void run('prepare')}>{cleanupRequested.current ? 'Retry cleanup' : 'Retry preparation'}</button> : null}
    <button type="button" onClick={close}>Close</button>
  </section> : null;
  return <section className="lab-handoff-notice" aria-label="Handoff">
    <div className="lab-handoff-summary">
      <div className="lab-handoff-message"><p role="status" aria-live="polite" title={progress}>{progress}</p></div>
      <div className="lab-handoff-quick-actions">
        {projection === 'failed' ? <button type="button" onClick={() => void refreshSettled()}>Retry refresh</button> : null}
        <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={expanded ? close : openDetails}>{expanded ? 'Hide details' : 'Details'}</button>
      </div>
    </div>
    {expanded ? <div className="lab-handoff-details" id={detailsId}>
      <dl><div><dt>Source</dt><dd>{source.title || source.nativeSessionId}</dd></div><div><dt>Provider</dt><dd>{targetLabel}</dd></div>
        {cwd ? <div><dt>Workspace</dt><dd>{cwd}</dd></div> : null}
        <div><dt>Operation</dt><dd>{intent.operationId}</dd></div><div><dt>Status</dt><dd>{phase ?? 'unconfirmed'}</dd></div>
        <div><dt>Host</dt><dd>{source.hostId ?? 'local'}</dd></div></dl>
      <p>Checking status keeps this operation. Reconcile asks the Host to inspect an uncertain result.</p>
      {statusExhausted ? <p>Automatic checks stopped. Check status, reconcile this operation, or request cancellation. The current conversation remains protected until the outcome is confirmed.</p> : null}
      {cancellation ? <p>Cancellation requested. This page will not commit the operation.</p> : null}
      {phase === 'cancelled' ? <p>A created or late candidate remains available for inspection.</p> : null}
      {result?.record.failureCode ? <p>{result.record.failureCode}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="lab-handoff-controls">
        {!terminal ? <button type="button" disabled={busy} onClick={() => void run('status')}>Check status</button> : null}
        {!terminal ? <>
          <button type="button" disabled={busy} onClick={() => void run('reconcile')}>Reconcile</button>
          {phase === 'ready' && !cancellation ? <button type="button" disabled={busy} onClick={() => void run('commit')}>Commit Handoff</button> : null}
          <button type="button" disabled={cancelBusy} onClick={() => void run('cancel')}>Cancel Handoff</button>
          <button type="button" onClick={close}>Hide Handoff</button>
        </> : projection !== 'failed' && projection !== 'syncing' ? <button type="button" onClick={close}>Done</button> : <button type="button" onClick={close}>Hide Handoff</button>}
      </div>
    </div> : null}
  </section>;
}
