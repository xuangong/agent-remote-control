import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useImageDismiss, type ImageDismissMotion } from './useImageDismiss.js';

interface Point { x: number; y: number }
interface Transform extends Point { zoom: number }
interface Size { width: number; height: number }
const fitted: Transform = { zoom: 1, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const midpoint = (points: Point[]): Point => points.length === 1 ? points[0]! : { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 };
const distance = (points: Point[]) => points.length < 2 ? 0 : Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);

/** Keeps image gestures inside the preview, independent of page and timeline zoom. */
export function ImageViewport({ src, label, onClose, onDismissMotion }: {
  src: string; label: string; onClose(): void; onDismissMotion(motion: ImageDismissMotion): void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size>();
  const [bounds, setBounds] = useState<Size>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState(fitted);
  const current = useRef(view);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: Transform; points: Point[]; mode: 'pending' | 'pan' | 'dismiss'; startedAt: number }>();
  const multiTouch = useRef(false);
  const dismiss = useImageDismiss(onClose, onDismissMotion);
  const [dragging, setDragging] = useState(false);
  const fit = natural && bounds.width && bounds.height ? Math.min(1, bounds.width / natural.width, bounds.height / natural.height) : 0;
  const width = (natural?.width ?? 0) * fit;
  const height = (natural?.height ?? 0) * fit;
  const maximum = fit ? Math.max(8, 8 / fit) : 8;
  const ready = Boolean(fit && !failed);

  function change(next: Transform): void {
    const zoom = clamp(next.zoom, 1, maximum);
    const horizontal = Math.max(0, (width * zoom - bounds.width) / 2);
    const vertical = Math.max(0, (height * zoom - bounds.height) / 2);
    current.current = { zoom, x: clamp(next.x, -horizontal, horizontal), y: clamp(next.y, -vertical, vertical) };
    setView(current.current);
  }
  function zoomTo(zoom: number, point: Point = { x: 0, y: 0 }): void {
    if (dismiss.closing()) return;
    dismiss.cancel(false);
    const previous = current.current;
    const ratio = clamp(zoom, 1, maximum) / previous.zoom;
    change({ zoom: previous.zoom * ratio, x: point.x - (point.x - previous.x) * ratio, y: point.y - (point.y - previous.y) * ratio });
  }
  function relative(clientX: number, clientY: number): Point {
    const box = stage.current!.getBoundingClientRect();
    return { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
  }
  function rebase(time: number): void {
    gesture.current = { view: current.current, points: [...pointers.current.values()],
      mode: pointers.current.size === 1 && current.current.zoom === 1 && !multiTouch.current ? 'pending' : 'pan', startedAt: time };
  }
  function release(event: PointerEvent<HTMLDivElement>, cancelled = false): void {
    if (!pointers.current.has(event.pointerId)) return;
    if (gesture.current?.mode === 'dismiss') {
      if (cancelled) dismiss.cancel();
      else dismiss.finish(event.timeStamp, bounds.height);
    }
    pointers.current.delete(event.pointerId); rebase(event.timeStamp);
    if (!pointers.current.size) multiTouch.current = false;
    setDragging(pointers.current.size > 0);
  }

  useLayoutEffect(() => {
    const element = stage.current!;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setBounds(previous => previous.width === box.width && previous.height === box.height ? previous : { width: box.width, height: box.height });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useLayoutEffect(() => {
    // Rotation and resized upload controls establish a fresh fit without stale drag offsets.
    current.current = fitted; setView(fitted); pointers.current.clear(); gesture.current = undefined; multiTouch.current = false; setDragging(false);
    dismiss.cancel(false);
  }, [bounds.width, bounds.height, src]);
  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      if (!ready) return;
      event.preventDefault(); event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
      zoomTo(current.current.zoom * Math.exp(clamp(-event.deltaY * unit * .002, -1, 1)), relative(event.clientX, event.clientY));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [ready, width, height, bounds.width, bounds.height, maximum]);
  useEffect(() => {
    const clear = () => {
      pointers.current.clear(); gesture.current = undefined; multiTouch.current = false; setDragging(false);
      if (!dismiss.closing()) dismiss.cancel(false);
    };
    document.addEventListener('visibilitychange', clear);
    window.addEventListener('blur', clear);
    return () => { document.removeEventListener('visibilitychange', clear); window.removeEventListener('blur', clear); };
  }, []);

  return <div className="agent-image-viewport">
    <div ref={stage} className="agent-image-preview-stage" tabIndex={0} role="group" aria-label="Image canvas"
      data-zoomed={view.zoom > 1} data-dragging={dragging} aria-busy={!natural && !failed}
      onPointerDown={event => {
        if (!ready || dismiss.closing() || (event.pointerType === 'mouse' && event.button !== 0) || pointers.current.size >= 2) return;
        event.preventDefault();
        dismiss.cancel(false);
        pointers.current.set(event.pointerId, relative(event.clientX, event.clientY));
        if (pointers.current.size > 1) multiTouch.current = true;
        event.currentTarget.setPointerCapture(event.pointerId); rebase(event.timeStamp); setDragging(true);
      }}
      onPointerMove={event => {
        if (!pointers.current.has(event.pointerId) || !gesture.current) return;
        event.preventDefault();
        pointers.current.set(event.pointerId, relative(event.clientX, event.clientY));
        const start = gesture.current; const points = [...pointers.current.values()];
        const before = midpoint(start.points); const after = midpoint(points);
        const dx = after.x - before.x; const dy = after.y - before.y;
        if (start.mode === 'pending') {
          if (Math.hypot(dx, dy) < 8) return;
          start.mode = dy > Math.abs(dx) ? 'dismiss' : 'pan';
          if (start.mode === 'dismiss') dismiss.begin(start.startedAt);
        }
        if (start.mode === 'dismiss') {
          dismiss.move(dx, dy, event.timeStamp, bounds.height);
          return;
        }
        const span = distance(start.points);
        const zoom = clamp(start.view.zoom * (span > 0 ? distance(points) / span : 1), 1, maximum);
        const ratio = zoom / start.view.zoom;
        change({ zoom, x: after.x - (before.x - start.view.x) * ratio, y: after.y - (before.y - start.view.y) * ratio });
      }}
      onPointerUp={event => release(event)} onPointerCancel={event => release(event, true)} onLostPointerCapture={event => release(event, true)}
      onDoubleClick={event => { if (ready) zoomTo(current.current.zoom > 1 ? 1 : Math.max(2, 1 / fit), relative(event.clientX, event.clientY)); }}
      onKeyDown={event => {
        if (!ready || event.altKey || event.ctrlKey || event.metaKey) return;
        const steps: Record<string, Point> = { ArrowLeft: { x: 60, y: 0 }, ArrowRight: { x: -60, y: 0 }, ArrowUp: { x: 0, y: 60 }, ArrowDown: { x: 0, y: -60 } };
        const step = steps[event.key];
        if (step) change({ ...current.current, x: current.current.x + step.x, y: current.current.y + step.y });
        else if (event.key === '+' || event.key === '=') zoomTo(current.current.zoom * 1.5);
        else if (event.key === '-') zoomTo(current.current.zoom / 1.5);
        else if (event.key === '0') change(fitted);
        else return;
        event.preventDefault(); event.stopPropagation();
      }}>
      {!failed ? <img src={src} alt={label} draggable={false}
        style={ready ? {
          width, height,
          transform: `translate(-50%, -50%) translate(${view.x + dismiss.motion.x}px, ${view.y + dismiss.motion.y}px) scale(${view.zoom * dismiss.motion.scale})`,
          borderRadius: Math.min(14, dismiss.motion.progress * 56),
          boxShadow: dismiss.motion.progress ? `0 12px 40px oklch(0.18 0.01 250 / ${Math.min(.24, dismiss.motion.progress)})` : undefined,
        } : { visibility: 'hidden' }}
        onLoad={event => {
          const image = event.currentTarget;
          setNatural({ width: image.naturalWidth, height: image.naturalHeight });
        }} onError={() => setFailed(true)} /> : <span role="alert">This image cannot be previewed.</span>}
      {!natural && !failed ? <span role="status">Loading image…</span> : null}
    </div>
    <div className="agent-image-preview-controls" role="group" aria-label="Image zoom">
      <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!ready || view.zoom <= 1} onClick={() => zoomTo(current.current.zoom / 1.5)}>−</button>
      <span className="agent-image-preview-scale" aria-label="Zoom level">{ready ? `${Math.round(fit * view.zoom * 100)}%` : '—'}</span>
      <button type="button" aria-label="Zoom in" title="Zoom in" disabled={!ready || view.zoom >= maximum} onClick={() => zoomTo(current.current.zoom * 1.5)}>+</button>
      <button type="button" aria-label="Reset zoom" title="Fit to screen" disabled={!ready} onClick={() => change(fitted)}>Fit</button>
    </div>
  </div>;
}
