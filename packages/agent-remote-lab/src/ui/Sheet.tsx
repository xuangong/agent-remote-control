import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';

/**
 * A bottom sheet on a modal dialog: half height (`medium`) or nearly full (`large`). The owner's `open` drives it; Escape,
 * a press on the backdrop or Close ask the owner to close it through `onClose`, which also hears about a close the browser
 * makes on its own.
 */
export function Sheet({ open, title, onClose, detent = 'medium', children }: {
  open: boolean; title: string; onClose(): void; detent?: 'medium' | 'large'; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // A press that starts in the sheet and ends on the backdrop also clicks the dialog; only one that starts there dismisses.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return <dialog ref={dialog} className="ui-sheet" data-detent={detent} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={() => { if (open) onClose(); }}
    onPointerDown={event => { pressedBackdrop.current = event.target === event.currentTarget; }}
    onClick={event => {
      if (pressedBackdrop.current && event.target === event.currentTarget) onClose();
      pressedBackdrop.current = false;
    }}>
    <div className="ui-sheet-grabber" aria-hidden="true" />
    <header className="ui-sheet-header"><h2>{title}</h2><IconButton icon="close" label={`Close ${title}`} onClick={onClose} /></header>
    <div className="ui-sheet-body">{children}</div>
  </dialog>;
}
