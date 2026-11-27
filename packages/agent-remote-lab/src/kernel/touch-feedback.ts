/**
 * The pressed state of a control under a finger (touch.css, `[data-pressed]`). The browsers hold `:active` back while a touch might
 * become a scroll (Chromium about 100 ms, iOS inside a scroll view), so the press is marked on touchstart itself and cleared when
 * the finger lifts, is cancelled, or moves far enough to be a scroll. The listeners are passive and never block scrolling.
 */
export const pressable = 'button, summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], .lab-session-row, label[for]';
const scrollSlopPixels = 10;

export function enableTouchPressedState(target: Document): () => void {
  let pressed: { element: Element; x: number; y: number } | undefined;
  const release = (): void => { pressed?.element.removeAttribute('data-pressed'); pressed = undefined; };
  const press = (event: TouchEvent): void => {
    release();
    const touch = event.touches[0];
    const element = event.target instanceof Element ? event.target.closest(pressable) : null;
    if (!touch || event.touches.length > 1 || !element || element.matches(':disabled, [aria-disabled="true"]')) return;
    element.setAttribute('data-pressed', '');
    pressed = { element, x: touch.clientX, y: touch.clientY };
  };
  const move = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (pressed && touch && Math.hypot(touch.clientX - pressed.x, touch.clientY - pressed.y) > scrollSlopPixels) release();
  };
  const options = { passive: true } as const;
  target.addEventListener('touchstart', press, options);
  target.addEventListener('touchmove', move, options);
  target.addEventListener('touchend', release, options);
  target.addEventListener('touchcancel', release, options);
  return () => {
    release();
    target.removeEventListener('touchstart', press);
    target.removeEventListener('touchmove', move);
    target.removeEventListener('touchend', release);
    target.removeEventListener('touchcancel', release);
  };
}
