import './window-workspaces.css';
import { useEffect, useRef, useState } from 'react';
import { createWindowView, type WindowOperation, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { useWindowActions, windowCatalog } from '../hooks/useWindowActions.js';
import { AgentControl } from './AgentControl.js';
import { activityLabel, windowActivity, type SessionActivityStatus } from '../session-activity-status.js';
import { windowOutline } from '../window-outline.js';
import { IconButton } from '../ui/IconButton.js';

export function viewTitle(view: WindowView): string {
  return view.binding?.title || (view.feature ? `${view.feature.kind.toUpperCase()} view` : 'Empty view');
}
/** The status a Window shows: what its sessions most need, as Track ranks it. */
function windowStatus(window: WorkspaceWindow, sessionStatus: (session: WindowSessionBinding) => SessionActivityStatus) {
  return windowActivity(window.views.flatMap(view => view.binding ? [sessionStatus(view.binding)] : []));
}
function statusPrefix(status?: SessionActivityStatus): string {
  return status && status !== 'unknown' ? `${activityLabel(status)} · ` : '';
}
function viewRole(view: WindowView): string {
  return view.attachedTo ? 'Attached' : view.placement === 'primary' ? 'Top-level' : view.placement === 'float' ? 'Floating' : 'Dock';
}

export function WindowWorkspaces({ workspace, current, active = true, sessionStatus, onOverview, onNavigate, placement = 'panel' }: {
  workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding; active?: boolean;
  /** Each session's status, as Track shows it; without it rows show no status. */
  sessionStatus?(session: WindowSessionBinding): SessionActivityStatus;
  /** Shows all Windows; with it the sidebar's Windows heading offers a "Show all Windows" button (the floating panel's WindowMenu has its own). */
  onOverview?(): void;
  /** Called after a Window is opened or a view is chosen, so a page shown instead of the Window can return to it. */
  onNavigate?(): void;
  /** Where the list sits: the floating Windows panel, or the desktop sidebar, where headings and rows follow its flat rows and icon actions. */
  placement?: 'panel' | 'sidebar';
}) {
  const sidebar = placement === 'sidebar';
  const { notice, setNotice, busy, run, background, edit, copyLink, showAsSection, saveRename: save, deleteWindow } = useWindowActions(workspace);
  // The Window whose title is being edited in the list, and the scope it belongs to.
  const [renaming, setRenaming] = useState<{ id: string; client: typeof workspace.client }>(), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
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
  const catalog = windowCatalog(workspace);
  async function openWindow(id: string) {
    const client = workspace.client, generation = ++navigation.current;
    setOpeningId(id); setNotice(undefined);
    try { await workspace.open(id); if (generation === navigation.current) onNavigate?.(); }
    catch (error) {
      if (generation === navigation.current && currentScope.current.client === client) setNotice(error instanceof Error ? error.message : String(error));
    } finally { if (generation === navigation.current) setOpeningId(undefined); }
  }
  function chooseView(view: WindowView) {
    const select: WindowOperation = { type: 'view.select', viewId: view.id };
    if (!edit(view.collapsed ? { type: 'batch', operations: [{ type: 'view.collapse', viewId: view.id, collapsed: false }, select] } : select)) return;
    // The pane may render or expand on the next frame; bring it into view then.
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[data-view-id]')].find(element => element.dataset.viewId === view.id)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
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
    {sidebar ? <div className="lab-window-section-heading"><h2 className="lab-sidebar-section-title">Windows</h2>
      {onOverview ? <IconButton icon="grid" label="Show all Windows" className="lab-window-overview-trigger" title="Show all Windows (Ctrl+Shift+Up)" aria-keyshortcuts="Control+Shift+ArrowUp" onClick={onOverview} /> : null}
      <IconButton icon="plus" label="New Window" disabled={busy} onClick={createWindow} /></div>
      : <div className="lab-window-section-heading"><span>Windows</span><button type="button" disabled={busy} onClick={createWindow}>New Window</button></div>}
    <nav className="lab-window-list" aria-label="Windows">{catalog.map(window => {
      const status = sessionStatus && windowStatus(window, sessionStatus);
      const renameLabel = `Rename Window: ${window.title}`, deleteLabel = `Delete Window: ${window.title}`;
      const renameDisabled = !!renaming || (window.id === workspace.window?.id && workspace.unavailable);
      const deleteTitle = !workspace.hasActiveWindow ? 'Open or create a Window before deleting another one.' : window.id === workspace.window?.id ? 'Switch to another Window before deleting this one.' : 'Delete this layout. Agent sessions keep running.';
      const deleteDisabled = busy || !workspace.hasActiveWindow || window.id === workspace.window?.id;
      const remove = () => void deleteWindow(window.id);
      return <div key={window.id} className="lab-window-row" data-window-row={window.id} data-renaming={renaming?.id === window.id || undefined}>
      {renaming?.id === window.id ? <form className="lab-window-rename" aria-label={`Rename Window: ${window.title}`} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) closeRename(); }
      }} onSubmit={event => { event.preventDefault(); void saveRename(window.id); }}>
        <input autoFocus required maxLength={256} aria-label="Window title" value={title} disabled={saving} onChange={event => setTitle(event.target.value)}
          onFocus={event => event.currentTarget.select()} />
        <button type="submit" disabled={saving || !title.trim()}>Save</button>
        <button type="button" disabled={saving} onClick={closeRename}>Cancel</button>
      </form> : <>
      <button type="button" className="lab-window-open" data-window-id={window.id}
      aria-current={window.id === workspace.window?.id || undefined} aria-busy={openingId === window.id || undefined} onClick={() => void openWindow(window.id)}>
      <span><strong className="agent-session-title" data-session-status={status}>{window.title}</strong><small className="agent-session-title" data-session-status={status}>{openingId === window.id ? 'Opening…' : `${statusPrefix(status)}${window.views.length} ${window.views.length === 1 ? 'session view' : 'session views'}`}</small></span>
      {window.id === workspace.window?.id && !sidebar ? <span className="lab-window-selected" aria-label="Current Window">✓</span> : null}
      </button>
      {sidebar ? <>
          <IconButton icon="pencil" label={renameLabel} className="lab-window-rename-trigger" data-window-rename={window.id} title="Rename this Window" disabled={renameDisabled} onClick={() => startRename(window)} />
          <IconButton icon="trash" label={deleteLabel} className="lab-window-delete" title={deleteTitle} disabled={deleteDisabled} onClick={remove} />
        </> : <>
          <button type="button" className="lab-window-rename-trigger" data-window-rename={window.id} aria-label={renameLabel} title="Rename this Window"
            disabled={renameDisabled} onClick={() => startRename(window)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" /></svg>
          </button>
          <button type="button" className="lab-window-delete" aria-label={deleteLabel} title={deleteTitle} disabled={deleteDisabled} onClick={remove}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg>
          </button>
        </>}</>}
    </div>; })}</nav>
    {catalog.length && !sidebar ? <p className="lab-window-note">{workspace.hasActiveWindow ? 'Switch to another Window before deleting the active one.' : 'Open or create a Window before deleting another one.'}</p> : null}
    {workspace.saveState?.state === 'saving' ? <p className="lab-window-note" role="status">Saving…</p>
      : workspace.saveState?.state === 'offline' || workspace.saveState?.state === 'error' ? <p className="lab-window-note" role="status">Changes are not saved. <button type="button" onClick={() => background(workspace.retrySave)}>Retry</button>
        {workspace.saveState.state === 'error' && workspace.saveState.pending > 0 ? <button type="button" title="Discard unsaved local layout edits; changes already saved remain." onClick={() => background(workspace.discardLocalChanges)}>Use saved layout</button> : null}</p> : null}
    {!catalog.length ? <p className="lab-window-note">Create a Window to organize session views.</p> : null}
    {workspace.window ? <>
      {sidebar ? <div className="lab-window-section-heading"><h2 className="lab-sidebar-section-title">In this Window</h2>
        <IconButton icon="plus" label="New session view" disabled={busy || workspace.unavailable} onClick={createView} /></div>
        : <div className="lab-window-section-heading"><span>In this Window</span><button type="button" disabled={busy || workspace.unavailable} onClick={createView}>New session view</button></div>}
      <nav className="lab-window-list lab-window-views" aria-label="Session views">{windowOutline(workspace.window.views).map(({ view, depth }) => { const status = view.binding && sessionStatus?.(view.binding); const shown = status !== 'unknown' ? status : undefined; return <div key={view.id} className="lab-window-row" data-window-view-row={view.id}
        data-depth={depth || undefined} data-collapsed={view.collapsed || undefined}>
        <button type="button" className="lab-window-open" data-window-view-id={view.id} disabled={busy || workspace.unavailable}
        aria-current={view.id === workspace.window!.selectedViewId || undefined}
        onClick={() => chooseView(view)}>
        <span><strong className="agent-session-title" data-session-status={shown}>{viewTitle(view)}</strong><small className="agent-session-title" data-session-status={shown}>{statusPrefix(status)}{viewRole(view)}</small></span>
        {view.id === workspace.window!.selectedViewId && !sidebar ? <span className="lab-window-selected" aria-label="Selected view">✓</span> : null}
        </button>
        {sidebar ? <IconButton icon="close" label={`Close session view: ${viewTitle(view)}`} className="lab-window-view-close" data-window-view-close={view.id}
          title="Close this session view. Agent sessions keep running." disabled={busy || workspace.unavailable} onClick={() => edit({ type: 'view.close', viewId: view.id })} />
          : <button type="button" className="lab-window-view-close" data-window-view-close={view.id} aria-label={`Close session view: ${viewTitle(view)}`}
          title="Close this session view. Agent sessions keep running." disabled={busy || workspace.unavailable}
          onClick={() => edit({ type: 'view.close', viewId: view.id })}>×</button>}
      </div>; })}</nav>
      {!workspace.window.views.length ? <p className="lab-window-note">No session views. Add one or open one from {sidebar ? 'All sessions' : 'Sessions'}.</p> : null}
      <details ref={options} className="lab-window-options"><summary>Window options</summary>
        <div className="lab-window-actions">
          <button type="button" onClick={() => void copyLink()}>Copy link</button>
          {!workspace.group?.bots ? <button type="button" disabled={busy || workspace.unavailable} onClick={() => void showAsSection()}>Show as section</button> : null}
        </div>
        {workspace.client ? <details className="lab-window-agent" open={agentControl} onToggle={event => setAgentControl(event.currentTarget.open)}>
          <summary>Agent control</summary>
          <AgentControl client={workspace.client} windowId={workspace.window.id} current={current} active={active && agentControl} />
        </details> : null}
      </details>
    </> : null}
    {workspace.error || notice ? <p className="lab-window-note" role="status">{workspace.error ?? notice}</p> : null}
  </div>;
}
