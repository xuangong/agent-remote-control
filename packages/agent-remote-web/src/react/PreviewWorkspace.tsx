import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

export const PreviewWorkspaceContext = createContext<{
  open: boolean; setContainer(element: HTMLDivElement | null): void;
} | undefined>(undefined);

export function PreviewWorkspace({ children, className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  const context = useContext(PreviewWorkspaceContext);
  const container = useRef<HTMLDivElement | null>(null);
  const [fraction, setFraction] = useState(0.5);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const open = context?.open ?? false;
  const setContainer = context?.setContainer;
  const attach = useCallback((element: HTMLDivElement | null) => { container.current = element; setContainer?.(element); }, [setContainer]);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(element.getBoundingClientRect().width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const minimum = width ? Math.min(0.5, Math.max(0.2, 280 / width)) : 0.2;
  const clamp = (value: number) => Math.max(minimum, Math.min(1 - minimum, value));
  const displayedFraction = clamp(fraction);
  const resize = (clientX: number) => {
    const rect = container.current?.getBoundingClientRect();
    if (rect?.width) setFraction(clamp((rect.right - clientX) / rect.width));
  };
  return <div {...props} ref={attach}
    className={`agent-preview-workspace${className ? ` ${className}` : ''}`} data-preview-open={open || undefined}
    style={{ ...style, '--agent-preview-width': `${displayedFraction * 100}%` } as CSSProperties}>
    <div className="agent-preview-workspace-content">{children}</div>
    {open ? <>
      {dragging ? <div className="agent-preview-resize-shield" /> : null}
      <div className="agent-preview-divider" role="separator" aria-label="Resize conversation and preview" aria-orientation="vertical"
        aria-valuemin={Math.round(minimum * 100)} aria-valuemax={Math.round((1 - minimum) * 100)} aria-valuenow={Math.round((1 - displayedFraction) * 100)} tabIndex={0}
        title="Drag to resize · Double-click to reset" onDoubleClick={() => setFraction(0.5)}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
        }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
        onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
        onKeyDown={event => {
          const next = event.key === 'ArrowLeft' ? displayedFraction + 0.02 : event.key === 'ArrowRight' ? displayedFraction - 0.02
            : event.key === 'Home' ? 0.8 : event.key === 'End' ? 0.2 : event.key === 'Enter' ? 0.5 : undefined;
          if (next !== undefined) { event.preventDefault(); setFraction(clamp(next)); }
        }} />
    </> : null}
  </div>;
}
