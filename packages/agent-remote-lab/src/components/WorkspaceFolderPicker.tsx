import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionDirectoryClient, SessionWorkspace, WorkspaceFolderPage } from '../directory-client.js';

export function WorkspaceFolderPicker({ directory, providerId, initialPath, workspaces, onSelect, onClose }: {
  directory: SessionDirectoryClient; providerId: string; initialPath?: string; workspaces: SessionWorkspace[];
  onSelect(path: string): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initialPath);
  const [location, setLocation] = useState(initialPath ?? '');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [hidden, setHidden] = useState(false);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<WorkspaceFolderPage>();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const nameInput = useRef<HTMLInputElement>(null);
  const creation = useRef<AbortController>();
  useEffect(() => { if (adding) nameInput.current?.focus(); }, [adding]);
  useEffect(() => () => { creation.current?.abort(); creation.current = undefined; }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog.current!;
    modal.showModal();
    return () => { modal.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => { setFilter(search); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    let retired = false;
    setLoading(true); setFailure(undefined);
    if (!offset) setPage(undefined);
    const deadline = setTimeout(() => controller.abort(), 15_000);
    void directory.folders(providerId, { path, search: filter, hidden, offset }, controller.signal).then(result => {
      if (retired) return;
      setPage(previous => offset && previous?.path === result.path ? { ...result, folders: [...previous.folders, ...result.folders] } : result);
      setLocation(result.path);
    }).catch(error => {
      if (!retired) setFailure(controller.signal.aborted ? 'The Controller did not respond. Try again.' : error instanceof Error ? error.message : 'Could not load folders.');
    }).finally(() => { clearTimeout(deadline); if (!retired) setLoading(false); });
    return () => { retired = true; clearTimeout(deadline); controller.abort(); };
  }, [directory, providerId, path, filter, hidden, offset, retry]);
  function navigate(next: string | undefined) {
    setAdding(false); setCreateFailure(undefined); setNotice(undefined);
    setPath(next); setOffset(0); setSearch(''); setFilter(''); setRetry(value => value + 1);
  }
  async function createFolder() {
    if (!page || loading || creation.current || !name.trim()) return;
    const controller = new AbortController(); creation.current = controller;
    setCreating(true); setCreateFailure(undefined); setNotice(undefined);
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await directory.createFolder(providerId, page.path, name, controller.signal);
      if (creation.current !== controller) return;
      navigate(result.path); setName(''); setNotice('Folder created. Select it to use as your workspace.');
    } catch (error) {
      if (creation.current !== controller) return;
      setCreateFailure(controller.signal.aborted
        ? 'Creation was not confirmed. The folder may already exist. Refresh folders before retrying.'
        : error instanceof Error ? error.message : 'Could not create the folder. Refresh before retrying.');
    } finally {
      clearTimeout(deadline);
      if (creation.current === controller) { creation.current = undefined; setCreating(false); }
    }
  }
  return createPortal(<dialog ref={dialog} className="lab-folder-dialog" aria-labelledby="folder-picker-title"
    onCancel={event => { event.preventDefault(); if (!creating) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><div><h2 id="folder-picker-title">Choose a workspace folder</h2><p>Folders on the selected Controller</p></div>
      <button type="button" aria-label="Close folder picker" disabled={creating} onClick={onClose}>×</button></header>
    <fieldset className="lab-folder-navigation" disabled={creating}>
    <form className="lab-folder-location" onSubmit={event => { event.preventDefault(); navigate(location.trim() || undefined); }}>
      <button type="button" aria-label="Parent folder" disabled={loading || !page?.parentPath} onClick={() => navigate(page?.parentPath ?? undefined)}>↑</button>
      <label><span className="agent-visually-hidden">Folder path</span><input value={location} onChange={event => setLocation(event.target.value)} placeholder="Controller default folder" autoComplete="off" spellCheck={false} /></label>
      <button type="submit">Go</button>
    </form>
    <div className="lab-folder-shortcuts" aria-label="Workspace shortcuts">
      <button type="button" onClick={() => navigate(undefined)}>Default</button>
      {[...new Set([...(page?.roots ?? []), ...workspaces.map(workspace => workspace.path)])].map(root =>
        <button type="button" key={root} title={root} onClick={() => navigate(root)}>{root}</button>)}
    </div>
    <div className="lab-folder-filters">
      <label><span className="agent-visually-hidden">Filter folders</span><input type="search" placeholder="Filter folders…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label><input type="checkbox" checked={hidden} onChange={event => { setHidden(event.target.checked); setOffset(0); }} />Hidden folders</label>
    </div>
    </fieldset>
    {adding ? <form className="lab-folder-create" aria-label="Create a folder" onSubmit={event => { event.preventDefault(); void createFolder(); }}>
      <label>New folder name<input ref={nameInput} value={name} onChange={event => { setName(event.target.value); setCreateFailure(undefined); }} disabled={creating} autoComplete="off" spellCheck={false} /></label>
      <div><button type="button" aria-label="Cancel folder creation" disabled={creating} onClick={() => { setAdding(false); setCreateFailure(undefined); }}>Cancel</button>
        <button type="submit" disabled={creating || loading || !!failure || !name.trim()}>{creating ? 'Creating…' : 'Create folder'}</button></div>
      {createFailure ? <p role="alert">{createFailure} <button type="button" onClick={() => navigate(page?.path)}>Refresh folders</button></p> : null}
    </form> : <div className="lab-folder-actions"><button type="button" disabled={loading || !!failure || !page} onClick={() => { setName(''); setAdding(true); setNotice(undefined); }}><span aria-hidden="true">＋ </span>New folder</button></div>}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="lab-folder-list" aria-busy={loading}>
      {failure ? <p className="lab-control-note" role="alert">{failure} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : null}
      {loading && !offset ? <p role="status">Loading folders…</p> : null}
      {!loading && !failure && page?.folders.length === 0 ? <p>No subfolders{filter ? ' match this filter' : ''}. You can select the current folder.</p> : null}
      {page?.folders.map(folder => <button type="button" className="lab-folder-row" key={folder.path} disabled={loading || creating} onClick={() => navigate(folder.path)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /></svg>
        <span>{folder.name}</span><span aria-hidden="true">›</span>
      </button>)}
      {page?.nextOffset != null ? <button type="button" disabled={loading || creating} onClick={() => setOffset(page.nextOffset!)}>{loading ? 'Loading…' : 'Load more folders'}</button> : null}
    </div>
    <footer><span title={page?.path}>{page?.path ?? 'Choose a folder'}</span><div>
      <button type="button" disabled={creating} onClick={onClose}>Cancel</button>
      <button type="button" className="lab-folder-confirm" disabled={creating || adding || loading || !!failure || !page || search !== filter} onClick={() => { if (page) onSelect(page.path); }}>Select folder</button>
    </div></footer>
  </dialog>, document.body);
}
