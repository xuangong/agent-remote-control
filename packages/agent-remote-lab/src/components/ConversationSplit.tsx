import { createContext, createElement, forwardRef, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';

const storageKey = 'agent-remote.conversation-split-ratio';
const minimumWidth = 320;
const SplitContext = createContext<{ id: string; start: number; end: number } | undefined>(undefined);

function savedRatio(): number {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 && value < 1 ? value : .5;
  } catch { return .5; }
}

export const ConversationPane = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { as?: 'div' | 'aside'; position?: number }>(function ConversationPane({ as = 'div', position = 0, style, ...props }, ref) {
  const split = useContext(SplitContext);
  const side = position === split?.start ? 'leading' : position === split?.end ? 'trailing' : undefined;
  return createElement(as, { ...props, ref, id: props.id ?? (split ? `${split.id}-pane-${position}` : undefined),
    'data-split-side': side, style: { ...style, order: position * 2 } });
});

export function ConversationSplit({ compact, start, end, children }: { compact: boolean; start: number; end: number; children: ReactNode }) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [preferredRatio, setPreferredRatio] = useState(savedRatio);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number }>();
  const resizable = !compact && end > start;
  const minimumRatio = availableWidth > 0 ? Math.min(.5, minimumWidth / availableWidth) : .5;
  const ratio = Math.max(minimumRatio, Math.min(1 - minimumRatio, preferredRatio));
  const context = useMemo(() => ({ id, start, end }), [id, start, end]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !resizable) return;
    const measure = () => {
      const panes = Array.from(element.children).filter(child => child instanceof HTMLElement && child.dataset.splitSide && !child.hidden);
      setAvailableWidth(panes.reduce((width, pane) => width + pane.getBoundingClientRect().width, 0));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) if (child.classList.contains('lab-collapsed-conversations')) observer.observe(child);
    return () => observer.disconnect();
  }, [resizable, start, end]);
  useEffect(() => {
    if (!dragging) {
      try { localStorage.setItem(storageKey, String(preferredRatio)); } catch { /* The layout remains adjustable without storage. */ }
    }
  }, [preferredRatio, dragging]);
  useEffect(() => { if (!resizable) { drag.current = undefined; setDragging(false); } }, [resizable]);
  const resize = (next: number) => setPreferredRatio(Math.max(minimumRatio, Math.min(1 - minimumRatio, next)));
  const stopDragging = () => { drag.current = undefined; setDragging(false); };
  return <SplitContext.Provider value={context}><div ref={container} className={`lab-conversation-split${end > 0 ? ' lab-has-side' : ''}`}
    data-resizable={resizable || undefined} style={{ '--lab-conversation-ratio': ratio } as CSSProperties}>
    {children}
    {resizable ? <div className="lab-conversation-resize" role="separator" tabIndex={0} aria-label="Conversation widths" aria-orientation="vertical"
      aria-controls={`${id}-pane-${start}`} aria-valuemin={Math.round(minimumRatio * 100)} aria-valuemax={Math.round((1 - minimumRatio) * 100)}
      aria-valuenow={Math.round(ratio * 100)} aria-valuetext={`${Math.round(ratio * 100)}% left, ${Math.round((1 - ratio) * 100)}% right`}
      title="Drag to resize. Double-click to reset. Arrow keys adjust width." style={{ order: start * 2 + 1 }} data-resizing={dragging || undefined}
      onDoubleClick={() => resize(.5)}
      onPointerDown={event => {
        if (event.button !== 0 || availableWidth <= 0) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        drag.current = { x: event.clientX, width: ratio * availableWidth };
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={event => { if (drag.current && availableWidth > 0) resize((drag.current.width + event.clientX - drag.current.x) / availableWidth); }}
      onPointerUp={event => { stopDragging(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={stopDragging} onLostPointerCapture={stopDragging}
      onKeyDown={event => {
        if (availableWidth <= 0) return;
        const step = (event.shiftKey ? 40 : 10) / availableWidth;
        const next = event.key === 'ArrowLeft' ? ratio - step : event.key === 'ArrowRight' ? ratio + step
          : event.key === 'Home' ? minimumRatio : event.key === 'End' ? 1 - minimumRatio : event.key === 'Enter' ? .5 : undefined;
        if (next !== undefined) { event.preventDefault(); resize(next); }
      }} /> : null}
  </div></SplitContext.Provider>;
}
