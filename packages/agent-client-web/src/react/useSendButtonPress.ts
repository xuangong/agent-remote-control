import { useEffect, useRef, type ButtonHTMLAttributes } from 'react';

/** A hold inserts one newline; releasing it must never submit the draft. */
export function useSendButtonPress(sessionKey: string, enabled: boolean, onNewline: () => void, onSend: () => void): ButtonHTMLAttributes<HTMLButtonElement> {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pointer = useRef<{ id: number; x: number; y: number }>();
  const suppressClick = useRef(false);
  const latest = useRef({ enabled, onNewline });
  latest.current = { enabled, onNewline };
  function clearTimer() { clearTimeout(timer.current); timer.current = undefined; }
  function cancel() { clearTimer(); pointer.current = undefined; suppressClick.current = true; }
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hide);
    return () => {
      cancel();
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [sessionKey, enabled]);
  return {
    onPointerDown(event) {
      if (event.button !== 0 || !event.isPrimary || !enabled) return;
      // Keep the textarea and mobile keyboard focused during the gesture.
      event.preventDefault();
      clearTimer();
      suppressClick.current = false;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (!pointer.current || !latest.current.enabled) return;
        suppressClick.current = true;
        latest.current.onNewline();
      }, 500);
    },
    onPointerMove(event) {
      const start = pointer.current;
      // Touch pointers can move before the browser emits its first touchmove.
      // Cancel that early drag while allowing small contact jitter during a tap.
      const tolerance = event.pointerType === 'touch' ? 3 : 10;
      if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > tolerance) cancel();
    },
    onTouchMove(event) {
      // The enclosing composer consumes even a small keyboard-dismiss drag.
      // Cancel the hold before its timer can turn that movement into a newline.
      if (event.defaultPrevented) cancel();
    },
    onPointerUp(event) {
      if (pointer.current?.id !== event.pointerId) return;
      clearTimer();
      pointer.current = undefined;
    },
    onPointerCancel: cancel,
    onLostPointerCapture() { if (pointer.current) cancel(); },
    onContextMenu(event) { event.preventDefault(); },
    onKeyDown(event) { if (event.key === 'Enter' || event.key === ' ') suppressClick.current = false; },
    onClick(event) {
      if (suppressClick.current && event.detail !== 0) { event.preventDefault(); suppressClick.current = false; return; }
      suppressClick.current = false;
      onSend();
    },
  };
}
