import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';

/**
 * A bottom sheet on a modal dialog, content-sized (`content`), half (`medium`) or nearly full (`large`) height; its body
 * scrolls. The owner's `open` drives it. Escape, a press on the backdrop and Close ask the owner to close it through `onClose`, which also hears about a
 * close the browser makes on its own; keep `onClose` idempotent.
 */
export function Sheet({ open, title, onClose, detent = 'medium', children }: {
  open: boolean; title: string; onClose(): void; detent?: 'content' | 'medium' | 'large'; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const pressedBackdrop = useRef(false);
  // Closing in the cleanup, before React removes the node, lets the browser return focus when the sheet unmounts while open.
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    if (!node.open) node.showModal();
    return () => node.close();
  }, [open]);
  // Only a press that starts on the backdrop, outside the sheet's box, dismisses it, and not one that closes an open menu:
  // this window capture listener runs before a Menu's document listener closes the menu.
  useEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    const press = (event: MouseEvent) => {
      const box = node.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      pressedBackdrop.current = event.target === node && outside && !node.querySelector('[role="menu"]');
    };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, [open]);
  return <dialog ref={dialog} className="ui-sheet" data-detent={detent} aria-labelledby={heading}
    // Escape belongs to this modal's cancellation policy rather than a containing panel.
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); onClose(); }}
    // Browsers queue the close event: ignore one that arrives after the sheet was opened again.
    onClose={event => { if (open && !event.currentTarget.open) onClose(); }}
    onClick={event => {
      if (pressedBackdrop.current && event.target === event.currentTarget) onClose();
      pressedBackdrop.current = false;
    }}>
    <div className="ui-sheet-grabber" aria-hidden="true" />
    <header className="ui-sheet-header"><h2 id={heading}>{title}</h2><IconButton icon="close" label="Close" onClick={() => onClose()} /></header>
    <div className="ui-sheet-body">{children}</div>
  </dialog>;
}
