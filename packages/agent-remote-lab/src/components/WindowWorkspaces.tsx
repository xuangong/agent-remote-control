import './window-workspaces.css';
import { useEffect, useRef, useState } from 'react';
import { createWindowView, type WindowOperation, type WindowSessionBinding, type WindowView } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { useWindowManager } from '../hooks/useWindowManager.js';

function viewTitle(view: WindowView): string {
  return view.binding?.title || (view.feature ? `${view.feature.kind.toUpperCase()} view` : 'Empty view');
}
function viewRole(view: WindowView): string {
  return view.attachedTo ? 'Attached' : view.placement === 'primary' ? 'Top-level' : view.placement === 'float' ? 'Floating' : 'Dock';
}

export function WindowWorkspaces({ workspace, current, active = true }: {
  workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding; active?: boolean;
}) {
  const [notice, setNotice] = useState<string>();
  // The Window whose title is being edited in the list, and the scope it belongs to.
  const [renaming, setRenaming] = useState<{ id: string; client: typeof workspace.client }>(), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const [agentControl, setAgentControl] = useState(false);
  const [openingId, setOpeningId] = useState<string>();
  const navigation = useRef(0);
  const renameReturn = useRef<string>();
  const root = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  const manager = useWindowManager(workspace.client, workspace.window?.id, active && agentControl);
  const currentScope = useRef({ client: workspace.client, id: workspace.window?.id });
  currentScope.current = { client: workspace.client, id: workspace.window?.id };
  const pending = useRef<{ client: typeof workspace.client; id?: string }>();
  const [running, setRunning] = useState<typeof pending.current>();
  const busy = !!running && running.client === workspace.client && running.id === workspace.window?.id;
  useEffect(() => {
    setNotice(undefined); setAgentControl(false);
    if (options.current) options.current.open = false;
  }, [workspace.client, workspace.window?.id]);
  useEffect(() => { if (!active) setRenaming(undefined); }, [active]);
  useEffect(() => { setRenaming(current => current && current.client !== workspace.client ? undefined : current); }, [workspace.client]);
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    const scope = currentScope.current;
    if (pending.current && pending.current.client === scope.client && pending.current.id === scope.id) return false;
    pending.current = scope; setRunning(scope); setNotice(undefined);
    try { await action(); return true; }
    catch (error) {
      if (currentScope.current.client === scope.client && currentScope.current.id === scope.id) setNotice(error instanceof Error ? error.message : String(error));
      return false;
    } finally { if (pending.current === scope) { pending.current = undefined; setRunning(undefined); } }
  }
  function background(action: () => Promise<unknown>): boolean {
    const scope = currentScope.current;
    const failed = (error: unknown) => {
      if (currentScope.current.client === scope.client && currentScope.current.id === scope.id) setNotice(error instanceof Error ? error.message : String(error));
    };
    setNotice(undefined);
    try { void action().catch(failed); return true; }
    catch (error) { failed(error); return false; }
  }
  function edit(operation: WindowOperation): boolean { return background(() => workspace.operate(operation)); }
  const catalog = [...new Map([...(workspace.windows ?? []), ...(workspace.window ? [workspace.window] : [])].map(window => [window.id, window])).values()];
  async function openWindow(id: string) {
    const client = workspace.client, generation = ++navigation.current;
    setOpeningId(id); setNotice(undefined);
    try { await workspace.open(id); }
    catch (error) {
      if (generation === navigation.current && currentScope.current.client === client) setNotice(error instanceof Error ? error.message : String(error));
    } finally { if (generation === navigation.current) setOpeningId(undefined); }
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
    const next = title.trim(), client = workspace.client;
    if (!next || saving) return;
    if (next === catalog.find(window => window.id === id)?.title) { closeRename(); return; }
    const report = (error: unknown) => { if (currentScope.current.client === client) setNotice(error instanceof Error ? error.message : String(error)); };
    setSaving(true); setNotice(undefined);
    try {
      // The title applies at once; like other layout edits, saving continues in the background and reports failures.
      const { saved } = await workspace.rename(id, next);
      void saved.catch(report);
      if (currentScope.current.client === client) closeRename();
    } catch (error) { report(error); }
    finally { setSaving(false); }
  }
  function saveGrant() {
    if (!manager.grant) return;
    const blob = new Blob([JSON.stringify({ serverUrl: location.origin, ...manager.grant }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `window-${manager.grant.windowId}-grant.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <div ref={root} className="lab-window-workspaces">
    <div className="lab-window-section-heading"><span>Windows</span><button type="button" disabled={busy} onClick={() => void run(workspace.create)}>New Window</button></div>
    <nav className="lab-window-list" aria-label="Windows">{catalog.map(window => <div key={window.id} className="lab-window-row" data-window-row={window.id} data-renaming={renaming?.id === window.id || undefined}>
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
      <span><strong>{window.title}</strong><small>{openingId === window.id ? 'Opening…' : `${window.views.length} ${window.views.length === 1 ? 'session view' : 'session views'}`}</small></span>
      {window.id === workspace.window?.id ? <span className="lab-window-selected" aria-label="Current Window">✓</span> : null}
      </button>
      <button type="button" className="lab-window-rename-trigger" data-window-rename={window.id} aria-label={`Rename Window: ${window.title}`} title="Rename this Window"
        disabled={!!renaming || (window.id === workspace.window?.id && workspace.unavailable)} onClick={() => startRename(window)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" /></svg>
      </button>
      <button type="button" className="lab-window-delete" aria-label={`Delete Window: ${window.title}`}
        title={!workspace.hasActiveWindow ? 'Open or create a Window before deleting another one.' : window.id === workspace.window?.id ? 'Switch to another Window before deleting this one.' : 'Delete this layout. Agent sessions keep running.'}
        disabled={busy || !workspace.hasActiveWindow || window.id === workspace.window?.id} onClick={() => void run(() => workspace.remove(window.id))}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg>
      </button></>}
    </div>)}</nav>
    {catalog.length ? <p className="lab-window-note">{workspace.hasActiveWindow ? 'Switch to another Window before deleting the active one.' : 'Open or create a Window before deleting another one.'}</p> : null}
    {workspace.saveState?.state === 'saving' ? <p className="lab-window-note" role="status">Saving…</p>
      : workspace.saveState?.state === 'offline' || workspace.saveState?.state === 'error' ? <p className="lab-window-note" role="status">Changes are not saved. <button type="button" onClick={() => background(workspace.retrySave)}>Retry</button>
        {workspace.saveState.state === 'error' && workspace.saveState.pending > 0 ? <button type="button" title="Discard unsaved local layout edits; changes already saved remain." onClick={() => background(workspace.discardLocalChanges)}>Use saved layout</button> : null}</p> : null}
    {!catalog.length ? <p className="lab-window-note">Create a Window to organize session views.</p> : null}
    {workspace.window ? <>
      <div className="lab-window-section-heading"><span>Session views</span><button type="button" disabled={busy || workspace.unavailable} onClick={() => {
        const view = createWindowView(crypto.randomUUID());
        edit({ type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] });
      }}>New session view</button></div>
      <nav className="lab-window-list lab-window-views" aria-label="Session views">{workspace.window.views.map(view => <div key={view.id} className="lab-window-row" data-window-view-row={view.id} data-attached={!!view.attachedTo || undefined}>
        <button type="button" className="lab-window-open" data-window-view-id={view.id} disabled={busy || workspace.unavailable}
        aria-current={view.id === workspace.window!.selectedViewId || undefined}
        onClick={() => edit({ type: 'view.select', viewId: view.id })}>
        <span><strong>{viewTitle(view)}</strong><small>{viewRole(view)}</small></span>
        {view.id === workspace.window!.selectedViewId ? <span className="lab-window-selected" aria-label="Selected view">✓</span> : null}
        </button>
        <button type="button" className="lab-window-view-close" data-window-view-close={view.id} aria-label={`Close session view: ${viewTitle(view)}`}
          title="Close this session view. Agent sessions keep running." disabled={busy || workspace.unavailable}
          onClick={() => edit({ type: 'view.close', viewId: view.id })}>×</button>
      </div>)}</nav>
      {!workspace.window.views.length ? <p className="lab-window-note">No session views. Add one or open a session from the sidebar.</p> : null}
      <details ref={options} className="lab-window-options"><summary>Window options</summary>
        <div className="lab-window-actions">
          <button type="button" onClick={() => void run(async () => {
            const id = workspace.window!.id, client = workspace.client;
            const url = new URL(location.href); url.searchParams.set('window', id);
            await navigator.clipboard.writeText(url.href);
            if (currentScope.current.id === id && currentScope.current.client === client) setNotice('Window link copied.');
          })}>Copy link</button>
        </div>
        {workspace.client ? <details className="lab-window-agent" open={agentControl} onToggle={event => setAgentControl(event.currentTarget.open)}>
          <summary>Agent control</summary>
          <p className="lab-window-note">Let one Agent session manage this Window through the CLI.</p>
          {manager.status === 'loading' ? <p role="status">Checking manager…</p> : manager.status === 'error' ? <p role="alert">{manager.error} <button type="button" onClick={manager.refresh}>Retry</button></p>
            : <p className="lab-window-note">Manager: {manager.manager?.title || manager.manager?.nativeSessionId || 'Unassigned'}</p>}
          <div className="lab-window-actions">
            <button type="button" disabled={!current || manager.pending} onClick={() => void manager.assign(current!).catch(() => {})}>Use current session</button>
            <button type="button" disabled={!manager.manager || manager.pending} onClick={() => void manager.assign(null).catch(() => {})}>Revoke manager</button>
          </div>
          {!current ? <p className="lab-window-note">Select a bound session view to assign its Agent.</p> : null}
          {manager.pending ? <p role="status">Updating manager…</p> : null}
          {manager.error && manager.status !== 'error' ? <p role="alert">{manager.error}</p> : null}
          {manager.grant ? <div className="lab-window-grant"><button type="button" onClick={saveGrant}>Save private manager grant</button><p className="lab-window-note">Give this file to the assigned Agent. Keep it private.</p></div> : null}
        </details> : null}
      </details>
    </> : null}
    {workspace.error || notice ? <p className="lab-window-note" role="status">{workspace.error ?? notice}</p> : null}
  </div>;
}
