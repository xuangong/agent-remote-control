export interface TimeReveal { offset: number; top: number; dragging: boolean }
export const idleTimeReveal: TimeReveal = { offset: 0, top: 0, dragging: false };
interface Entry { element: HTMLElement; direction: -1 | 1; actionable: boolean; publish(value: TimeReveal): void }
const timelines = new WeakMap<HTMLElement, ReturnType<typeof createGestures>>();

export function registerTimeGesture(entry: Entry): () => void {
  const root = entry.element.closest<HTMLElement>('.agent-timeline-entries') ?? entry.element;
  let gestures = timelines.get(root);
  if (!gestures) { gestures = createGestures(root); timelines.set(root, gestures); }
  const remove = gestures.register(entry);
  return () => { if (remove()) { gestures.dispose(); timelines.delete(root); } };
}

function createGestures(root: HTMLElement) {
  const entries = new Map<HTMLElement, Entry>();
  const mobile = window.matchMedia('(max-width: 1180px)');
  let active: Entry | undefined;
  let gesture: { id: number; x: number; y: number; top: number; started: number; locked: boolean; distance: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressClickUntil = 0;
  let suppressedElement: HTMLElement | undefined;
  let actionTouch = false;
  function reset() {
    clearTimeout(timer);
    actionTouch = false;
    gesture = undefined;
    active?.publish(idleTimeReveal);
    active = undefined;
  }
  function start(event: TouchEvent) {
    const target = event.target instanceof Element ? event.target : undefined;
    const element = target?.closest<HTMLElement>('.agent-timeline-entry');
    const entry = element ? entries.get(element) : undefined;
    if (!entry) return;
    if (target?.closest('[data-prompt-edit-action]')) {
      clearTimeout(timer); suppressClickUntil = 0; actionTouch = true;
      return;
    }
    reset();
    suppressClickUntil = 0;
    if (!mobile.matches || event.touches.length !== 1 || window.getSelection()?.toString()) return;
    if (!target || target.closest('input, textarea, select, [contenteditable="true"], pre, code, table, img, video, audio')) return;
    for (let node: Element | null = target; node && node !== element; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    }
    const touch = event.touches[0]!;
    // Leave screen-edge navigation to the browser, and long presses to selection.
    if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;
    const bounds = entry.element.getBoundingClientRect();
    active = entry;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY,
      top: Math.max(22, Math.min(bounds.height - 22, touch.clientY - bounds.top)),
      started: Date.now(), locked: false, distance: 0 };
  }
  function move(event: TouchEvent) {
    if (!gesture || !active) return;
    if (event.touches.length !== 1 || !mobile.matches) { reset(); return; }
    const touch = event.touches[0]!;
    if (touch.identifier !== gesture.id) { reset(); return; }
    const dx = (touch.clientX - gesture.x) * active.direction;
    const dy = Math.abs(touch.clientY - gesture.y);
    if (!gesture.locked) {
      if (Math.max(Math.abs(dx), dy) < 10) { event.stopPropagation(); return; }
      if (Date.now() - gesture.started > 350 || dx < 0 || dx < dy * 1.4) { reset(); return; }
      gesture.locked = true;
    }
    if (!event.cancelable) { reset(); return; }
    event.preventDefault();
    gesture.distance = Math.max(0, Math.min(active.actionable ? 164 : 116, dx));
    suppressClickUntil = Date.now() + 500;
    suppressedElement = active.element;
    active.publish({ offset: gesture.distance * active.direction, top: gesture.top, dragging: true });
  }
  function end() {
    if (actionTouch) { actionTouch = false; timer = setTimeout(reset, 5000); return; }
    if (gesture?.locked) suppressClickUntil = Date.now() + 500;
    if (!gesture?.locked || gesture.distance < 36 || !active) { reset(); return; }
    active.publish({ offset: (active.actionable ? 164 : 116) * active.direction, top: gesture.top, dragging: false });
    gesture = undefined;
    timer = setTimeout(reset, active.actionable ? 5000 : 1400);
  }
  function click(event: MouseEvent) {
    if (Date.now() < suppressClickUntil && event.target instanceof Node && suppressedElement?.contains(event.target)) {
      event.preventDefault(); event.stopPropagation();
    }
  }
  root.addEventListener('touchstart', start, { passive: true });
  // Only a confirmed horizontal reveal cancels native vertical/pinch scrolling.
  root.addEventListener('touchmove', move, { passive: false });
  root.addEventListener('touchend', end);
  root.addEventListener('touchcancel', reset);
  root.addEventListener('click', click, true);
  mobile.addEventListener('change', reset);
  window.addEventListener('blur', reset);
  return {
    register(entry: Entry) {
      entries.set(entry.element, entry);
      return () => {
        if (active === entry) reset();
        if (suppressedElement === entry.element) suppressedElement = undefined;
        entries.delete(entry.element);
        return entries.size === 0;
      };
    },
    dispose() {
      reset();
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', reset);
      root.removeEventListener('click', click, true);
      mobile.removeEventListener('change', reset);
      window.removeEventListener('blur', reset);
    },
  };
}
