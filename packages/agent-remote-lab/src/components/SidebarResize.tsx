import { useEffect, useRef, useState, type CSSProperties } from 'react';

const storageKey = 'agent-remote.sidebar-width';
const defaultWidth = 320;
const minWidth = 260;
const maxWidth = 560;

function savedWidth(): number {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value >= minWidth && value <= maxWidth ? value : defaultWidth;
  } catch { return defaultWidth; }
}

export function useSidebarWidth(inspectorOpen: boolean) {
  const [preferredWidth, setWidth] = useState(savedWidth);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setViewport(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(preferredWidth)); } catch { /* Resizing remains available without browser storage. */ }
  }, [preferredWidth]);
  const maximum = Math.max(minWidth, Math.min(maxWidth, viewport - 480 - (inspectorOpen ? 320 : 0)));
  const width = Math.min(preferredWidth, maximum);
  return { width, maximum, setWidth,
    style: { '--lab-sidebar-width': `${width}px` } as CSSProperties };
}

export function SidebarResize({ width, maximum, onChange }: { width: number; maximum: number; onChange(value: number): void }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number }>();
  const resize = (value: number) => onChange(Math.round(Math.max(minWidth, Math.min(maximum, value))));
  return <div className="lab-sidebar-resize" role="separator" tabIndex={0}
    aria-label="Sidebar width" aria-orientation="vertical" aria-controls="lab-context"
    aria-valuemin={minWidth} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    title="Drag to resize. Double-click to reset. Arrow keys adjust width."
    data-resizing={dragging || undefined}
    onDoubleClick={() => resize(defaultWidth)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    }}
    onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }}
    onPointerUp={event => { drag.current = undefined; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = undefined; setDragging(false); }}
    onLostPointerCapture={() => { drag.current = undefined; setDragging(false); }}
    onKeyDown={event => {
      const delta = event.shiftKey ? 40 : 10;
      const next = event.key === 'ArrowLeft' ? width - delta : event.key === 'ArrowRight' ? width + delta
        : event.key === 'Home' ? minWidth : event.key === 'End' ? maximum : event.key === 'Enter' ? defaultWidth : undefined;
      if (next !== undefined) { event.preventDefault(); resize(next); }
    }} />;
}
