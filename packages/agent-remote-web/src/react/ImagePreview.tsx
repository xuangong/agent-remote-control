import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ImageViewport } from './ImageViewport.js';
import { FilePreviewContext } from './FilePreviewContext.js';
import type { ImageDismissMotion } from './useImageDismiss.js';

interface ImagePreviewProps {
  blob?: Blob;
  src?: string;
  label?: string;
  status?: string;
  error?: string;
  progress?: number;
  actions?: ReactNode;
  onClose(): void;
}

// Portal events must not change conversation focus, follow mode, or history loading.
function containPreviewEvent(event: SyntheticEvent): void { event.stopPropagation(); }

export function ImagePreview({ blob, src, label = 'Image', status, error, progress, actions, onClose }: ImagePreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scope = useContext(FilePreviewContext)?.scopeKey;
  const openedScope = useRef(scope);
  const scopeChanged = useRef(false);
  const [url, setUrl] = useState<string>();
  const showMotion = useCallback((motion: ImageDismissMotion) => {
    const element = dialog.current;
    if (!element) return;
    element.dataset.dismissPhase = motion.phase;
    element.style.setProperty('--image-backdrop-opacity', String(1 - motion.progress));
    element.style.setProperty('--image-controls-opacity', String(Math.max(0, 1 - motion.progress * 4)));
  }, []);
  useEffect(() => {
    const trigger = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => {
      modal.close();
      if (!scopeChanged.current && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    if (scope !== openedScope.current) { scopeChanged.current = true; onClose(); }
  }, [scope, onClose]);
  useEffect(() => {
    if (src || !blob) { setUrl(src); return; }
    const value = URL.createObjectURL(blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob, src]);
  function close(): void { dialog.current?.close(); onClose(); }
  return createPortal(<dialog ref={dialog} aria-label="Image preview" aria-description={label} className="agent-image-preview"
    onFocus={containPreviewEvent} onBlur={containPreviewEvent}
    onTouchStart={containPreviewEvent} onTouchMove={containPreviewEvent} onTouchEnd={containPreviewEvent} onTouchCancel={containPreviewEvent}
    onPointerDown={containPreviewEvent} onPointerMove={containPreviewEvent} onPointerUp={containPreviewEvent} onPointerCancel={containPreviewEvent}
    onWheel={containPreviewEvent} onDoubleClick={containPreviewEvent}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
      const first = targets[0]; const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }}>
    <div className="agent-image-preview-backdrop" aria-hidden="true" />
    <button type="button" className="agent-image-preview-close" onClick={close} aria-label="Close image preview">×</button>
    {url ? <ImageViewport key={url} src={url} label={label} onClose={close} onDismissMotion={showMotion} />
      : <div className="agent-image-preview-stage"><span>{blob || src ? 'Loading image…' : 'Local image unavailable. Replace it to continue.'}</span></div>}
    {status || error || actions ? <footer className="agent-image-preview-footer">
      <div className="agent-image-preview-status" data-error={Boolean(error)}>
        {status ? <span role="status">{status}</span> : null}
        {progress !== undefined ? <progress aria-label="Image upload progress" max={1} value={progress} /> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      {actions ? <div className="agent-image-preview-actions">{actions}</div> : null}
    </footer> : null}
  </dialog>, document.body);
}
