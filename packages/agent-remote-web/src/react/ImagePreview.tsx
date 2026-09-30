import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ImageViewport } from './ImageViewport.js';
import { FilePreviewContext } from './FilePreviewContext.js';

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
  const heading = useId();
  const scope = useContext(FilePreviewContext)?.scopeKey;
  const openedScope = useRef(scope);
  const scopeChanged = useRef(false);
  const [url, setUrl] = useState<string>();
  const [dimensions, setDimensions] = useState<string>();
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
    setDimensions(undefined);
    if (src || !blob) { setUrl(src); return; }
    const value = URL.createObjectURL(blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob, src]);
  const size = blob ? blob.size >= 1024 * 1024 ? `${(blob.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB` : undefined;
  const format = blob?.type.split('/')[1]?.toUpperCase();
  function close(): void { dialog.current?.close(); onClose(); }
  return createPortal(<dialog ref={dialog} aria-label="Image preview" aria-describedby={heading} className="agent-image-preview"
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
    <header className="agent-image-preview-header">
      <div className="agent-image-preview-heading"><strong id={heading}>{label}</strong><span>{[format, size, dimensions].filter(Boolean).join(' · ')}</span></div>
      <button type="button" className="agent-image-preview-close" onClick={close} aria-label="Close image preview">×</button>
    </header>
    {url ? <ImageViewport key={url} src={url} label={label} onDimensions={setDimensions} />
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
