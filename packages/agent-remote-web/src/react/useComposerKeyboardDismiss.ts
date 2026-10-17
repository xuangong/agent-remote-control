import { useEffect, useRef } from 'react';

interface DismissGesture {
  editor: HTMLElement;
  touchId: number;
  x: number;
  y: number;
  started: number;
  moved: boolean;
  dismissed: boolean;
}

/** A focused composer owns dragging; a downward gesture dismisses its keyboard. */
export function useComposerKeyboardDismiss() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let gesture: DismissGesture | undefined;
    let composing = false;
    const reset = () => { gesture = undefined; };
    function selected(editor: HTMLElement): boolean {
      if (editor instanceof HTMLTextAreaElement) return editor.selectionStart !== editor.selectionEnd;
      const selection = document.getSelection();
      return !!selection && !selection.isCollapsed && (editor.contains(selection.anchorNode) || editor.contains(selection.focusNode));
    }
    function start(event: TouchEvent): void {
      if (gesture?.dismissed) return;
      reset();
      const editor = document.activeElement;
      const target = event.target instanceof Element ? event.target : undefined;
      if (event.defaultPrevented || event.touches.length !== 1 || composing || !(editor instanceof HTMLElement) || !root!.contains(editor)
        || !editor.matches('.agent-composer-draft textarea:not(:disabled):not([readonly]), .agent-composer-editor[contenteditable="true"]')
        || selected(editor) || !target) return;
      if (target.closest('button, a, input, select, [role="button"], [contenteditable="false"], .agent-command-menu, .agent-session-panel')) return;
      const touch = event.touches[0]!;
      gesture = { editor, touchId: touch.identifier, x: touch.screenX, y: touch.screenY, started: Date.now(), moved: false, dismissed: false };
    }
    function move(event: TouchEvent): void {
      if (!gesture) return;
      // Focus and viewport coordinates change as the keyboard closes. Keep owning
      // the accepted gesture until release so its remaining motion cannot pan.
      if (gesture.dismissed) { if (event.cancelable) event.preventDefault(); return; }
      if (event.defaultPrevented || event.touches.length !== 1 || composing || document.activeElement !== gesture.editor || selected(gesture.editor)) { reset(); return; }
      const touch = event.touches[0]!;
      if (touch.identifier !== gesture.touchId) { reset(); return; }
      // Keep long-press editing native, but do not time out an ongoing drag.
      if (!gesture.moved && Date.now() - gesture.started > 350) { reset(); return; }
      // Own the first movement, before the browser starts panning the viewport.
      if (event.cancelable) event.preventDefault();
      const dx = Math.abs(touch.screenX - gesture.x);
      const dy = touch.screenY - gesture.y;
      if (!gesture.moved && Math.max(dx, Math.abs(dy)) < 10) return;
      gesture.moved = true;
      // Follow upward or sideways motion so a downward reversal does not have
      // to travel back past the original touch point to close the keyboard.
      if (dy <= 0 || dy < dx * 1.4) { gesture.x = touch.screenX; gesture.y = touch.screenY; return; }
      if (dy < 10) return;
      gesture.dismissed = true;
      gesture.editor.blur();
    }
    function end(event: TouchEvent): void {
      if (gesture?.dismissed && event.cancelable) event.preventDefault();
      if (!gesture?.dismissed || event.touches.length === 0) reset();
    }
    const compositionStart = () => { composing = true; if (!gesture?.dismissed) reset(); };
    const compositionEnd = () => { composing = false; };
    const focusOut = () => { composing = false; if (!gesture?.dismissed) reset(); };
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end, { passive: false });
    root.addEventListener('touchcancel', reset);
    root.addEventListener('compositionstart', compositionStart, true);
    root.addEventListener('compositionend', compositionEnd, true);
    root.addEventListener('focusout', focusOut);
    return () => {
      root.removeEventListener('touchstart', start);
      root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end);
      root.removeEventListener('touchcancel', reset);
      root.removeEventListener('compositionstart', compositionStart, true);
      root.removeEventListener('compositionend', compositionEnd, true);
      root.removeEventListener('focusout', focusOut);
    };
  }, []);
  return ref;
}
