import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslate } from './locale.js';

/** One item of the composer's "+" menu: its accessible name, what it shows, and what it does. */
export interface ComposerMenuEntry {
  id: string;
  /** The accessible name ("Add images"). */
  label: string;
  /** What the item shows ("Image"); the label when absent. */
  text?: ReactNode;
  /** A second line: the current value of a setting, or why the item waits. */
  detail?: ReactNode;
  title?: string;
  testId?: string;
  /** An outcome the person has not seen yet (a setting change that failed): "+" carries a dot while the menu is closed. */
  attention?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  icon?: ReactNode;
  run(): void;
}

/**
 * The "+" at the left of the composer's capsule and the small menu it opens above it (I4, decision 2): the composer's actions and,
 * where the composer shows them, the session's settings. Which items show and which can be used is `composerMenu`'s rule; this
 * only presents them. Escape or a press outside closes it and gives the focus back to "+"; arrow keys move between items.
 */
export function ComposerMenu({ entries, open, onOpen }: { entries: readonly ComposerMenuEntry[]; open: boolean; onOpen(open: boolean): void }) {
  const t = useTranslate();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const expanded = open || entries.some(entry => entry.expanded);
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const scope = trigger.current?.closest('.agent-composer') ?? trigger.current;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) onOpen(false);
    };
    const escape = (event: Event) => {
      if (!(event instanceof KeyboardEvent) || event.key !== 'Escape' || event.defaultPrevented) return;
      if (trigger.current?.closest('[hidden], [inert]')) return;
      const dialog = 'dialog, [role="dialog"], [role="alertdialog"]';
      if (!(event.target instanceof Element) || event.target.closest(dialog) !== trigger.current?.closest(dialog)) return;
      event.preventDefault(); onOpen(false); trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    scope?.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); scope?.removeEventListener('keydown', escape); };
  }, [open, onOpen]);
  return <>
    <button type="button" ref={trigger} className="agent-composer-plus" aria-label={t('common.moreActions')} title={t('common.moreActions')}
      aria-expanded={expanded} aria-controls={id} disabled={!entries.length} data-attention={entries.some(entry => entry.attention) || undefined}
      onClick={() => { if (open) trigger.current?.focus({ preventScroll: true }); onOpen(!open); }}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
    </button>
    {/* The menu stays in the page while closed, so its items keep their state and names; it shows only while open. */}
    <section className="agent-composer-menu" aria-label={t('common.moreActions')} id={id} ref={panel} hidden={!open}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}>
      <ComposerMenuItems entries={entries} onRun={entry => { trigger.current?.focus({ preventScroll: true }); onOpen(false); entry.run(); }} />
    </section>
  </>;
}

/** The items of the menu as buttons: inside the + menu, or as the rows of a list where they stand open (the assistant's details). */
export function ComposerMenuItems({ entries, onRun = entry => entry.run() }: { entries: readonly ComposerMenuEntry[]; onRun?(entry: ComposerMenuEntry): void }) {
  return <>{entries.map(entry => <button key={entry.id} type="button" className="agent-composer-menu-item" aria-label={entry.label} title={entry.title}
    data-testid={entry.testId} data-action-id={entry.id} disabled={entry.disabled} aria-expanded={entry.expanded} onClick={() => onRun(entry)}>
    {entry.icon ? <span className="agent-composer-menu-icon" aria-hidden="true">{entry.icon}</span> : null}
    <span className="agent-composer-menu-text"><span>{entry.text ?? entry.label}</span>{entry.detail ? <small>{entry.detail}</small> : null}</span>
  </button>)}</>;
}
