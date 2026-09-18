import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FilePreviewRequest } from './FilePreviewContext.js';
import { loadLocalResource } from './local-resource.js';
import { canPreviewImage } from './ResourceCard.js';
import { MarkdownImageFrame } from './MarkdownImageFrame.js';
import { usePreviewVisibility } from './usePreviewVisibility.js';

const ReadOnlyCode = lazy(() => import('./ReadOnlyCode.js'));
type Loaded = Awaited<ReturnType<typeof loadLocalResource>>;
const textTypes = new Set(['text/plain', 'text/markdown', 'text/html', 'application/json', 'image/svg+xml']);

export function FilePreview({ request, onClose }: { readonly request: FilePreviewRequest; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [attempt, retry] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [result, setResult] = useState<Loaded>();
  const [failure, setFailure] = useState<string>();
  const [loading, setLoading] = useState(true);
  const target = fileTarget(request.locator);
  const filename = displayFilename(target.locator);
  usePreviewVisibility(dialog, true, `file:${request.context.scopeKey}:${request.locator}`);

  useEffect(() => {
    const trigger = request.returnFocus;
    return () => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true); setFailure(undefined); setResult(undefined);
    const deadline = window.setTimeout(() => {
      current = false; setLoading(false); setFailure('The file request timed out. Check the Host connection and retry.');
    }, 20_000);
    void loadLocalResource(request.context, target.locator, request.sourceLocator, undefined, attempt > 0).then(value => {
      if (current) { setResult(value); setLoading(false); window.clearTimeout(deadline); }
    }).catch(error => {
      if (current) { setFailure(error instanceof Error ? error.message : 'The file could not be loaded.'); setLoading(false); window.clearTimeout(deadline); }
    });
    return () => { current = false; window.clearTimeout(deadline); };
  }, [request, target.locator, attempt]);

  const detail = result?.detail;
  const available = detail?.status === 'available' && 'contentBase64' in detail ? detail : undefined;
  const isImage = available && canPreviewImage(available.mediaType);
  let text: string | undefined;
  let error = failure ?? (detail?.status === 'unavailable' ? detail.reason : detail?.status === 'failed' ? detail.message
    : !loading && !available ? 'This file is unavailable. Check the path and Host connection, then retry.' : undefined);
  if (available && !isImage) {
    try {
      if (!textTypes.has(available.mediaType)) throw new Error('This file type cannot be previewed.');
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(available.contentBase64), character => character.charCodeAt(0)));
      if (text.includes('\0')) throw new Error('Binary files cannot be previewed as text.');
    } catch (cause) { error = cause instanceof Error ? cause.message : 'This file is not readable UTF-8 text.'; }
  }
  return <dialog ref={dialog} className="agent-preview-browser agent-file-preview" aria-label="File preview" tabIndex={-1} autoFocus
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <div className="agent-preview-browser-layout">
      <header className="agent-preview-browser-toolbar">
        <div className="agent-file-heading"><strong>{filename}</strong><small title={request.locator}>{request.locator}</small></div>
        {text !== undefined ? <button type="button" aria-label="Wrap lines" title="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>↵</button> : null}
        <button type="button" aria-label="Refresh file" title="Read file again" disabled={loading} onClick={() => retry(value => value + 1)}>↻</button>
        <button type="button" aria-label="Close file preview" title="Close file preview" onClick={onClose}>×</button>
      </header>
      <div className="agent-file-body" aria-busy={loading}>
        {loading ? <p className="agent-file-message" role="status">Loading file…</p>
          : error ? <div className="agent-file-message" role="alert"><p>{error}</p><button type="button" onClick={() => retry(value => value + 1)}>Retry</button></div>
          : available && isImage ? <div className="agent-file-image"><MarkdownImageFrame src={`data:${available.mediaType};base64,${available.contentBase64}`} alt={filename} dimensions={available.imageDimensions} /></div>
          : text !== undefined ? <Suspense fallback={<p role="status" className="agent-file-message">Opening source…</p>}><ReadOnlyCode text={text} filename={filename} wrap={wrap} line={target.line} /></Suspense> : null}
      </div>
      <footer className="agent-file-footer"><span>Read only</span><span>{available ? `${available.byteLength.toLocaleString()} bytes` : 'Local resource'}</span></footer>
    </div>
  </dialog>;
}

function fileTarget(locator: string): { locator: string; line?: number } {
  const hash = locator.indexOf('#');
  const fragment = hash >= 0 ? locator.slice(hash + 1) : '';
  const path = hash >= 0 ? locator.slice(0, hash) : locator;
  const suffix = /:(\d+)(?::\d+)?$/.exec(path);
  const line = /^(?:L)?(\d+)(?:[-:].*)?$/.exec(fragment)?.[1] ?? suffix?.[1];
  return { locator: suffix ? path.slice(0, suffix.index) : path, ...(line ? { line: Number(line) } : {}) };
}

function displayFilename(locator: string): string {
  const name = locator.split('/').at(-1) || locator;
  try { return decodeURIComponent(name); } catch { return name; }
}
