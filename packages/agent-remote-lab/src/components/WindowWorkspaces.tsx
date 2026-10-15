import './window-workspaces.css';
import { useEffect, useState } from 'react';
import { createWindowView, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
export function WindowWorkspaces({ workspace, current }: { workspace: ReturnType<typeof useWindowWorkspace>; current?: WindowSessionBinding }) {
  const [notice, setNotice] = useState<string>();
  const [manager, setManager] = useState<WindowSessionBinding>();
  useEffect(() => { if (!workspace.client || !workspace.window) { setManager(undefined); return; } const abort = new AbortController(); void workspace.client.inspect(workspace.window.id, abort.signal).then(snapshot => { if (!abort.signal.aborted) setManager(snapshot.manager?.session); }).catch(() => {}); return () => abort.abort(); }, [workspace.client, workspace.window]);
  const [grant, setGrant] = useState<{ windowId: string; token: string }>();
  const run = (action: () => Promise<unknown>) => { void action().catch(error => setNotice(String(error.message ?? error))); };
  const catalog = [...new Map([...(workspace.windows ?? []), ...(workspace.window ? [workspace.window] : [])].map(window => [window.id, window])).values()];
  return <details className="lab-window-workspaces"><summary>Window: {workspace.window?.title ?? 'Choose'}</summary>
    <select aria-label="Open Window" value={workspace.window?.id ?? ''} onChange={event => run(() => workspace.open(event.target.value))}><option value="" disabled>Choose Window</option>{catalog.map(window => <option key={window.id} value={window.id}>{window.title}</option>)}</select>
    <button type="button" onClick={() => run(workspace.create)}>New Window</button>
    {workspace.window ? <><select aria-label="Selected view" value={workspace.window.selectedViewId} onChange={event => run(() => workspace.operate({ type: 'view.select', viewId: event.target.value }))}>{workspace.window.views.map(view => <option key={view.id} value={view.id}>{view.attachedTo ? '↳ ' : ''}{view.binding?.title ?? (view.feature ? `${view.feature.kind.toUpperCase()} view` : 'Empty view')}</option>)}</select><button type="button" onClick={() => run(async () => { const view = createWindowView(crypto.randomUUID()); await workspace.operate({ type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] }); })}>New session view</button><input aria-label="Window title" key={workspace.window.id + workspace.window.title} defaultValue={workspace.window.title} onBlur={event => { const title = event.target.value.trim(); if (title && title !== workspace.window?.title) run(() => workspace.operate({ type: 'rename', title })); }} />
      <button type="button" onClick={() => run(async () => { const url = new URL(location.href); url.searchParams.set('window', workspace.window!.id); await navigator.clipboard.writeText(url.href); setNotice('Window link copied.'); })}>Share</button>
      <button type="button" onClick={() => run(workspace.remove)}>Delete Window</button>
      {workspace.client ? <><p>Manager: {manager?.title ?? 'Unassigned'}</p><button type="button" disabled={!current} onClick={() => run(async () => { const result = await workspace.client!.assign(workspace.window!.id, current!) as { token?: string }; setManager(current); if (result.token) setGrant({ windowId: workspace.window!.id, token: result.token }); setNotice('Manager assigned. Save the private grant file for this Agent.'); })}>Assign current session as manager</button><button type="button" onClick={() => run(async () => { await workspace.client!.assign(workspace.window!.id, null); setGrant(undefined); setManager(undefined); setNotice('Manager revoked.'); })}>Revoke manager</button></> : null}</> : null}
    {grant && grant.windowId === workspace.window?.id ? <button type="button" onClick={() => { const blob = new Blob([JSON.stringify({ serverUrl: location.origin, ...grant }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `window-${grant.windowId}-grant.json`; link.click(); URL.revokeObjectURL(url); }}>Save private manager grant</button> : null}
    {workspace.error || notice ? <p role="status">{workspace.error ?? notice}</p> : null}
  </details>;
}
