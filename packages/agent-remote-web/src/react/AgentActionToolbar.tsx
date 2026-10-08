import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface ComposerAction {
  id: string;
  label: string;
  content: ReactNode;
  title?: string;
  testId?: string;
  disabled?: boolean;
  expanded?: boolean;
  priority?: number;
  run(): void;
}

/** Keep a single action row, retaining higher-priority controls as space permits. */
export function AgentActionToolbar({ actions, active, overflowOpen, onOverflow, onStatus }: {
  actions: readonly ComposerAction[];
  active?: string;
  overflowOpen: boolean;
  onOverflow(open: boolean): void;
  onStatus(): void;
}) {
  const id = useId();
  const toolbar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState<readonly string[]>(actions.map(action => action.id));
  const layoutKey = JSON.stringify(actions.map(({ id, priority }) => [id, priority ?? 0]));
  useLayoutEffect(() => {
    const element = toolbar.current;
    const samples = measure.current;
    if (!element || !samples) return;
    const update = () => {
      const widths = Array.from(samples.children, child => child.getBoundingClientRect().width);
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      let available = element.clientWidth - (widths.at(-1) ?? 0);
      // Stable priority order also handles labels changing after Provider confirmation.
      const candidates = actions.map(({ id, priority }, index) => ({ id, priority, width: widths[index] ?? 0 }))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      const fitted = new Set<string>();
      for (const action of candidates) if (action.width + gap <= available) {
        fitted.add(action.id);
        available -= action.width + gap;
      }
      const next = actions.filter(action => fitted.has(action.id)).map(action => action.id);
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      if (focused?.dataset.actionId && element.contains(focused) && !fitted.has(focused.dataset.actionId)) more.current?.focus({ preventScroll: true });
      if (focused?.dataset.actionId && panel.current?.contains(focused) && fitted.has(focused.dataset.actionId)) more.current?.focus({ preventScroll: true });
      setVisible(previous => previous.join('|') === next.join('|') ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    for (const sample of Array.from(samples.children)) observer?.observe(sample);
    return () => observer?.disconnect();
  }, [layoutKey]);
  const overflow = actions.filter(action => !visible.includes(action.id));
  const showMore = overflowOpen || overflow.length > 0;
  const expanded = overflowOpen || active === 'status' || overflow.some(action => action.id === active);
  useLayoutEffect(() => {
    if (overflowOpen) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [overflowOpen]);
  const button = (action: ComposerAction, inMenu = false) => <button key={action.id} type="button"
    className={inMenu ? undefined : 'agent-toolbar-action'} aria-label={action.label} title={action.title}
    data-testid={action.testId} data-action-id={action.id} disabled={action.disabled} aria-expanded={action.expanded}
    onClick={() => { if (inMenu) more.current?.focus({ preventScroll: true }); onOverflow(false); action.run(); }}>{inMenu ? action.label : action.content}</button>;
  return <>
    <div className="agent-session-toolbar agent-action-toolbar" aria-label="Session controls" ref={toolbar}>
      <div className="agent-toolbar-measure" aria-hidden="true" ref={measure}>
        {actions.map(action => <span key={action.id} className="agent-toolbar-action">{action.content}</span>)}
        <span className="agent-toolbar-action agent-toolbar-more">•••</span>
      </div>
      {actions.filter(action => visible.includes(action.id)).map(action => button(action))}
      <button type="button" className="agent-toolbar-action agent-toolbar-more" ref={more}
        aria-label={showMore ? 'More actions' : 'Status'} title={showMore ? 'More actions' : 'Session status and planning'}
        aria-expanded={expanded} aria-controls={overflowOpen ? id : undefined}
        onClick={() => { if (overflowOpen) more.current?.focus({ preventScroll: true }); showMore ? onOverflow(!overflowOpen) : onStatus(); }}><span aria-hidden="true">•••</span></button>
    </div>
    {overflowOpen ? <section className="agent-session-panel agent-toolbar-menu" aria-label="More actions" id={id} ref={panel}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}>
      {overflow.map(action => button(action, true))}
      <button type="button" onClick={() => { more.current?.focus({ preventScroll: true }); onStatus(); }}>Status</button>
      <button type="button" aria-label="Close more actions" onClick={() => { onOverflow(false); more.current?.focus({ preventScroll: true }); }}>Close</button>
    </section> : null}
  </>;
}
