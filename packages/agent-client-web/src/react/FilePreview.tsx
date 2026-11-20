import { lazy, Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FILE_FRAME_MESSAGE, FILE_FRAME_PATH, FILE_FRAME_SANDBOX } from '@orchardworks/agent-remote-protocol';
import { FilePreviewContext, type FilePreviewRequest } from './FilePreviewContext.js';
import { createFilePreviewResourceContext } from './file-preview-resources.js';
import { loadLocalResource } from './local-resource.js';
import { errorWords } from './localized-error.js';
import { MarkdownContent } from './MarkdownContent.js';
import { canPreviewImage } from './ResourceCard.js';
import { ImagePreview } from './ImagePreview.js';
import { renderHtmlPreview } from './html-preview.js';
import type { MarkdownResourceContext } from './local-resource.js';
import { usePreviewVisibility } from './usePreviewVisibility.js';
import { useTranslate } from './locale.js';

const ReadOnlyCode = lazy(() => import('./ReadOnlyCode.js'));
type Loaded = Awaited<ReturnType<typeof loadLocalResource>>;
const textTypes = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/json', 'image/svg+xml']);

export function FilePreview({ request, onClose }: { readonly request: FilePreviewRequest; readonly onClose: () => void }) {
  const t = useTranslate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [attempt, retry] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [mode, setMode] = useState<{ request: FilePreviewRequest; source: boolean }>();
  const [result, setResult] = useState<{ request: FilePreviewRequest; value: Loaded }>();
  const [failure, setFailure] = useState<string>();
  const [loading, setLoading] = useState(true);
  const target = fileTarget(request.locator);
  const filename = displayFilename(target.locator);
  const previewId = useId();
  const resourceContext = useMemo(() => createFilePreviewResourceContext(request.context, target.locator, request.sourceLocator,
    `${request.context.scopeKey}:file-preview:${previewId}`), [request.context, target.locator, request.sourceLocator, previewId]);

  useEffect(() => {
    const trigger = request.returnFocus;
    return () => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true); setFailure(undefined); setResult(undefined);
    const deadline = window.setTimeout(() => {
      current = false; setLoading(false); setFailure(t('timeline.file.timedOut'));
    }, 20_000);
    void loadLocalResource(request.context, target.locator, request.sourceLocator, undefined, attempt > 0).then(value => {
      if (current) { setResult({ request, value }); setLoading(false); window.clearTimeout(deadline); }
    }).catch(error => {
      if (current) { setFailure(errorWords(error, t, 'timeline.file.loadFailed')); setLoading(false); window.clearTimeout(deadline); }
    });
    return () => { current = false; window.clearTimeout(deadline); };
  }, [request, target.locator, attempt, t]);

  const detail = result?.request === request ? result.value.detail : undefined;
  const available = detail?.status === 'available' && 'contentBase64' in detail && typeof detail.contentBase64 === 'string'
    ? { ...detail, contentBase64: detail.contentBase64 } : undefined;
  const isImage = available && canPreviewImage(available.mediaType);
  const mediaType = available?.mediaType.split(';', 1)[0]?.trim().toLowerCase();
  const isMarkdown = mediaType === 'text/markdown' || mediaType === 'text/x-markdown' || /\.(?:md|markdown)$/i.test(filename);
  const isHtml = !isMarkdown && (mediaType === 'text/html' || /\.html?$/i.test(filename));
  const format = isMarkdown ? 'Markdown' : isHtml ? 'HTML' : undefined;
  const source = mode?.request === request ? mode.source : target.line !== undefined;
  const renderedMarkdown = isMarkdown && !source;
  const renderedHtml = isHtml && !source;
  usePreviewVisibility(dialog, !isImage, `file:${request.context.scopeKey}:${request.locator}`);
  let text: string | undefined;
  let error = failure ?? (detail?.status === 'unavailable' ? detail.reason : detail?.status === 'failed' ? detail.message
    : !loading && !available ? t('timeline.file.unavailable') : undefined);
  if (available && !isImage) {
    try {
      if (!textTypes.has(mediaType!)) throw new Error(t('timeline.file.unsupported'));
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(available.contentBase64), character => character.charCodeAt(0)));
      if (text.includes('\0')) throw new Error(t('timeline.file.binary'));
    } catch (cause) { error = cause instanceof Error ? cause.message : t('timeline.file.notText'); }
  }
  if (available && isImage) return <ImagePreview src={`data:${available.mediaType};base64,${available.contentBase64}`} label={filename}
    status={`${t('timeline.resource.bytes', { count: available.byteLength.toLocaleString() })} · ${t('timeline.file.readOnly')}`} onClose={onClose}
    actions={<button type="button" aria-label={t('timeline.file.refresh')} title={t('timeline.file.readAgain')} disabled={loading} onClick={() => retry(value => value + 1)}>{t('timeline.file.refresh')}</button>} />;
  return <dialog ref={dialog} className="agent-preview-browser agent-file-preview" aria-label={t('timeline.file.preview')} tabIndex={-1} autoFocus
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <div className="agent-preview-browser-layout">
      <header className="agent-preview-browser-toolbar">
        <div className="agent-file-heading"><strong>{filename}</strong><small title={request.locator}>{request.locator}</small></div>
        {text !== undefined && format ? <button type="button" className="agent-file-mode" aria-label={t(source ? 'timeline.file.showRendered' : 'timeline.file.showSource', { format })}
          onClick={() => setMode({ request, source: !source })}>{t(source ? 'timeline.file.previewMode' : 'timeline.file.sourceMode')}</button> : null}
        {text !== undefined && !renderedMarkdown && !renderedHtml ? <button type="button" aria-label={t('timeline.file.wrap')} title={t('timeline.file.wrap')} aria-pressed={wrap} onClick={() => setWrap(value => !value)}>↵</button> : null}
        <button type="button" aria-label={t('timeline.file.refresh')} title={t('timeline.file.readAgain')} disabled={loading} onClick={() => retry(value => value + 1)}>↻</button>
        <button type="button" aria-label={t('timeline.file.close')} title={t('timeline.file.close')} onClick={onClose}>×</button>
      </header>
      <div className="agent-file-body" data-rendered-markdown={renderedMarkdown || undefined} data-rendered-html={renderedHtml || undefined} aria-busy={loading}>
        {loading ? <p className="agent-file-message" role="status">{t('timeline.file.loading')}</p>
          : error ? <div className="agent-file-message" role="alert"><p>{error}</p><button type="button" onClick={() => retry(value => value + 1)}>{t('common.retry')}</button></div>
          : text !== undefined ? renderedMarkdown
            ? <MarkdownContent markdown={text} className="agent-file-markdown" resourceContext={resourceContext} sourceLocator={target.locator} />
            : renderedHtml ? <HtmlFileContent key={attempt} html={text} title={t('timeline.file.renderedHtml', { filename })} resourceContext={resourceContext} sourceLocator={target.locator} fresh={attempt > 0} />
            : <Suspense fallback={<p role="status" className="agent-file-message">{t('timeline.file.openingSource')}</p>}><ReadOnlyCode text={text} filename={filename} wrap={wrap} line={target.line} /></Suspense> : null}
      </div>
      <footer className="agent-file-footer"><span>{t('timeline.file.readOnly')}</span><span>{available ? t('timeline.resource.bytes', { count: available.byteLength.toLocaleString() }) : t('timeline.file.localResource')}</span></footer>
    </div>
  </dialog>;
}

