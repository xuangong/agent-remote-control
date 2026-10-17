import { useEffect, useRef } from 'react';

interface DismissGesture {
  editor: HTMLElement;
  touchId: number;
  x: number;
  y: number;
  started: number;
  dismissed: boolean;
}

/** A downward gesture at the input boundary dismisses focus without moving the page. */
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
      // An input with earlier lines still above the viewport owns the entire swipe.
      // Reaching its top does not turn that same native scroll into a dismissal.
      for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
        if (element.scrollTop > 1 && element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY)) return;
      }
      const touch = event.touches[0]!;
      gesture = { editor, touchId: touch.identifier, x: touch.screenX, y: touch.screenY, started: Date.now(), dismissed: false };
    }
    function move(event: TouchEvent): void {
      if (!gesture) return;
      // Focus and viewport coordinates change as the keyboard closes. Keep owning
      // the accepted gesture until release so its remaining motion cannot pan.
      if (gesture.dismissed) { if (event.cancelable) event.preventDefault(); return; }
      if (event.defaultPrevented || event.touches.length !== 1 || composing || document.activeElement !== gesture.editor || selected(gesture.editor)) { reset(); return; }
      const touch = event.touches[0]!;
      if (touch.identifier !== gesture.touchId) { reset(); return; }
      const dx = Math.abs(touch.screenX - gesture.x);
      const dy = touch.screenY - gesture.y;
      if (Math.max(dx, Math.abs(dy)) < 10) return;
      if (Date.now() - gesture.started > 350 || dy <= 0 || dy < dx * 1.4 || !event.cancelable) { reset(); return; }
      event.preventDefault();
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
