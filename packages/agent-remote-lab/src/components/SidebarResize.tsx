import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

const storageKey = 'agent-remote.sidebar-width';
const defaultWidth = 260;
const minWidth = 220;
const maxWidth = 360;
/** The navigation rail (60px and its 10px margin) and the shell's own padding, which the sidebar, the stage and the inspector do not share. */
const frameChrome = 80;
const minimumStage = 480;
const inspectorWidth = 320;

/** The saved width, clamped to the allowed range so a width saved under an older range survives as the nearest one. */
function savedWidth(): number {
  try {
    const value = Number(localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 ? Math.min(maxWidth, Math.max(minWidth, Math.round(value))) : defaultWidth;
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
  // With the rail and the inspector open, the sidebar gives way so that the stage keeps its minimum room.
  const maximum = Math.max(minWidth, Math.min(maxWidth, viewport - frameChrome - minimumStage - (inspectorOpen ? inspectorWidth : 0)));
  const width = Math.min(preferredWidth, maximum);
  return { width, maximum, setWidth,
    style: { '--lab-sidebar-width': `${width}px` } as CSSProperties };
}

export function SidebarResize({ width, maximum, onChange }: { width: number; maximum: number; onChange(value: number): void }) {
  const t = useTranslate();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number }>();
  const resize = (value: number) => onChange(Math.round(Math.max(minWidth, Math.min(maximum, value))));
  return <div className="lab-sidebar-resize" role="separator" tabIndex={0}
    aria-label={t('windows.sidebarWidth')} aria-orientation="vertical" aria-controls="lab-context"
    aria-valuemin={minWidth} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={t('windows.resize.value', { width })}
    title={t('windows.sidebarResize.hint')}
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
