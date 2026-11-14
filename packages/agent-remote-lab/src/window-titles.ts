import type { WindowEdit, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionKey } from './session-tree.js';

/**
 * Edits that give a Window's views the titles confirmed for their sessions. An ordinary view is renamed in place by a
 * binding that expects the session it shows now: the edit is saved after any edit still in flight, and is refused if
 * the view shows another session by then. Views an Ask, Team or TPM manages refuse direct bindings, so they are renamed
 * through one layout edit, issued before the bindings that would otherwise change the Window under it. A Window named after
 * its one primary session (as a group started from a new session is) follows that session's title; any other title stays.
 */
export function windowTitleEdits(window: WorkspaceWindow, titles: ReadonlyMap<string, string>): WindowEdit[] {
  const edits: WindowEdit[] = [];
  const namesake = window.views.filter(view => view.placement === 'primary' && view.binding?.title === window.title);
  const renamed = namesake.length === 1 ? titles.get(sessionKey(namesake[0]!.binding!)) : undefined;
  const rename: WindowEdit[] = renamed !== undefined && renamed !== window.title ? [{ type: 'rename', title: renamed }] : [];
  let managed = false;
  const views = window.views.map(view => {
    const title = view.binding && titles.get(sessionKey(view.binding));
    if (title === undefined || title === view.binding!.title) return view;
    const binding = { ...view.binding!, title };
    if (view.bindingPolicy === 'managed') { managed = true; return { ...view, binding }; }
    edits.push({ type: 'view.bind', viewId: view.id, binding, expectedBinding: view.binding! });
    return view;
  });
  if (!managed) return [...edits, ...rename];
  const { schemaVersion: _, id: __, revision: ___, ...layout } = window;
  return [{ type: 'layout.apply', layout: { ...layout, views } }, ...edits, ...rename];
}
