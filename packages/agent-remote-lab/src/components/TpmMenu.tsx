import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useTrackingPosition } from '../hooks/useTrackingPosition.js';
import type { useTpmWork } from '../hooks/useTpmWork.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { groupTpmWorks, type TpmMainSession } from '../tpm-main-sessions.js';

export const tpmPhaseLabel = { clarifying: 'Clarifying', ready: 'Ready', implementing: 'Implementing', validating: 'Validating', completed: 'Completed' };

export function TpmMenu({ tpm, main, mainSessions, visible, triggerRef, inert, open, onOpenChange }: {
  mainSessions?: ReadonlyMap<string, TpmMainSession>; open: boolean; onOpenChange(open: boolean): void;
  tpm: ReturnType<typeof useTpmWork>; main?: SessionEntry; visible: boolean; triggerRef: RefObject<HTMLButtonElement>; inert: boolean;
}) {
  const { root, style, handlers } = useTrackingPosition('agent-remote:tpm-position');
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const [failure, setFailure] = useState<string>();
  const canCreate = tpm.canCreate(main);
  useEffect(() => {
    if (!visible) onOpenChange(false);
  }, [visible, onOpenChange]);
  useEffect(() => {
    if (!open || !visible) return;
    panel.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && !root.current?.contains(event.target) && !event.target.closest('.lab-tpm-viewport')) onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, visible, root, onOpenChange]);
  const close = () => { onOpenChange(false); triggerRef.current?.focus({ preventScroll: true }); };
  const activeWorks = tpm.works.filter(item => !item.work.archived);
  const archivedWorks = tpm.works.filter(item => item.work.archived);
  const unread = activeWorks.filter(item => item.unread).length;
  const needsUser = activeWorks.some(item => !item.work.paused && item.work.phase !== 'completed' && item.work.waiting === 'user');
  const supported = Object.values(tpm.catalogs).some(catalog => catalog.supported);
  const renderWork = (item: (typeof tpm.works)[number]) => <li key={item.key}>
        <button type="button" className="lab-session-row" data-tpm-work={item.key} aria-current={tpm.selected === item.key && tpm.expanded ? true : undefined} data-open={tpm.windows.includes(item.key) || undefined} onClick={() => { void tpm.open(item.key); }}>
          <span className="lab-tracked-description"><strong title={item.work.title}>{item.work.title}</strong>
            <small><span data-tpm-phase={item.work.phase}>{tpmPhaseLabel[item.work.phase]}</span>{item.work.archived && item.work.phase !== 'completed' ? ' · Stopped' : item.work.paused && item.work.phase !== 'completed' ? ' · Paused' : ''} · {item.work.providerId}</small>
            {item.work.summary ? <small className="lab-tpm-summary">{item.work.summary}</small> : null}
          </span>
          <span className="lab-tpm-markers">{!item.work.archived && !item.work.paused && item.work.phase !== 'completed' ? item.work.waiting === 'user' ? <span className="lab-tpm-needs-user">Needs you</span> : item.work.waiting === 'main_session' ? <small>Waiting on main</small> : null : null}
            {item.unread ? <span className="lab-tracked-change" aria-label={`New activity in ${item.work.title}`}><span aria-hidden="true" />New</span> : null}
            {!item.online ? <small>Host offline</small> : item.work.health ? <small className="lab-tpm-health">{item.work.health}</small> : null}</span>
        </button>
      </li>;
  const labels = new Map(mainSessions);
  if (main) labels.set(sessionKey(main), { ...labels.get(sessionKey(main)), ...main });
  const renderGroups = (items: typeof tpm.works) => groupTpmWorks(items, labels).map(group => <section key={group.key} className="lab-tpm-group" aria-label={`Main session: ${group.main.title}`}>
    <header className="lab-tpm-group-heading"><h3 title={group.main.title}>{group.main.title}</h3><span aria-label={`${group.works.length} TPM sessions`}>{group.works.length}</span>
      <small>{group.hostName} · {group.main.providerId}</small>
      {group.main.workspace ? <small title={group.main.workspace}>{group.main.workspace}</small> : null}
    </header>
    <ul className="lab-tpm-list">{group.works.map(renderWork)}</ul>
  </section>);
  return <div ref={root} style={style} {...handlers} className="lab-tracking-floating lab-tpm-floating" hidden={!visible} data-attention={needsUser} data-workspace-open={tpm.expanded}
    {...(inert ? { inert: '' } : {})} onKeyDown={event => {
      handlers.onKeyDown?.(event);
      if (event.key === 'Escape' && open && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <button ref={triggerRef} type="button" className="lab-session-popover-trigger" aria-label="TPM works" aria-expanded={open} aria-controls={id}
      title="TPM works · Drag to move, or focus and use arrow keys" onClick={() => { onOpenChange(!open); if (!open) void tpm.refresh(); }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9zM9 11l2 2 4-4M9 17h6" /></svg>
      <span>TPM</span><span className="lab-tpm-count">{activeWorks.length}</span>
      {unread ? <span className="lab-tracking-badge" aria-label={`${unread} works with new activity`} /> : needsUser ? <span className="lab-tracking-attention" aria-label="A TPM needs you" /> : null}
    </button>
    {open && visible ? <section ref={panel} id={id} tabIndex={-1} className="lab-session-popover-panel lab-tpm-panel" aria-label="TPM works">
      <div className="lab-directory-heading"><h2>TPM works</h2><button type="button" aria-label="Close TPM works" onClick={close}>×</button></div>
      {tpm.loading && !tpm.works.length ? <p className="lab-control-note" role="status">Loading TPM works…</p> : !activeWorks.length ? <p className="lab-control-note">{supported ? (archivedWorks.length ? 'No active TPM sessions.' : 'No TPM works yet.') : 'TPM is unavailable on these Controllers.'}</p> : null}
      {renderGroups(activeWorks)}
      {archivedWorks.length ? <details className="lab-tpm-archived"><summary>Archived ({archivedWorks.length})</summary>{renderGroups(archivedWorks)}</details> : null}
      {Object.entries(tpm.catalogs).filter(([, catalog]) => catalog.error).map(([host, catalog]) => <p key={host} className="lab-control-note" role="alert">{catalog.error}</p>)}
      {canCreate ? <button type="button" className="lab-tpm-create-trigger" aria-label="Create TPM work" disabled={!!tpm.busy} onClick={() => {
        if (!main) return;
        setFailure(undefined);
        void tpm.create(main).catch(error => setFailure(error instanceof Error ? error.message : 'Could not create the TPM session.'));
      }}>{tpm.busy === 'create' ? 'Creating…' : 'New TPM session'}</button> : supported ? <p className="lab-control-note">Choose a supported main session to create a TPM.</p> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
    </section> : null}
  </div>;
}
