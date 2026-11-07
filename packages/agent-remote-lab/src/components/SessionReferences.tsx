import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { SessionDirectoryClient, type SessionSummary } from '../directory-client.js';
import { changeSessionRef, useSessionRefs, type LabSessionRef, type LabSessionReferrer, type SessionRefHolder } from '../session-references.js';
import { ForkIcon } from './ForkReference.js';

/** The `/ref` command: picks a session of the same Host for this session to reference. */
export const refCommand = { id: 'console:ref', name: 'ref', kind: 'command' as const, description: 'Reference another session of this Host' };

const title = (ref: Pick<LabSessionRef, 'title'>) => ref.title || 'Untitled session';

/**
 * The sessions a session references, above its composer: the source it was opened from and sessions the user added.
 * Removing one, the source included, is a change the agent hears about with the next message. Hosts that predate
 * references show the fallback, the source as it was shown before. snapshot: the context a fork copied, which is not a
 * reference and stays shown beside them.
 */
export function SessionReferences({ scope, holder, providers, fallback, snapshot, shown, picking, onPickingChange, onOpen, onRemoved, onRestore }: {
  scope: string; holder: SessionRefHolder; providers: readonly string[]; fallback?: ReactNode; snapshot?: ReactNode;
  /** Sessions the page already lists beside this one, such as its Sides, as provider/native keys. */
  shown?: ReadonlySet<string>;
  picking: boolean; onPickingChange(picking: boolean): void;
  onOpen(ref: Pick<LabSessionRef, 'providerId' | 'nativeSessionId' | 'title'>): void;
  /** After the Host removed a reference; restore() adds it back. */
  onRemoved?(ref: LabSessionRef, restore: () => Promise<void>): void | Promise<void>;
  onRestore?(ref: LabSessionRef): void | Promise<void>;
}) {
  const entry = useSessionRefs(scope, holder);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  if (entry.unsupported || !entry.value) return entry.unsupported || !picking ? <>{fallback}</> : null;
  const refs = entry.value.refs, referrers = (entry.value.referencedBy ?? []).filter(ref => !shown?.has(`${ref.providerId}/${ref.nativeSessionId}`));
  const referencedBy = referrers.length ? <ReferencedBy referrers={referrers} onOpen={onOpen} /> : null;
  if (!refs.length && !picking) return <>{snapshot}{referencedBy}</>;
  const change = async (action: 'add' | 'remove', ref: Pick<LabSessionRef, 'providerId' | 'nativeSessionId'>, label: string) => {
    if (pending) return;
    setPending(label); setError(undefined);
    try { await changeSessionRef(scope, holder, action, ref); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The reference could not be changed. Try again.'); return false; }
    finally { setPending(undefined); }
  };
  const remove = async (ref: LabSessionRef) => {
    if (!await change('remove', ref, `remove:${ref.providerId}/${ref.nativeSessionId}`)) return;
    await onRemoved?.(ref, async () => { await changeSessionRef(scope, holder, 'add', ref); await onRestore?.(ref); });
  };
  // The references belong to the next message, so they sit on the composer, below who references this session.
  return <>{snapshot}{referencedBy}<div className="lab-session-refs" aria-label="Session references">
    <div className="lab-session-ref-list">{refs.map(ref => <span key={`${ref.providerId}/${ref.nativeSessionId}`} className="lab-session-ref" data-origin={ref.origin}>
      <button type="button" className="lab-session-ref-open" title={`${ref.origin === 'source' ? 'Source' : 'Reference'}: ${title(ref)}`} onClick={() => onOpen(ref)}>
        {ref.origin === 'source' ? <span className="lab-fork-symbol" aria-hidden="true">&amp;<span><ForkIcon /></span></span> : <span className="lab-session-ref-symbol" aria-hidden="true">@</span>}
        <span className="lab-session-ref-title">{title(ref)}</span>
      </button>
      <button type="button" className="lab-session-ref-remove" aria-label={`Remove reference to ${title(ref)}`} title="Remove reference"
        disabled={!!pending} onClick={() => void remove(ref)}>×</button>
    </span>)}</div>
    <button type="button" className="lab-session-ref-add" aria-label="Reference another session" title="Reference another session" aria-expanded={picking}
      onClick={() => onPickingChange(!picking)}>+</button>
    {picking ? <SessionRefPicker scope={scope} holder={holder} providers={providers} existing={refs} busy={!!pending}
      onCancel={() => onPickingChange(false)} onPick={session => void change('add', session, `add:${session.providerId}/${session.nativeSessionId}`).then(added => { if (added) onPickingChange(false); })} /> : null}
    {error ? <p className="lab-fork-action-error" role="alert">{error}</p> : null}
  </div></>;
}

/** The sessions that reference this one; Sides opened from it first. */
function ReferencedBy({ referrers, onOpen }: { referrers: readonly LabSessionReferrer[]; onOpen(ref: LabSessionReferrer): void }) {
  const ordered = [...referrers].sort((left, right) => Number(right.origin === 'source') - Number(left.origin === 'source'));
  return <div className="lab-session-refs lab-session-referrers" aria-label="Referenced by">
    <span className="lab-session-referrers-label">Referenced by</span>
    {ordered.map(ref => <button type="button" key={`${ref.providerId}/${ref.nativeSessionId}`} className="lab-session-ref lab-session-ref-open"
      data-origin={ref.origin} title={`${ref.origin === 'source' ? 'Opened from this session' : 'References this session'}: ${title(ref)}`} onClick={() => onOpen(ref)}>
      <span className="lab-session-ref-symbol" aria-hidden="true">{ref.origin === 'source' ? '↳' : '@'}</span>
      <span className="lab-session-ref-title">{title(ref)}</span>
    </button>)}
  </div>;
}

/** The Host's recent sessions, filtered by title, to reference from this one. */
function SessionRefPicker({ scope, holder, providers, existing, busy, onPick, onCancel }: {
  scope: string; holder: SessionRefHolder; providers: readonly string[]; existing: readonly LabSessionRef[]; busy: boolean;
  onPick(session: SessionSummary): void; onCancel(): void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [failure, setFailure] = useState<string>();
  const [filter, setFilter] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const label = useId();
  const providerKey = providers.join('\n');
  useEffect(() => {
    const controller = new AbortController();
    const client = new SessionDirectoryClient(scope, undefined, holder.hostId ?? 'local');
    void Promise.allSettled(providerKey.split('\n').filter(Boolean).map(providerId => client.list(providerId, undefined, controller.signal))).then(results => {
      if (controller.signal.aborted) return;
      const listed = results.flatMap(result => result.status === 'fulfilled' ? result.value.items : []);
      if (!listed.length && results.some(result => result.status === 'rejected')) setFailure('Sessions could not be listed. Try again.');
      setSessions(listed.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
    });
    return () => controller.abort();
  }, [scope, holder.hostId, providerKey]);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  const visible = useMemo(() => (sessions ?? []).filter(session => !(session.providerId === holder.providerId && session.nativeSessionId === holder.nativeSessionId)
    && !existing.some(ref => ref.providerId === session.providerId && ref.nativeSessionId === session.nativeSessionId)
    && (session.title || '').toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 30), [sessions, existing, filter, holder.providerId, holder.nativeSessionId]);
  return <div className="lab-session-ref-picker" role="dialog" aria-labelledby={label} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <strong id={label}>Reference a session</strong>
    <input ref={input} type="search" value={filter} placeholder="Filter by title" aria-label="Filter sessions by title" onChange={event => setFilter(event.target.value)} />
    {sessions === undefined ? <p className="lab-control-note" role="status">Loading sessions…</p> : null}
    {failure ? <p className="lab-fork-action-error" role="alert">{failure}</p> : null}
    {sessions && !visible.length && !failure ? <p className="lab-control-note">No other sessions match.</p> : null}
    {visible.length ? <ul>{visible.map(session => <li key={`${session.providerId}/${session.nativeSessionId}`}>
      <button type="button" disabled={busy} onClick={() => onPick(session)}>
        <span className="lab-session-ref-title">{session.title || 'Untitled session'}</span>
        <small>{session.providerId} · {new Date(session.updatedAt).toLocaleString()}</small>
      </button>
    </li>)}</ul> : null}
    <button type="button" onClick={onCancel}>Cancel</button>
  </div>;
}