/** How long the file frame may take to load before the preview shows a static copy instead. */
const FILE_FRAME_LOAD_MS = 10_000;
/** After the file frame loads, how long its ready message may follow. A Relay without the frame never sends one. */
const FILE_FRAME_READY_MS = 1_000;

/**
 * Renders an HTML file as a browser would, scripts included, in the file frame: an opaque origin that reaches neither
 * the website nor its storage, and loads only its inlined local files and HTTPS resources. Where the website does not
 * serve the frame, a static copy without scripts is shown.
 */
function HtmlFileContent({ html, title, resourceContext, sourceLocator, fresh }: {
  readonly html: string; readonly title: string; readonly resourceContext: MarkdownResourceContext; readonly sourceLocator: string; readonly fresh: boolean;
}) {
  const t = useTranslate();
  const preview = useContext(FilePreviewContext);
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'static'>('loading');
  const [prepared, setPrepared] = useState<{ scripts: boolean; copy: string }>();
  const sent = useRef(false);
  const load = useCallback(async (locator: string) => {
    const { detail } = await loadLocalResource(resourceContext, locator, sourceLocator, undefined, fresh);
    return detail?.status === 'available' && 'contentBase64' in detail && typeof detail.contentBase64 === 'string'
      ? { mediaType: detail.mediaType, contentBase64: detail.contentBase64 } : undefined;
  }, [resourceContext, sourceLocator, fresh]);
  const scripts = phase !== 'static';
  useEffect(() => {
    let current = true;
    void renderHtmlPreview(html, load, { scripts }).then(copy => { if (current) setPrepared({ scripts, copy }); });
    return () => { current = false; };
  }, [html, load, scripts]);
  // Registered before the frame can answer, so its ready message is never missed.
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!frame.current || event.source !== frame.current.contentWindow || !data || typeof data !== 'object' || (data as { type?: unknown }).type !== FILE_FRAME_MESSAGE) return;
      const { state, open } = data as { state?: unknown; open?: unknown };
      if (state === 'ready') setPhase(value => value === 'loading' ? 'ready' : value);
      else if (typeof open === 'string' && open && open.length <= 4096) preview?.open({ locator: open, sourceLocator, context: resourceContext });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [preview, sourceLocator, resourceContext]);
  useEffect(() => {
    if (phase !== 'loading') return;
    const timer = window.setTimeout(() => setPhase(value => value === 'loading' ? 'static' : value), FILE_FRAME_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const copy = prepared?.scripts === scripts ? prepared.copy : undefined;
  useEffect(() => {
    if (phase !== 'ready' || !copy || sent.current) return;
    sent.current = true;
    frame.current?.contentWindow?.postMessage({ type: FILE_FRAME_MESSAGE, html: copy }, '*');
  }, [phase, copy]);
  if (phase === 'static') return copy === undefined ? <p className="agent-file-message" role="status">{t('timeline.file.renderingHtml')}</p>
    : <iframe className="agent-file-html" title={title} srcDoc={copy} referrerPolicy="no-referrer" sandbox="allow-popups allow-popups-to-escape-sandbox" />;
  return <>
    {phase === 'loading' || !copy ? <p className="agent-file-message" role="status">{t('timeline.file.renderingHtml')}</p> : null}
    <iframe ref={frame} className="agent-file-html" title={title} src={FILE_FRAME_PATH} referrerPolicy="no-referrer" hidden={phase === 'loading' || !copy}
      sandbox={FILE_FRAME_SANDBOX} onLoad={() => {
        window.setTimeout(() => setPhase(value => value === 'loading' ? 'static' : value), FILE_FRAME_READY_MS);
      }} />
  </>;
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
  const name = locator.split(/[\\/]/).at(-1) || locator;
  try { return decodeURIComponent(name); } catch { return name; }
}
