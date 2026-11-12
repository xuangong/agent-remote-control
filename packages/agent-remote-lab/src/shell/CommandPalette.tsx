import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { commandKinds, searchCommands, type CommandItem, type CommandKind } from './command-search.js';
import { applePlatform } from '../platform.js';
import './shell.css';

const groupLabels: Record<CommandKind, string> = { action: 'Actions', window: 'Windows', bot: 'Bots', session: 'Sessions' };

/**
 * ⌘K: search actions, Windows, Bots and known sessions, and run one. A modal dialog with a combobox and a listbox; the
 * owner's `open` drives it. Escape and a press on the backdrop ask the owner to close it through `onClose`, and choosing an
 * item calls `onClose` before the item runs, so an item can open another dialog. Closing the modal returns focus to
 * whatever had it when the palette opened. The shell's ⌘K (Ctrl+K elsewhere) stands aside while a dialog is open, so the
 * palette handles it itself: pressed again, it closes.
 */
export function CommandPalette({ open, items, onClose }: { open: boolean; items: readonly CommandItem[]; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The body mounts with the dialog's opening (its effects run first), so each opening starts with an empty query.
  // Closing in the cleanup, before React removes the node, lets the browser return focus when the palette unmounts while open.
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    if (!node.open) node.showModal();
    input.current?.focus();
    return () => node.close();
  }, [open]);
  // A press closes from the backdrop only when it both starts and ends there, so a text selection dragged out of the
  // field does not close the palette.
  const pressedBackdrop = useRef(false);
  return <dialog ref={dialog} className="lab-command-palette" aria-label="Search"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.altKey || event.shiftKey) return;
      const apple = applePlatform();
      const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary || (event.code !== 'KeyK' && event.key.toLowerCase() !== 'k')) return;
      event.preventDefault(); onClose();
    }}
    onPointerDown={event => { pressedBackdrop.current = event.target === event.currentTarget; }}
    // Browsers queue the close event: ignore one that arrives after the palette was opened again.
    onClose={event => { if (open && !event.currentTarget.open) onClose(); }}
    // The body fills the dialog, so a click aimed at the dialog itself is a press on the backdrop.
    onClick={event => {
      const backdrop = pressedBackdrop.current && event.target === event.currentTarget;
      pressedBackdrop.current = false;
      if (backdrop) onClose();
    }}>
    {open ? <PaletteBody items={items} input={input} onClose={onClose} /> : null}
  </dialog>;
}

function PaletteBody({ items, input, onClose }: { items: readonly CommandItem[]; input: RefObject<HTMLInputElement>; onClose(): void }) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Results show grouped by kind, which can reorder them across scores; `shown` is the order on screen, and the active
  // option, aria-activedescendant and the keys all use indices into it.
  const groups = useMemo(() => {
    const results = searchCommands(items, query);
    return commandKinds.map(kind => ({ kind, entries: results.filter(item => item.kind === kind) })).filter(group => group.entries.length);
  }, [items, query]);
  const shown = useMemo(() => groups.flatMap(group => group.entries), [groups]);
  const current = Math.min(active, shown.length - 1);
  const optionId = (index: number) => `${listId}-option-${index}`;
  const choose = (item: CommandItem | undefined) => { if (!item) return; onClose(); item.run(); };
  const move = (next: number) => { if (shown.length) setActive((next + shown.length) % shown.length); };
  // Only when the active option or the query changes: a list the reader scrolled stays where it is as the page renders.
  useEffect(() => { if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView?.({ block: 'nearest' }); }, [current, query]);
  let index = 0;
  return <div className="lab-command-body">
    <input ref={input} className="lab-command-input" type="text" role="combobox" aria-label="Search Windows, Bots, sessions and actions" aria-expanded={shown.length > 0}
      aria-controls={listId} aria-autocomplete="list" aria-activedescendant={current >= 0 ? optionId(current) : undefined}
      placeholder="Search Windows, Bots, sessions and actions" autoComplete="off" spellCheck={false} value={query}
      onChange={event => { setQuery(event.target.value); setActive(0); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown') move(current + 1);
        else if (event.key === 'ArrowUp') move(current - 1);
        else if (event.key === 'Home') move(0);
        else if (event.key === 'End') move(shown.length - 1);
        else if (event.key === 'Enter') choose(shown[current]);
        else return;
        event.preventDefault();
      }} />
    <div id={listId} role="listbox" aria-label="Results" className="lab-command-results">
      {groups.map(group => <div key={group.kind} role="group" aria-label={groupLabels[group.kind]} className="lab-command-group">
        <div className="lab-command-group-title" aria-hidden="true">{groupLabels[group.kind]}</div>
        {group.entries.map(item => {
          const position = index++;
          return <div key={item.id} id={optionId(position)} role="option" aria-selected={position === current} aria-keyshortcuts={item.keyShortcuts} className="lab-command-option"
            onPointerMove={() => setActive(position)} onClick={() => choose(item)}>
            <span className="lab-command-title">{item.title}</span>
            {item.subtitle ? <span className="lab-command-subtitle">{item.subtitle}</span> : null}
            {item.shortcut ? <kbd className="lab-command-shortcut" aria-hidden="true">{item.shortcut}</kbd> : null}
          </div>;
        })}
      </div>)}
    </div>
    <p className="lab-command-empty" role="status">{shown.length ? '' : 'No results'}</p>
  </div>;
}
