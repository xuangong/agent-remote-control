import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Toolbar } from '../ui/Toolbar.js';
import { IconButton } from '../ui/IconButton.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import './shell.css';

/**
 * The toolbar above a desktop Window: its name (renamed in place) and view count, adding views, the dock rail, and
 * Window actions. The title button is named by its text, so the heading reads as the Window name; renaming is its
 * description. That keeps it apart from the sidebar row's "Rename Window: …" control, on screen with it.
 */
export function WindowToolbar({ windowId, title, viewCount, leading, disabled, readOnly, deleteDisabled, onRename, onNewView, onOpenSession, hasDocks, docksHidden, onToggleDocks,
  botAppearance, onBotAppearance, onCopyLink, onAgentControl, onDelete }: {
  /** The Window shown; when another one takes the toolbar, an open rename ends without saving. */
  windowId: string; title: string; viewCount: number; leading?: ReactNode; disabled?: boolean;
  /** The Window is shown before it is confirmed (a cold start): renaming, adding views, hiding in Bot mode and deletion wait. */
  readOnly?: boolean;
  /** Deleting waits, for example while another Window action runs. */
  deleteDisabled?: boolean;
  onRename(title: string): void;
  onNewView(): void; onOpenSession(): void; hasDocks: boolean; docksHidden: boolean; onToggleDocks(): void;
  /** Whether the Window's group appears in Bot mode; undefined leaves the toggle out (no group to change). */
  botAppearance?: boolean; onBotAppearance(shown: boolean): void; onCopyLink(): void; onAgentControl?(): void; onDelete(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const button = useRef<HTMLButtonElement>(null);
  // Set when an edit ends, so the blur that follows Enter or Escape (the field leaving the page) does not end it again.
  const ended = useRef(false);
  const returnFocus = useRef(false);
  useLayoutEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    button.current?.focus();
  }, [editing]);
  // A rename belongs to the Window it started in: when the toolbar shows another Window, the edit ends unsaved, and
  // focus moves from the field that leaves the page to the new title.
  const shown = useRef(windowId);
  useLayoutEffect(() => {
    if (shown.current === windowId) return;
    shown.current = windowId;
    if (!editing || ended.current) return;
    ended.current = true;
    returnFocus.current = true;
    setEditing(false);
  }, [windowId, editing]);
  const titleDisabled = disabled || readOnly;
  const start = () => {
    if (titleDisabled) return;
    ended.current = false;
    setDraft(title);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (ended.current) return;
    ended.current = true;
    returnFocus.current = true;
    setEditing(false);
    const next = draft.trim();
    if (save && next && next !== title) onRename(next);
  };
  const actions: MenuEntry[] = [
    ...(botAppearance === undefined ? [] : [botAppearance
      ? { label: 'Hide in Bot mode', icon: 'eye-off', disabled: readOnly, onSelect: () => onBotAppearance(false) } as const
      : { label: 'Show in Bot mode', icon: 'sidebar', disabled: readOnly, onSelect: () => onBotAppearance(true) } as const]),
    { label: 'Copy link', icon: 'link', onSelect: onCopyLink },
    ...(onAgentControl ? [{ label: 'Agent control…', icon: 'person', onSelect: onAgentControl } as const] : []),
    { kind: 'separator' },
    { label: 'Delete Window…', icon: 'trash', destructive: true, disabled: readOnly || deleteDisabled, onSelect: onDelete },
  ];
  return <Toolbar className="lab-window-toolbar" leading={leading}
    title={editing
      ? <input className="lab-window-toolbar-input" aria-label="Window title" autoFocus maxLength={256} value={draft}
          onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); finish(true); }
            // Escape cancels here only: not an enclosing dialog, the page, nor the sessions page.
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
          }}
          onBlur={() => finish(true)} />
      : <button ref={button} type="button" className="lab-window-toolbar-title" title="Rename this Window" aria-description="Rename this Window"
          disabled={titleDisabled} onClick={start}>{title}</button>}
    subtitle={`${viewCount} ${viewCount === 1 ? 'session view' : 'session views'}`}
    trailing={<>
      <Menu label="Add" icon="plus" items={[
        { label: 'New session view', icon: 'plus', disabled: readOnly, onSelect: onNewView },
        { label: 'Open session…', icon: 'sessions', disabled: readOnly, onSelect: onOpenSession },
      ]} />
      {hasDocks ? <IconButton icon="dock" label={docksHidden ? 'Show docks' : 'Hide docks'}
        // The name says what a press does, so the button is not also a pressed toggle. Hiding the docks may hide the focused control; focus stays on the toggle, even where a click does not focus buttons (Safari).
        onClick={event => { event.currentTarget.focus({ preventScroll: true }); onToggleDocks(); }} /> : null}
      <Menu label="Window actions" items={actions} />
    </>} />;
}
