import { useEffect, useRef, useState } from 'react';
import { hasWindowAppearance, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from './useWindowWorkspace.js';
import { byRecentUse } from '../window-recency.js';

type Workspace = ReturnType<typeof useWindowWorkspace>;
type Scope = { client: Workspace['client']; id?: string };

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The Windows a workspace lists: its catalog and the open Window, without groups shown only as sections. */
export function windowCatalog(workspace: Workspace): WorkspaceWindow[] {
  return [...new Map([...(workspace.windows ?? []), ...(workspace.window ? [workspace.window] : [])].map(window => [window.id, window])).values()]
    .filter(window => { const group = workspace.readGroup?.(window.id); return !group || hasWindowAppearance(group); });
}

/**
 * Actions on the open Window shared by the Windows panel and the Window toolbar. Actions run one at a time per
 * Window, and their outcome becomes a notice that belongs to the Window it was given in.
 * @param scope The page scope that orders Windows by recent use; without it, catalog order applies.
 */
export function useWindowActions(workspace: Workspace, scope?: string) {
  const currentScope = useRef<Scope>({ client: workspace.client, id: workspace.window?.id });
  currentScope.current = { client: workspace.client, id: workspace.window?.id };
  // A notice is shown only in the Window it was given in, even when it arrives before that Window renders.
  const [entry, setEntry] = useState<Scope & { text: string }>();
  const notice = entry && entry.client === workspace.client && entry.id === workspace.window?.id ? entry.text : undefined;
  const noticeIn = (target: Scope, text: string | undefined) => setEntry(text === undefined ? undefined : { ...target, text });
  const setNotice = (text: string | undefined) => noticeIn(currentScope.current, text);
  const pending = useRef<Scope>();
  const [running, setRunning] = useState<Scope>();
  const busy = !!running && running.client === workspace.client && running.id === workspace.window?.id;
  useEffect(() => {
    setEntry(current => current && current.client === workspace.client && current.id === workspace.window?.id ? current : undefined);
  }, [workspace.client, workspace.window?.id]);
  const inScope = (scope: Scope) => currentScope.current.client === scope.client && currentScope.current.id === scope.id;
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    const scope = currentScope.current;
    if (pending.current && pending.current.client === scope.client && pending.current.id === scope.id) return false;
    pending.current = scope; setRunning(scope); setNotice(undefined);
    try { await action(); return true; }
    catch (error) {
      if (inScope(scope)) setNotice(message(error));
      return false;
    } finally { if (pending.current === scope) { pending.current = undefined; setRunning(undefined); } }
  }
  function background(action: () => Promise<unknown>): boolean {
    const scope = currentScope.current;
    const failed = (error: unknown) => { if (inScope(scope)) setNotice(message(error)); };
    setNotice(undefined);
    try { void action().catch(failed); return true; }
    catch (error) { failed(error); return false; }
  }
  function edit(operation: WindowOperation): boolean { return background(() => workspace.operate(operation)); }
  const copyLink = () => run(async () => {
    const id = workspace.window!.id, client = workspace.client;
    const url = new URL(location.href); url.searchParams.set('window', id);
    for (const key of ['mode', 'section', 'bot']) url.searchParams.delete(key);
    await navigator.clipboard.writeText(url.href);
    if (currentScope.current.id === id && currentScope.current.client === client) setNotice('Window link copied.');
  });
  const showAsSection = () => run(async () => {
    const id = workspace.window!.id, client = workspace.client;
    const rank = workspace.groups.flatMap(group => group.bots ? [group.bots.rank] : []).sort().at(-1);
    await workspace.operateGroup(id, { type: 'bots.add', rank: !rank ? 'm' : rank.length < 64 ? `${rank}m` : rank });
    if (currentScope.current.id === id && currentScope.current.client === client) setNotice('Shown as a section in Bot mode.');
  });
  /** Renames a Window; resolves whether the edit is finished, so the caller can close its form. */
  async function saveRename(id: string, title: string): Promise<boolean> {
    const next = title.trim(), client = workspace.client;
    if (!next) return false;
    if (next === windowCatalog(workspace).find(window => window.id === id)?.title) return true;
    const report = (error: unknown) => { if (currentScope.current.client === client) setNotice(message(error)); };
    setNotice(undefined);
    try {
      // The title applies at once; like other layout edits, saving continues in the background and reports failures.
      const { saved } = await workspace.rename(id, next);
      void saved.catch(report);
      return currentScope.current.client === client;
    } catch (error) { report(error); return false; }
  }
  /**
   * Deletes the open Window without leaving the page without one: it opens the most recently used other Window, or
   * creates one, and then deletes the previous Window. Deleting refuses the active Window, so a switch that a newer
   * navigation superseded keeps it.
   */
  async function deleteCurrent(): Promise<boolean> {
    const client = workspace.client, previous = workspace.window?.id;
    if (!previous) return false;
    let failure: unknown;
    const done = await run(async () => {
      const others = windowCatalog(workspace).filter(window => window.id !== previous);
      const next = (scope ? byRecentUse(scope, others) : others)[0];
      if (next) await workspace.open(next.id); else await workspace.create();
      try { await workspace.remove(previous); } catch (error) { failure = error; }
    });
    if (failure === undefined) return done;
    // The notice belongs to whichever Window is open now, which may not have rendered yet.
    if (currentScope.current.client === client) noticeIn({ client, id: workspace.readWindow?.()?.id ?? currentScope.current.id }, `The Window was not deleted: ${message(failure)}`);
    return false;
  }
  const deleteWindow = (id: string) => run(() => workspace.remove(id));
  return { notice, setNotice, busy, run, background, edit, copyLink, showAsSection, saveRename, deleteCurrent, deleteWindow };
}
