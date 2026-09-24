import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type Destination = { key: string; placement: 'before' | 'after' };
type Drag = { key: string; target?: Destination };

export function useTrackedSessionDrag(keys: readonly string[], reorder: (key: string, target: string, placement: 'before' | 'after') => void) {
  const list = useRef<HTMLUListElement>(null);
  const latest = useRef({ keys, reorder }); latest.current = { keys, reorder };
  const [drag, setDrag] = useState<Drag>();
  const active = useRef<{ key: string; pointer: number; x: number; y: number; startX: number; startY: number; button: HTMLButtonElement; dragging: boolean; target?: Destination }>();
  const frame = useRef<number>();
  const suppressClick = useRef(false);

  function clear() {
    const previous = active.current; active.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    if (previous?.button.hasPointerCapture?.(previous.pointer)) previous.button.releasePointerCapture(previous.pointer);
    setDrag(undefined);
  }
  function updateTarget() {
    const pointer = active.current;
    if (!pointer?.dragging) return;
    const row = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('[data-tracked-key]');
    let target: Destination | undefined;
    if (row && list.current?.contains(row)) {
      const key = row.dataset.trackedKey!;
      if (key !== pointer.key && latest.current.keys.includes(key)) {
        const rect = row.getBoundingClientRect();
        target = { key, placement: pointer.y < rect.top + rect.height / 2 ? 'before' : 'after' };
      }
    }
    if (target?.key !== pointer.target?.key || target?.placement !== pointer.target?.placement) {
      pointer.target = target; setDrag({ key: pointer.key, target });
    }
  }
  function scroll() {
    const pointer = active.current;
    const panel = list.current?.closest<HTMLElement>('.lab-session-popover-panel');
    if (!pointer?.dragging || !panel) return;
    const rect = panel.getBoundingClientRect(), edge = 32;
    if (pointer.x >= rect.left && pointer.x <= rect.right) {
      const delta = pointer.y < rect.top + edge ? -Math.min(10, (rect.top + edge - pointer.y) / 3)
        : pointer.y > rect.bottom - edge ? Math.min(10, (pointer.y - rect.bottom + edge) / 3) : 0;
      if (delta) { panel.scrollTop += delta; updateTarget(); }
    }
    frame.current = requestAnimationFrame(scroll);
  }
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const pointer = active.current;
      if (!pointer || event.pointerId !== pointer.pointer) return;
      pointer.x = event.clientX; pointer.y = event.clientY;
      if (!pointer.dragging) {
        if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) < 6) return;
        pointer.dragging = true; suppressClick.current = true;
        setDrag({ key: pointer.key }); frame.current = requestAnimationFrame(scroll);
      }
      event.preventDefault(); updateTarget();
    };
    const up = (event: PointerEvent) => {
      const pointer = active.current;
      if (!pointer || pointer.pointer !== event.pointerId) return;
      pointer.x = event.clientX; pointer.y = event.clientY; updateTarget();
      if (pointer.dragging && pointer.target && latest.current.keys.includes(pointer.key)) {
        latest.current.reorder(pointer.key, pointer.target.key, pointer.target.placement);
      }
      clear();
    };
    const cancel = () => clear();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && active.current) { event.preventDefault(); event.stopPropagation(); clear(); }
    };
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('lostpointercapture', cancel);
    document.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', cancel);
    return () => {
      clear(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel); document.removeEventListener('lostpointercapture', cancel);
      document.removeEventListener('keydown', key, true); document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  useEffect(() => {
    if (active.current && (!list.current || !keys.includes(active.current.key))) clear();
  });
  function start(event: ReactPointerEvent<HTMLButtonElement>, key: string) {
    suppressClick.current = false;
    if (event.button !== 0 || !event.isPrimary || active.current) return;
    // Touch scrolling stays native outside the dedicated drag grip.
    if (event.pointerType === 'touch' && !(event.target instanceof Element && event.target.closest('.lab-tracked-grip'))) return;
    active.current = { key, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, button: event.currentTarget, dragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  return { list, drag, start, consumeClick() { const suppress = suppressClick.current; suppressClick.current = false; return suppress; } };
}
