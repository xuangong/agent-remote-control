import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ImagePreviewProps {
  blob?: Blob;
  label?: string;
  status?: string;
  error?: string;
  progress?: number;
  actions?: ReactNode;
  onClose(): void;
}

export function ImagePreview({ blob, label = 'Image', status, error, progress, actions, onClose }: ImagePreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<string>();
  useEffect(() => {
    const trigger = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => {
      modal.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    setFailed(false); setDimensions(undefined);
    if (!blob) { setUrl(undefined); return; }
    const value = URL.createObjectURL(blob); setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  const size = blob ? blob.size >= 1024 * 1024 ? `${(blob.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB` : undefined;
  const format = blob?.type.split('/')[1]?.toUpperCase();
  function close(): void { dialog.current?.close(); onClose(); }
  return createPortal(<dialog ref={dialog} aria-label="Image preview" aria-describedby={heading} className="agent-image-preview"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }}>
    <header className="agent-image-preview-header">
      <div className="agent-image-preview-heading"><strong id={heading}>{label}</strong><span>{[format, size, dimensions].filter(Boolean).join(' · ')}</span></div>
      <button autoFocus type="button" className="agent-image-preview-close" onClick={close} aria-label="Close image preview">×</button>
    </header>
    <div className="agent-image-preview-stage">
      {url && !failed ? <img src={url} alt={label} onLoad={event => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setFailed(true)} />
        : <span>{failed ? 'This image cannot be previewed.' : blob ? 'Loading image…' : 'Local image unavailable. Replace it to continue.'}</span>}
    </div>
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
