import './window-workspaces.css';
import { useEffect, useRef, useState } from 'react';
import { createWindowView, hasBotAppearance, isBotView, type WindowBotDetails, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from './useWindowWorkspace.js';
import { useWindowActions, windowCatalog } from './useWindowActions.js';
import { AgentControl } from './AgentControl.js';
import { windowActivity, type SessionActivityStatus } from '../../kernel/session-activity-status.js';
import { botRole } from '../../kernel/bot-roster.js';
import { assistantStateWord, assistantStatus, errorWords, translator, type AssistantState, type Translate } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { windowSummary } from './window-summary.js';
import { useAssistantNames } from '../../kernel/names-context.js';
import { windowOutline } from './window-outline.js';
import { IconButton } from '../../ui/IconButton.js';
import { Button } from '../../ui/Button.js';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { revealView, viewSelection } from './window-view-selection.js';
import { useSharedStates } from '../../kernel/shared-feeds.js';

export function viewTitle(view: WindowView, t: Translate = translator('en')): string {
  return view.binding?.title || (view.feature ? t('windows.view.feature', { kind: view.feature.kind.toUpperCase() }) : t('windows.view.empty'));
}
/** The status a Window shows: what its sessions most need, as Track ranks it. */
function windowStatus(window: WorkspaceWindow, sessionStatus: (session: WindowSessionBinding) => SessionActivityStatus) {
  return windowActivity(window.views.flatMap(view => view.binding ? [sessionStatus(view.binding)] : []));
}
/** The state of a session that asks for something, by the assistants' one rule, in a word; quiet states have none. */
function liveState(status: SessionActivityStatus | undefined): AssistantState | undefined {
  if (!status) return undefined;
  const state = assistantStatus({ activity: status, asleep: false, waitingToSend: false }).state;
  return state === 'needs_you' || state === 'working' || state === 'failed' ? state : undefined;
}
/** A state worded and coloured as the assistants say it. */
function StatusWord({ state }: { state: AssistantState }) {
  const t = useTranslate();
  return <span className="lab-bot-status" data-attention={state === 'needs_you' || undefined} data-failed={state === 'failed' || undefined} data-working={state === 'working' || undefined}>{assistantStateWord(state, t)}</span>;
}
/**
 * How a view reads in In this Window. A bot reads as in Bot mode: its name, its role and label as tags, and where it stands
 * (Open, Folded or Asleep) with Working, Needs you or Failed. An asleep bot is quiet except when it needs the owner. An Ask
 * is one line under its bot; other views keep their title.
 */
function viewLine(t: Translate, view: WindowView, name: string, details: WindowBotDetails | undefined, status: SessionActivityStatus | undefined, supportTeam?: (teamId: string) => boolean) {
  const live = liveState(status);
  if (isBotView(view)) {
    const role = botRole(view, supportTeam, t), place = details?.asleep ? t('windows.place.asleep') : view.collapsed ? t('windows.place.folded') : t('windows.place.open');
    const shown = details?.asleep && live !== 'needs_you' ? undefined : live;
    return { name, tags: [role && <span key="role" className="lab-bot-role">{role}</span>, details?.label && <span key="label" className="lab-bot-label">{details.label}</span>],
      detail: <>{place}{shown ? <> · <StatusWord state={shown} /></> : null}</> };
  }
  if (view.feature?.kind === 'ask') return { name: view.binding?.title || t('windows.role.ask'), tags: [<span key="role" className="lab-bot-role">{t('windows.role.ask')}</span>] };
  const kind = view.binding?.sessionIntent === 'history' ? t('windows.kind.history') : view.binding?.parentNativeSessionId ? t('windows.kind.subagent') : undefined;
  return { name: viewTitle(view, t), tags: [], detail: kind || live ? <>{kind}{kind && live ? ' · ' : null}{live ? <StatusWord state={live} /> : null}</> : undefined };
}

export function WindowWorkspaces({ workspace, current, active = true, sessionStatus, supportTeam, onOverview, onNavigate, onChooseView, onRemoveView, placement = 'panel', actions: sharedActions }: {
  workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding; active?: boolean;
  /**
   * Window actions shared with another surface (the Window toolbar), so both see one busy state and one notice. Their
   * owner shows the notice; without them the list runs its own actions and shows their notices itself.
   */
  actions?: ReturnType<typeof useWindowActions>;
  /** Each session's status, as Track shows it; without it rows show no status. */
  sessionStatus?(session: WindowSessionBinding): SessionActivityStatus;
  /** Whether a Team is a Support roster, whose leader then shows the Support role, as in Bot mode. */
  supportTeam?(teamId: string): boolean;
  /** Shows all Windows; with it the sidebar's Windows heading offers a "Show all Windows" button (the floating panel's WindowMenu has its own). */
  onOverview?(): void;
  /** Called after a Window is opened or a view is chosen, so a page shown instead of the Window can return to it. */
  onNavigate?(): void;
  /** Called when a view of the open Window is chosen, once its selection is sent. */
  onChooseView?(view: WindowView): void;
  /** Takes over removing a view of the open Window (a bot asks first); returns false to let the row close it at once. */
  onRemoveView?(view: WindowView): boolean;
  /** Where the list sits: the floating Windows panel, or the desktop sidebar, where headings and rows follow its flat rows and icon actions. */
  placement?: 'panel' | 'sidebar';
}) {
  const t = useTranslate();
  const names = useAssistantNames();
  // Statuses come from sessionStatus, which reads the shared states: render again when they change.
  useSharedStates();
  const sidebar = placement === 'sidebar';
  const ownActions = useWindowActions(workspace);
  const { notice, noticeTone, setNotice, busy, run, background, edit, copyLink, setBotAppearance, saveRename: save, deleteWindow } = sharedActions ?? ownActions;
  // The Window whose title is being edited in the list, and the scope it belongs to.
  const [renaming, setRenaming] = useState<{ id: string; client: typeof workspace.client }>(), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; title: string; client: typeof workspace.client; windowId?: string }>();
  const pendingDelete = useRef<typeof deleting>();
  const [agentControl, setAgentControl] = useState(false);
  const [openingId, setOpeningId] = useState<string>();
  const navigation = useRef(0);
  const renameReturn = useRef<string>();
  const root = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  const currentScope = useRef({ client: workspace.client, id: workspace.window?.id });
  currentScope.current = { client: workspace.client, id: workspace.window?.id };
  useEffect(() => {
    setAgentControl(false);
    if (options.current) options.current.open = false;
  }, [workspace.client, workspace.window?.id]);
  useEffect(() => { if (!active) setRenaming(undefined); }, [active]);
  useEffect(() => { setRenaming(current => current && current.client !== workspace.client ? undefined : current); }, [workspace.client]);
  useEffect(() => {
    setDeleting(undefined); pendingDelete.current = undefined;
  }, [workspace.client, workspace.window?.id, active]);
  const catalog = windowCatalog(workspace);
  const deleteTarget = deleting && active && workspace.hasActiveWindow && deleting.client === workspace.client
    && deleting.windowId === workspace.window?.id && deleting.id !== workspace.window?.id
    && catalog.some(window => window.id === deleting.id) ? deleting : undefined;
  function startDelete(window: WorkspaceWindow) {
    if (!active || busy || !workspace.hasActiveWindow || window.id === workspace.window?.id) return;
    setNotice(undefined);
    setDeleting({ id: window.id, title: window.title, client: workspace.client, windowId: workspace.window?.id });
  }
  function closeDelete() { if (!busy && !pendingDelete.current) setDeleting(undefined); }
  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || busy || pendingDelete.current) return;
    pendingDelete.current = target;
    try { if (await deleteWindow(target.id)) setDeleting(current => current === target ? undefined : current); }
    finally { if (pendingDelete.current === target) pendingDelete.current = undefined; }
  }
  async function openWindow(id: string) {
    const client = workspace.client, generation = ++navigation.current;
    setOpeningId(id); setNotice(undefined);
    try { await workspace.open(id); if (generation === navigation.current) onNavigate?.(); }
    catch (error) {
      if (generation === navigation.current && currentScope.current.client === client) setNotice(errorWords(error, t));
    } finally { if (generation === navigation.current) setOpeningId(undefined); }
  }
  function chooseView(view: WindowView) {
    if (!edit(viewSelection(view))) return;
    onChooseView?.(view);
    revealView(view.id);
    onNavigate?.();
  }
  function startRename(window: { id: string; title: string }) {
    renameReturn.current = window.id; setTitle(window.title); setNotice(undefined); setRenaming({ id: window.id, client: workspace.client });
  }
  function closeRename() { setRenaming(undefined); }
  // After an edit ends, focus returns to the row action that started it.
  useEffect(() => {
    if (renaming || !renameReturn.current) return;
    const id = renameReturn.current; renameReturn.current = undefined;
    [...root.current?.querySelectorAll<HTMLButtonElement>('[data-window-rename]') ?? []].find(button => button.dataset.windowRename === id)?.focus({ preventScroll: true });
  }, [renaming]);
  async function saveRename(id: string) {
    const next = title.trim();
    if (!next || saving) return;
    if (next === catalog.find(window => window.id === id)?.title) { closeRename(); return; }
    setSaving(true);
    try { if (await save(id, next)) closeRename(); }
    finally { setSaving(false); }
  }
  const createWindow = () => void run(workspace.create);
  function createView() {
    const view = createWindowView(crypto.randomUUID());
    edit({ type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] });
  }
  return <div ref={root} className="lab-window-workspaces" data-placement={placement}>
    {sidebar ? <div className="lab-window-section-heading"><h2 className="lab-sidebar-section-title">{t('windows.heading')}</h2>
      {onOverview ? <IconButton icon="grid" label={t('windows.showAll')} className="lab-window-overview-trigger" title={t('windows.showAllTitle')} aria-keyshortcuts="Control+Shift+ArrowUp" onClick={onOverview} /> : null}
      <IconButton icon="plus" label={t('windows.newWindow')} disabled={busy} onClick={createWindow} /></div>
      : <div className="lab-window-section-heading"><span>{t('windows.heading')}</span><button type="button" disabled={busy} onClick={createWindow}>{t('windows.newWindow')}</button></div>}
    <nav className="lab-window-list" aria-label={t('windows.heading')}>{catalog.map(window => {
      const status = sessionStatus && windowStatus(window, sessionStatus);
      const renameLabel = t('windows.rename.label', { title: window.title }), deleteLabel = t('windows.delete.label', { title: window.title });
      const renameDisabled = !!renaming || (window.id === workspace.window?.id && workspace.unavailable);
      const deleteTitle = !workspace.hasActiveWindow ? t('windows.delete.needWindow') : window.id === workspace.window?.id ? t('windows.delete.switchFirst') : t('windows.delete.hint');
      const deleteDisabled = busy || !workspace.hasActiveWindow || window.id === workspace.window?.id;
      const remove = () => startDelete(window);
      return <div key={window.id} className="lab-window-row" data-window-row={window.id} data-renaming={renaming?.id === window.id || undefined}>
      {renaming?.id === window.id ? <form className="lab-window-rename" aria-label={renameLabel} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) closeRename(); }
      }} onSubmit={event => { event.preventDefault(); void saveRename(window.id); }}>
        <input autoFocus required maxLength={256} aria-label={t('windows.rename.field')} value={title} disabled={saving} onChange={event => setTitle(event.target.value)}
          onFocus={event => event.currentTarget.select()} />
        <button type="submit" disabled={saving || !title.trim()}>{t('common.save')}</button>
        <button type="button" disabled={saving} onClick={closeRename}>{t('common.cancel')}</button>
      </form> : <>
      <button type="button" className="lab-window-open" data-window-id={window.id}
      aria-current={window.id === workspace.window?.id || undefined} aria-busy={openingId === window.id || undefined} onClick={() => void openWindow(window.id)}>
      <span><strong>{window.title}</strong><small>{openingId === window.id ? t('windows.opening') : <>{liveState(status) ? <><StatusWord state={liveState(status)!} /> · </> : null}{windowSummary(window.views, viewId => !!workspace.readGroup?.(window.id)?.bots?.members[viewId]?.asleep, t)}</>}</small></span>
      {window.id === workspace.window?.id && !sidebar ? <span className="lab-window-selected" aria-label={t('windows.currentWindow')}>✓</span> : null}
      </button>
      {sidebar ? <>
          <IconButton icon="pencil" label={renameLabel} className="lab-window-rename-trigger" data-window-rename={window.id} title={t('windows.rename.hint')} disabled={renameDisabled} onClick={() => startRename(window)} />
          <IconButton icon="trash" label={deleteLabel} className="lab-window-delete" title={deleteTitle} disabled={deleteDisabled} onClick={remove} />
        </> : <>
          <button type="button" className="lab-window-rename-trigger" data-window-rename={window.id} aria-label={renameLabel} title={t('windows.rename.hint')}
            disabled={renameDisabled} onClick={() => startRename(window)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" /></svg>
          </button>
          <button type="button" className="lab-window-delete" aria-label={deleteLabel} title={deleteTitle} disabled={deleteDisabled} onClick={remove}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg>
          </button>
        </>}</>}
    </div>; })}</nav>
    {catalog.length && !sidebar ? <p className="lab-window-note">{workspace.hasActiveWindow ? t('windows.delete.switchActive') : t('windows.delete.needWindow')}</p> : null}
    {workspace.saveState?.state === 'saving' ? <p className="lab-window-note" role="status">{t('common.saving')}</p>
      : workspace.saveState?.state === 'offline' || workspace.saveState?.state === 'error' ? <p className="lab-window-note" role="status">{t('windows.unsaved')}{' '}<button type="button" onClick={() => background(workspace.retrySave)}>{t('common.retry')}</button>
        {workspace.saveState.state === 'error' && workspace.saveState.pending > 0 ? <button type="button" title={t('windows.useSaved.hint')} onClick={() => background(workspace.discardLocalChanges)}>{t('windows.useSaved')}</button> : null}</p> : null}
    {!catalog.length ? <p className="lab-window-note">{t('windows.note.create')}</p> : null}
    {workspace.window ? <>
      {sidebar ? <div className="lab-window-section-heading"><h2 className="lab-sidebar-section-title">{t('windows.inThisWindow')}</h2>
        <IconButton icon="plus" label={t('windows.newSessionView')} disabled={busy || workspace.unavailable} onClick={createView} /></div>
        : <div className="lab-window-section-heading"><span>{t('windows.inThisWindow')}</span><button type="button" disabled={busy || workspace.unavailable} onClick={createView}>{t('windows.newSessionView')}</button></div>}
      <nav className="lab-window-list lab-window-views" aria-label={t('windows.sessionViews')}>{windowOutline(workspace.window.views).map(({ view, depth }) => {
        const details = workspace.group?.bots?.members[view.id];
        const line = viewLine(t, view, names.view(workspace.window!.id, view.id), details, view.binding && sessionStatus?.(view.binding), supportTeam);
        // Relationships are metadata, not levels: a Side is a bot beside its source; only an Ask nests under its bot.
        const nested = view.feature?.kind === 'ask' && depth === 1;
        return <div key={view.id} className="lab-window-row" data-window-view-row={view.id}
        data-depth={nested ? 1 : undefined} data-collapsed={view.collapsed || undefined} data-asleep={details?.asleep || undefined} data-ask={view.feature?.kind === 'ask' || undefined}>
        <button type="button" className="lab-window-open" data-window-view-id={view.id} disabled={busy || workspace.unavailable}
        aria-current={view.id === workspace.window!.selectedViewId || undefined}
        onClick={() => chooseView(view)}>
        <span><span className="lab-window-view-line"><strong>{line.name}</strong>{line.tags}</span>{line.detail ? <small>{line.detail}</small> : null}</span>
        {view.id === workspace.window!.selectedViewId && !sidebar ? <span className="lab-window-selected" aria-label={t('windows.selectedView')}>✓</span> : null}
        </button>
        {sidebar ? <IconButton icon="close" label={t('windows.closeView.label', { title: viewTitle(view, t) })} className="lab-window-view-close" data-window-view-close={view.id}
          title={t('windows.closeView.hint')} disabled={busy || workspace.unavailable} onClick={() => { if (!onRemoveView?.(view)) edit({ type: 'view.close', viewId: view.id }); }} />
          : <button type="button" className="lab-window-view-close" data-window-view-close={view.id} aria-label={t('windows.closeView.label', { title: viewTitle(view, t) })}
          title={t('windows.closeView.hint')} disabled={busy || workspace.unavailable}
          onClick={() => { if (!onRemoveView?.(view)) edit({ type: 'view.close', viewId: view.id }); }}>×</button>}
      </div>; })}</nav>
      {!workspace.window.views.length ? <p className="lab-window-note">{sidebar ? t('windows.note.noViewsSidebar') : t('windows.note.noViewsPanel')}</p> : null}
      <details ref={options} className="lab-window-options"><summary>{t('windows.options')}</summary>
        <div className="lab-window-actions">
          <button type="button" onClick={() => void copyLink()}>{t('windows.copyLink')}</button>
          {workspace.group ? <button type="button" disabled={busy || workspace.unavailable} onClick={() => void setBotAppearance(!hasBotAppearance(workspace.group!))}>
            {hasBotAppearance(workspace.group) ? t('windows.botMode.hide') : t('windows.botMode.show')}</button> : null}
        </div>
        {workspace.client ? <details className="lab-window-agent" open={agentControl} onToggle={event => setAgentControl(event.currentTarget.open)}>
          <summary>{t('windows.agentControl')}</summary>
          <AgentControl client={workspace.client} windowId={workspace.window.id} current={current} active={active && agentControl} />
        </details> : null}
      </details>
    </> : null}
    {deleteTarget ? <Sheet open title={t('windows.delete.title')} detent="content" onClose={closeDelete}>
      <p className="lab-sheet-message">{t('windows.delete.message', { title: deleteTarget.title })}</p>
      {notice && noticeTone !== 'info' ? <p className="lab-sheet-message" role="alert">{notice}</p> : null}
      <div className="lab-sheet-actions">
        <Button disabled={busy} onClick={closeDelete}>{t('common.cancel')}</Button>
        <Button variant="destructive" disabled={busy} aria-busy={busy || undefined} onClick={() => void confirmDelete()}>{t('windows.delete.action')}</Button>
      </div>
    </Sheet> : null}
    {workspace.error || notice && !sharedActions ? <p className="lab-window-note" role="status">{workspace.error ?? notice}</p> : null}
  </div>;
}
