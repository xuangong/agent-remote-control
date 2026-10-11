import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OpenedSession, SessionDirectoryClient, SuccessionActionResult, SuccessionDescription, SuccessionPrepareInput } from '../directory-client.js';

/** The dialog retains a single operation until its authoritative terminal result. */
export function SessionSuccessionDialog({ source, directory, assertAccess, assertSource, resume, resumeCancellation, onIntent, onCommitted, onClose }: {
  source: OpenedSession; directory: SessionDirectoryClient; assertAccess(): void; assertSource(): void;
  resume?: SuccessionPrepareInput; resumeCancellation?: boolean; onIntent(operation: SuccessionPrepareInput, cancelRequested: boolean): void; onCommitted(): Promise<void>; onClose(retain?: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), label = useId();
  const [description, setDescription] = useState<SuccessionDescription>();
  const [target, setTarget] = useState(''), [result, setResult] = useState<SuccessionActionResult>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const operation = useRef<SuccessionPrepareInput | undefined>(resume), inFlight = useRef(false), cancelling = useRef(false), settled = useRef<SuccessionActionResult>(), cancelRequested = useRef(resumeCancellation === true);
  const terminal = result && ['committed', 'cancelled', 'rejected'].includes(result.record.phase);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    let mounted = true;
    void (async () => {
      try {
        if (resume) return;
        assertSource();
        const value = await directory.describeSuccession(source.providerId, source.nativeSessionId);
        assertSource();
        if (mounted) { setDescription(value); setTarget(value.targets[0]?.providerId ?? ''); }
      } catch (failure) { if (mounted) setError(failure instanceof Error ? failure.message : 'Handoff eligibility could not be confirmed.'); }
    })();
    return () => { mounted = false; if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  async function accept(value: SuccessionActionResult) {
    if (value.record.operationId !== operation.current?.operationId) throw new Error('The Handoff response has a different operation identity. Check the original operation.');
    if (settled.current && ['committed', 'cancelled', 'rejected'].includes(settled.current.record.phase) && settled.current.record.phase !== value.record.phase) return;
    settled.current = value; setResult(value);
    if (value.record.phase === 'committed') await onCommitted();
  }
  async function run(action: 'prepare' | 'commit' | 'cancel' | 'status' | 'reconcile') {
    if (action === 'cancel') { if (cancelling.current) return; cancelling.current = true; }
    else { if (inFlight.current || cancelling.current) return; inFlight.current = true; }
    setBusy(true); setError(undefined);
    try {
      if (action === 'cancel' && operation.current) {
        cancelRequested.current = true;
        onIntent(operation.current, true);
      }
      assertAccess();
      if (action === 'commit' && cancelRequested.current) throw new Error('Cancellation was requested. Check or reconcile this operation; it will not be committed by this page.');
      if (action === 'prepare') {
        assertSource();
        if (!description || description.eligibility.status !== 'ready' || !description.targets.some(item => item.providerId === target)) throw new Error('The Host has not confirmed an eligible target.');
        const intent = operation.current ?? { operationId: crypto.randomUUID(), providerId: description.role.current.providerId,
          nativeSessionId: description.role.current.nativeSessionId, expectedRevision: description.role.revision, targetProviderId: target };
        onIntent(intent, false);
        operation.current = intent;
        const prepared = await directory.prepareSuccession(operation.current);
        await accept(prepared);
        if (prepared.record.phase === 'ready' && !cancelRequested.current && settled.current?.record.phase === 'ready') {
          assertAccess();
          await accept(await directory.successionAction('commit', operation.current.operationId));
        }
      } else if (operation.current) await accept(await directory.successionAction(action, operation.current.operationId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The outcome could not be confirmed. Check this same operation before continuing.');
    } finally { if (action === 'cancel') cancelling.current = false; else inFlight.current = false; setBusy(inFlight.current || cancelling.current); }
  }
  function close() { if (!inFlight.current && !cancelling.current) onClose(!!operation.current && !terminal); }
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog" aria-labelledby={label}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id={label}>Handoff session</h2><button type="button" aria-label="Close Handoff" disabled={busy} onClick={close}>×</button></header>
    <p>Source: {source.title || source.nativeSessionId} · {source.providerId}</p>
    <p>Same Host: {source.hostId}</p>
    {description ? <><p>Working directory: {description.role.workspace.canonicalCwd}</p>
      <label>Successor provider<select aria-label="Successor provider" value={target} disabled={busy || !!operation.current || description.eligibility.status !== 'ready'} onChange={event => setTarget(event.target.value)}>
        {description.targets.map(item => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}
      </select></label>
      {description.eligibility.status !== 'ready' ? <p role="status">{description.eligibility.reason}</p> : null}</> : !operation.current ? <p>Checking Host eligibility…</p> : null}
    <p className="lab-control-note">Preparation and commit send no model input. The successor receives quoted conversation history once, with its first real input. Existing Side and Ask conversations keep their history and drafts. The predecessor remains available in conversation history.</p>
    {operation.current ? <><p role="status">{busy ? 'Handoff in progress…' : result?.record.phase === 'committed' ? 'Handoff committed. Synchronizing the current session.' : `Handoff ${result?.record.phase ?? 'outcome unconfirmed'}`}</p>
      <p className="lab-control-note">Ordinary writes are gated by the Host during Handoff. An uncertain result retains this operation; checking it does not create another successor. Hiding this dialog keeps the operation available through Recover Handoff.</p>
      {cancelRequested.current ? <p>Cancellation requested. This page will not commit the operation; check status or retry cancellation to confirm its outcome.</p> : null}
      {result?.record.failureCode ? <p>{result.record.failureCode}</p> : null}
      {result?.record.phase === 'cancelled' ? <p>A created or late candidate is retained for inspection and will not become current.</p> : null}</> : null}
    {error ? <p role="alert">{error}</p> : null}
    <footer>{!operation.current ? <><button type="button" onClick={close}>Cancel</button><button type="button" className="lab-favorite-primary" disabled={busy || description?.eligibility.status !== 'ready' || !target} onClick={() => void run('prepare')}>Prepare and hand off</button></> : <>
      <button type="button" disabled={busy} onClick={() => void run('status')}>Check status</button>
      {!terminal ? <><button type="button" disabled={busy} onClick={() => void run('reconcile')}>Reconcile</button>
        {result?.record.phase === 'ready' && !cancelRequested.current ? <button type="button" disabled={busy} onClick={() => void run('commit')}>Commit Handoff</button> : null}
        <button type="button" disabled={cancelling.current} onClick={() => void run('cancel')}>Cancel Handoff</button>
        <button type="button" disabled={busy} onClick={close}>Hide Handoff</button></> : <button type="button" disabled={busy} onClick={close}>Done</button>}
    </>}</footer>
  </dialog>, document.body);
}
