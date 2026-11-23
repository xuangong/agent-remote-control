import { useContext, useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { hasWindowAppearance, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from './useWindowWorkspace.js';
import { useTrackingPosition } from '../../kernel/useTrackingPosition.js';
import { ShortcutPlacement } from '../../kernel/shortcut-placement.js';
import type { SessionActivityStatus } from '../../kernel/session-activity-status.js';
import { WindowWorkspaces } from './WindowWorkspaces.js';
import { useSharedStates } from '../../kernel/shared-feeds.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** The floating entry manages presentation; hiding it does not change the Window. */
export function WindowMenu({ workspace, current, visible, inert = false, onOverview, sessionStatus, onRemoveView }: {
  workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding; visible: boolean; inert?: boolean;
  /** Shows every Window side by side; offered where the overview is available. */
  onOverview?(): void;
  /** Each session's status, as Track shows it. */
  sessionStatus?(session: WindowSessionBinding): SessionActivityStatus;
  /** Whether a Team is a Support roster, whose leader then shows the Support role. */
  onRemoveView?: ComponentProps<typeof WindowWorkspaces>['onRemoveView'];
}) {
  const t = useTranslate();
  // Statuses come from sessionStatus, which reads the shared states: render again when they change.
  useSharedStates();
  const [open, setOpen] = useState(false);
  // It floats unless it sits in the compact launcher bar; the sidebar lists the Windows itself and shows no Window entry.
  const floating = useContext(ShortcutPlacement) !== 'bar';
  const { root, style, handlers, edge } = useTrackingPosition('agent-remote:window-position', undefined, { enabled: floating });
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const expanded = open && visible && !inert;
  const selectedGroup = workspace.window && workspace.readGroup?.(workspace.window.id);
  const count = new Set([...workspace.windows.map(window => window.id), ...(workspace.window && (!selectedGroup || hasWindowAppearance(selectedGroup)) ? [workspace.window.id] : [])]).size;
  // The current Window shows its own sessions; like Track, the entry reminds only of sessions waiting for their owner.
  const pendingElsewhere = !!sessionStatus && workspace.windows.some(window => window.id !== workspace.window?.id
    && window.views.some(view => view.binding && sessionStatus(view.binding) === 'waiting'));
  useEffect(() => { if (!visible || inert) setOpen(false); }, [visible, inert]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded, root]);
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  return <div ref={root} className={floating ? 'lab-tracking-floating lab-window-floating' : 'lab-launcher lab-launcher-window'} data-edge={edge} style={style} {...(floating ? handlers : {})}
    data-hidden={!visible || undefined} data-open={expanded || undefined} data-attention={pendingElsewhere || undefined} aria-hidden={!visible || undefined}
    {...(!visible || inert ? { inert: '' } : {})}
    onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" className="lab-session-popover-trigger" aria-label={t('windows.heading')} aria-expanded={expanded}
      aria-controls={panelId} title={pendingElsewhere ? t('windows.pendingElsewhere') : undefined} onClick={() => setOpen(value => !value)}>
      <span>{t('windows.window')}</span><span>{count}</span>{pendingElsewhere ? <span className="lab-tracking-attention" aria-hidden="true" /> : null}
    </button>
    <section id={panelId} className="lab-session-popover-panel lab-window-panel" aria-label={t('windows.heading')} hidden={!expanded}>
      <div className="lab-directory-heading"><h2>{t('windows.heading')}</h2>
        {onOverview ? <button type="button" className="lab-window-overview-trigger" aria-label={t('windows.showAll')} title={t('windows.showAllTitle')} aria-keyshortcuts="Control+Shift+ArrowUp"
          onClick={() => { close(); onOverview(); }}>{t('windows.allWindows')}</button> : null}
        <button type="button" aria-label={t('windows.closePanel')} onClick={close}>×</button></div>
      <div className="lab-window-panel-scroll"><WindowWorkspaces workspace={workspace} current={current} active={expanded} sessionStatus={sessionStatus} onRemoveView={onRemoveView} /></div>
    </section>
    <span className="agent-visually-hidden" role="status">{pendingElsewhere ? t('windows.pendingElsewhereNote') : ''}</span>
  </div>;
}
