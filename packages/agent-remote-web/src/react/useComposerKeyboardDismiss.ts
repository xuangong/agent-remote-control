import { useEffect, useRef, type RefObject } from 'react';

interface DismissGesture {
  editor: HTMLElement;
  touchId: number;
  top: number;
  started: number;
  editingText: boolean;
  owned: boolean;
  dismissed: boolean;
}

/** A focused composer owns dragging; a downward gesture dismisses its keyboard. */
export function useComposerKeyboardDismiss(boundaryRef?: RefObject<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const outer = boundaryRef?.current;
    const boundary = outer?.contains(root) ? outer : root;
    let gesture: DismissGesture | undefined;
    let composing = false;
    let suppressClick = false;
    const reset = () => { gesture = undefined; };
    const newPointer = () => { if (!gesture?.owned) suppressClick = false; };
    function click(event: MouseEvent): void {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    }
    function selected(editor: HTMLElement): boolean {
      if (editor instanceof HTMLTextAreaElement) return editor.selectionStart !== editor.selectionEnd;
      const selection = document.getSelection();
      return !!selection && !selection.isCollapsed && (editor.contains(selection.anchorNode) || editor.contains(selection.focusNode));
    }
    function start(event: TouchEvent): void {
      if (gesture?.dismissed) return;
      newPointer();
      reset();
      const editor = document.activeElement;
      const target = event.target instanceof Element ? event.target : undefined;
      if (event.defaultPrevented || event.touches.length !== 1 || !(editor instanceof HTMLElement) || !root!.contains(editor)
        || !editor.matches('.agent-composer-draft textarea:not(:disabled):not([readonly]), .agent-composer-editor[contenteditable="true"]')
        || !target) return;
      // Popovers own their scrolling, including when the composer itself is
      // embedded in an outer dialog. Ordinary controls share the draft gesture.
      const panel = target.closest('.agent-command-menu, .agent-command-details, .agent-session-panel, dialog, [role="dialog"], [role="alertdialog"]');
      if (panel && boundary.contains(panel) && !panel.contains(root)) return;
      const editingText = editor.contains(target) && !target.closest('[contenteditable="false"]');
      if (editingText && (composing || selected(editor))) return;
      const touch = event.touches[0]!;
      gesture = { editor, touchId: touch.identifier, top: touch.screenY, started: Date.now(), editingText, owned: false, dismissed: false };
    }
    function move(event: TouchEvent): void {
      if (!gesture) return;
      // Focus and viewport coordinates change as the keyboard closes. Keep owning
      // the accepted gesture until release so its remaining motion cannot pan.
      if (gesture.dismissed) { if (event.cancelable) event.preventDefault(); return; }
      if (event.touches.length !== 1) { reset(); return; }
      const touch = event.touches[0]!;
      if (touch.identifier !== gesture.touchId) { reset(); return; }
      const editing = event.defaultPrevented || document.activeElement !== gesture.editor || (gesture.editingText && (composing || selected(gesture.editor)));
      // Keep long-press editing native, but do not time out an ongoing drag.
      if (!gesture.owned && (editing || (gesture.editingText && Date.now() - gesture.started > 350))) { reset(); return; }
      // Own the first movement, before the browser starts panning the viewport.
      if (event.cancelable) event.preventDefault();
      gesture.owned = true;
      suppressClick = true;
      // Editing changes can veto dismissal, but must not release half a drag
      // back to native scrolling after the composer has consumed its beginning.
      if (editing) return;
      // Track the highest point of this continuous drag. A curved reversal is
      // still downward movement; sideways samples must not erase its distance.
      gesture.top = Math.min(gesture.top, touch.screenY);
      if (touch.screenY - gesture.top < 10) return;
      gesture.dismissed = true;
      gesture.editor.blur();
    }
    function end(event: TouchEvent): void {
      if (gesture?.owned && event.cancelable) event.preventDefault();
      if (!gesture?.dismissed || event.touches.length === 0) reset();
    }
    const compositionStart = () => { composing = true; if (gesture?.editingText && !gesture.owned) reset(); };
    const compositionEnd = () => { composing = false; };
    const focusOut = () => { composing = false; if (!gesture?.owned) reset(); };
    boundary.addEventListener('touchstart', start, { passive: true });
    boundary.addEventListener('touchmove', move, { passive: false });
    boundary.addEventListener('touchend', end, { passive: false });
    boundary.addEventListener('touchcancel', reset);
    boundary.addEventListener('pointerdown', newPointer, true);
    boundary.addEventListener('click', click, true);
    root.addEventListener('compositionstart', compositionStart, true);
    root.addEventListener('compositionend', compositionEnd, true);
    root.addEventListener('focusout', focusOut);
    return () => {
      boundary.removeEventListener('touchstart', start);
      boundary.removeEventListener('touchmove', move);
      boundary.removeEventListener('touchend', end);
      boundary.removeEventListener('touchcancel', reset);
      boundary.removeEventListener('pointerdown', newPointer, true);
      boundary.removeEventListener('click', click, true);
      root.removeEventListener('compositionstart', compositionStart, true);
      root.removeEventListener('compositionend', compositionEnd, true);
      root.removeEventListener('focusout', focusOut);
    };
  }, [boundaryRef]);
  return ref;
}
