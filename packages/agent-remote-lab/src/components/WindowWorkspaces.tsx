import './window-workspaces.css';
import { useEffect, useRef, useState } from 'react';
import { createWindowView, type WindowSessionBinding, type WindowView } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { useWindowManager } from '../hooks/useWindowManager.js';

function viewTitle(view: WindowView): string {
  return view.binding?.title || (view.feature ? `${view.feature.kind.toUpperCase()} view` : 'Empty view');
}
function viewRole(view: WindowView): string {
  return view.attachedTo ? 'Attached' : view.placement === 'primary' ? 'Main' : view.placement === 'float' ? 'Floating' : 'Dock';
}

export function WindowWorkspaces({ workspace, current, active = true }: {
  workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding; active?: boolean;
}) {
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const [agentControl, setAgentControl] = useState(false);
  const [openingId, setOpeningId] = useState<string>();
  const navigation = useRef(0);
  const renameButton = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  const manager = useWindowManager(workspace.client, workspace.window?.id, active && agentControl);
  const currentScope = useRef({ client: workspace.client, id: workspace.window?.id });
  currentScope.current = { client: workspace.client, id: workspace.window?.id };
  const pending = useRef<{ client: typeof workspace.client; id?: string }>();
  const [running, setRunning] = useState<typeof pending.current>();
  const busy = !!running && running.client === workspace.client && running.id === workspace.window?.id;
  useEffect(() => {
    setNotice(undefined); setEditing(false); setAgentControl(false);
    if (options.current) options.current.open = false;
  }, [workspace.client, workspace.window?.id]);
  useEffect(() => { if (!active) setEditing(false); }, [active]);
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
  const catalog = [...new Map([...(workspace.windows ?? []), ...(workspace.window ? [workspace.window] : [])].map(window => [window.id, window])).values()];
  async function openWindow(id: string) {
    const client = workspace.client, generation = ++navigation.current;
    setOpeningId(id); setNotice(undefined);
    try { await workspace.open(id); }
    catch (error) {
      if (generation === navigation.current && currentScope.current.client === client) setNotice(error instanceof Error ? error.message : String(error));
    } finally { if (generation === navigation.current) setOpeningId(undefined); }
  }
  function closeRename() { setEditing(false); renameButton.current?.focus({ preventScroll: true }); }
  function saveGrant() {
    if (!manager.grant) return;
    const blob = new Blob([JSON.stringify({ serverUrl: location.origin, ...manager.grant }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `window-${manager.grant.windowId}-grant.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <div className="lab-window-workspaces">
    <div className="lab-window-section-heading"><span>Workspaces</span><button type="button" disabled={busy} onClick={() => void run(workspace.create)}>New Window</button></div>
    <nav className="lab-window-list" aria-label="Windows">{catalog.map(window => <button key={window.id} type="button" data-window-id={window.id}
      aria-current={window.id === workspace.window?.id || undefined} aria-busy={openingId === window.id || undefined} onClick={() => void openWindow(window.id)}>
      <span><strong>{window.title}</strong><small>{openingId === window.id ? 'Opening…' : `${window.views.length} ${window.views.length === 1 ? 'session view' : 'session views'}`}</small></span>
      {window.id === workspace.window?.id ? <span className="lab-window-selected" aria-label="Current Window">✓</span> : null}
    </button>)}</nav>
    {!catalog.length ? <p className="lab-window-note">Create a Window to organize session views.</p> : null}
    {workspace.window ? <>
      <div className="lab-window-section-heading"><span>Session views</span><button type="button" disabled={busy || workspace.unavailable} onClick={() => void run(async () => {
        const view = createWindowView(crypto.randomUUID());
        await workspace.operate({ type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] });
      })}>New session view</button></div>
      <nav className="lab-window-list lab-window-views" aria-label="Session views">{workspace.window.views.map(view => <button key={view.id} type="button" data-window-view-id={view.id}
        data-attached={!!view.attachedTo || undefined} disabled={busy || workspace.unavailable}
        aria-current={view.id === workspace.window!.selectedViewId || undefined}
        onClick={() => void run(() => workspace.operate({ type: 'view.select', viewId: view.id }))}>
        <span><strong>{viewTitle(view)}</strong><small>{viewRole(view)}</small></span>
        {view.id === workspace.window!.selectedViewId ? <span className="lab-window-selected" aria-label="Selected view">✓</span> : null}
      </button>)}</nav>
      <details ref={options} className="lab-window-options"><summary>Window options</summary>
        <div className="lab-window-actions">
          <button ref={renameButton} type="button" disabled={busy || workspace.unavailable} onClick={() => { setTitle(workspace.window!.title); setEditing(true); }}>Rename Window</button>
          <button type="button" onClick={() => void run(async () => {
            const id = workspace.window!.id, client = workspace.client;
            const url = new URL(location.href); url.searchParams.set('window', id);
            await navigator.clipboard.writeText(url.href);
            if (currentScope.current.id === id && currentScope.current.client === client) setNotice('Window link copied.');
          })}>Copy link</button>
        </div>
        {editing ? <form className="lab-window-rename" onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) closeRename(); }
        }} onSubmit={event => {
          event.preventDefault(); if (busy || !title.trim()) return;
          const id = workspace.window!.id, client = workspace.client;
          if (title.trim() === workspace.window!.title) { closeRename(); return; }
          void run(() => workspace.operate({ type: 'rename', title: title.trim() })).then(ok => { if (ok && currentScope.current.id === id && currentScope.current.client === client) closeRename(); });
        }}>
          <label>Window title<input autoFocus required maxLength={256} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
          <div className="lab-window-actions"><button type="button" disabled={busy} onClick={closeRename}>Cancel</button><button type="submit" disabled={busy || !title.trim()}>Save</button></div>
        </form> : null}
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
        <button type="button" className="lab-window-delete" disabled={busy} onClick={() => void run(workspace.remove)}>Delete Window</button>
        <p className="lab-window-note">Deletes the layout. Agent sessions keep running.</p>
      </details>
    </> : null}
    {workspace.error || notice ? <p className="lab-window-note" role="status">{workspace.error ?? notice}</p> : null}
  </div>;
}
