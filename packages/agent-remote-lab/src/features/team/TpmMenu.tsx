import { errorWords } from '@orchardworks/agent-client';
import { useContext, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useTrackingPosition } from '../../kernel/useTrackingPosition.js';
import { ShortcutPlacement } from '../../kernel/shortcut-placement.js';
import type { useTpmWork } from './useTpmWork.js';
import { sessionKey, type SessionEntry } from '../../kernel/session-tree.js';
import { groupTpmWorks, type TpmMainSession } from '../../kernel/tpm-main-sessions.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { enumWords } from './team-words.js';

export const tpmPhaseWords = { clarifying: 'team.tpm.phase.clarifying', ready: 'team.tpm.phase.ready', implementing: 'team.tpm.phase.implementing',
  validating: 'team.tpm.phase.validating', completed: 'team.tpm.phase.completed' } as const;

export function TpmMenu({ tpm, main, mainSessions, visible, triggerRef, inert, open, onOpenChange }: {
  mainSessions?: ReadonlyMap<string, TpmMainSession>; open: boolean; onOpenChange(open: boolean): void;
  tpm: ReturnType<typeof useTpmWork>; main?: SessionEntry; visible: boolean; triggerRef: RefObject<HTMLButtonElement>; inert: boolean;
}) {
  const t = useTranslate();
  const placement = useContext(ShortcutPlacement), floating = placement === 'floating';
  const { root, style, handlers, edge } = useTrackingPosition('agent-remote:tpm-position', undefined, { enabled: floating });
  const rootProps = floating ? { style, ...handlers, 'data-edge': edge, className: 'lab-tracking-floating lab-tpm-floating' }
    : placement === 'bar' ? { className: 'lab-launcher lab-launcher-tpm' } : { className: 'lab-sidebar-shortcut lab-sidebar-shortcut-tpm' };
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
            <small><span data-tpm-phase={item.work.phase}>{enumWords(t, tpmPhaseWords, item.work.phase)}</span>{item.work.archived && item.work.phase !== 'completed' ? ` · ${t('team.tpm.stopped')}` : item.work.paused && item.work.phase !== 'completed' ? ` · ${t('team.tpm.paused')}` : ''} · {item.work.providerId}</small>
            {item.work.summary ? <small className="lab-tpm-summary">{item.work.summary}</small> : null}
          </span>
          <span className="lab-tpm-markers">{!item.work.archived && !item.work.paused && item.work.phase !== 'completed' ? item.work.waiting === 'user' ? <span className="lab-tpm-needs-user">{t('team.tpm.needsYou')}</span> : item.work.waiting === 'main_session' ? <small>{t('team.tpm.waitingOnMain')}</small> : null : null}
            {item.unread ? <span className="lab-tracked-change" aria-label={t('team.tpm.newActivityIn', { title: item.work.title })}><span aria-hidden="true" />{t('common.new')}</span> : null}
            {!item.online ? <small>{t('team.tpm.hostOffline')}</small> : item.work.health ? <small className="lab-tpm-health">{item.work.health}</small> : null}</span>
        </button>
      </li>;
  const labels = new Map(mainSessions);
  if (main) labels.set(sessionKey(main), { ...labels.get(sessionKey(main)), ...main });
  const renderGroups = (items: typeof tpm.works) => groupTpmWorks(items, labels).map(group => <section key={group.key} className="lab-tpm-group" aria-label={t('team.tpm.mainSessionNamed', { title: group.main.title })}>
    <header className="lab-tpm-group-heading"><h3 title={group.main.title}>{group.main.title}</h3><span aria-label={t('team.tpm.sessionCount', { count: group.works.length })}>{group.works.length}</span>
      <small>{group.hostName} · {group.main.providerId}</small>
      {group.main.workspace ? <small title={group.main.workspace}>{group.main.workspace}</small> : null}
    </header>
    <ul className="lab-tpm-list">{group.works.map(renderWork)}</ul>
  </section>);
  return <div ref={root} {...rootProps} hidden={!visible} data-attention={needsUser} data-workspace-open={tpm.expanded}
    {...(inert ? { inert: '' } : {})} onKeyDown={event => {
      if (floating) handlers.onKeyDown?.(event);
      if (event.key === 'Escape' && open && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <button ref={triggerRef} type="button" className="lab-session-popover-trigger" aria-label={t('team.tpm.works')} aria-expanded={open} aria-controls={id}
      title={floating ? t('team.tpm.worksDraggable') : t('team.tpm.works')} onClick={() => { onOpenChange(!open); if (!open) void tpm.refresh(); }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9zM9 11l2 2 4-4M9 17h6" /></svg>
      <span>TPM</span><span className="lab-tpm-count">{activeWorks.length}</span>
      {unread ? <span className="lab-tracking-badge" aria-label={t('team.tpm.worksWithActivity', { count: unread })} /> : needsUser ? <span className="lab-tracking-attention" aria-label={t('team.tpm.oneNeedsYou')} /> : null}
    </button>
    {open && visible ? <section ref={panel} id={id} tabIndex={-1} className="lab-session-popover-panel lab-tpm-panel" aria-label={t('team.tpm.works')}>
      <div className="lab-directory-heading"><h2>{t('team.tpm.works')}</h2><button type="button" aria-label={t('team.tpm.closeWorks')} onClick={close}>×</button></div>
      {tpm.loading && !tpm.works.length ? <p className="lab-control-note" role="status">{t('team.tpm.loadingWorks')}</p> : !activeWorks.length ? <p className="lab-control-note">{supported ? (archivedWorks.length ? t('team.tpm.noActive') : t('team.tpm.noWorks')) : t('team.tpm.unavailable')}</p> : null}
      {renderGroups(activeWorks)}
      {archivedWorks.length ? <details className="lab-tpm-archived"><summary>{t('team.tpm.archived', { count: archivedWorks.length })}</summary>{renderGroups(archivedWorks)}</details> : null}
      {Object.entries(tpm.catalogs).filter(([, catalog]) => catalog.error).map(([host, catalog]) => <p key={host} className="lab-control-note" role="alert">{catalog.error}</p>)}
      {main ? <p className="lab-control-note" data-creation-source title={main.title}>{t('team.for')} <strong>{main.title}</strong></p> : null}
      {canCreate ? <button type="button" className="lab-tpm-create-trigger" aria-label={t('team.tpm.createWork')} disabled={!!tpm.busy} onClick={() => {
        if (!main) return;
        setFailure(undefined);
        void tpm.create(main).catch(error => setFailure(errorWords(error, t, 'team.tpm.createFailed')));
      }}>{tpm.busy === 'create' ? t('team.tpm.creating') : t('team.tpm.newSession')}</button> : supported ? <p className="lab-control-note">{t('team.tpm.chooseMain')}</p> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
    </section> : null}
  </div>;
}
