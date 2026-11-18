import { FILE_CONTENT_POLICY, FILE_FRAME_MESSAGE } from '@orchardworks/agent-remote-protocol';
import { isLocalLocator } from './markdown-resources.js';
import { canPreviewImage } from './ResourceCard.js';

export interface HtmlPreviewResource { readonly mediaType: string; readonly contentBase64: string }
export interface HtmlPreviewOptions {
  /** Keep the file's scripts, for the file frame; without them the copy is static. */
  readonly scripts: boolean;
  readonly deadlineMs?: number;
}

/** Local images, stylesheets and scripts one preview inlines; more stay unresolved. */
const RESOURCE_LIMIT = 64;
/** A preview renders with the resources loaded by then. */
const RESOURCE_DEADLINE_MS = 15_000;
/** The attribute that marks a local link, which the frame asks the website to open in the file preview. */
const FILE_LINK_ATTRIBUTE = 'data-agent-file-link';
const linkOpener = `document.addEventListener('click', function (event) {
  var link = event.target instanceof Element && event.target.closest('[${FILE_LINK_ATTRIBUTE}]');
  if (!link) return;
  event.preventDefault();
  parent.postMessage({ type: '${FILE_FRAME_MESSAGE}', open: link.getAttribute('${FILE_LINK_ATTRIBUTE}') }, '*');
}, true);`;

/**
 * A self-contained copy of an HTML file: local images, stylesheets and scripts are read from the Host relative to the
 * file and inlined, external links open a new tab, and the copy carries the file content policy.
 *
 * With scripts the copy runs in the file frame, where local links open in the file preview. A static copy has no
 * scripts, so its local links, which only the conversation can open, become plain text.
 */
export async function renderHtmlPreview(html: string, load: (locator: string) => Promise<HtmlPreviewResource | undefined>,
  options: HtmlPreviewOptions): Promise<string> {
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const element of Array.from(document.querySelectorAll('script, base, meta[http-equiv]'))) {
    if (element.localName === 'script' ? !options.scripts : element.localName === 'base'
      || element.getAttribute('http-equiv')!.trim().toLowerCase() === 'refresh') element.remove();
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = FILE_CONTENT_POLICY;
  if (options.scripts) {
    const opener = document.createElement('script');
    opener.textContent = linkOpener;
    document.head.prepend(opener);
  }
  document.head.prepend(policy);
  for (const link of Array.from(document.querySelectorAll('a[href], area[href]'))) {
    const href = link.getAttribute('href')!.trim();
    if (href.startsWith('#')) continue;
    if (/^(?:https?|mailto):/i.test(href)) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); continue; }
    if (options.scripts && /^javascript:/i.test(href)) continue;
    if (options.scripts && isLocalLocator(href)) { link.setAttribute(FILE_LINK_ATTRIBUTE, href); continue; }
    link.removeAttribute('href');
    if (isLocalLocator(href) && !link.hasAttribute('title')) link.setAttribute('title', `Local file: ${href}`);
  }
  const jobs: Promise<void>[] = [];
  let settled = false;
  const inline = (locator: string, apply: (resource: HtmlPreviewResource | undefined) => void) => {
    if (jobs.length >= RESOURCE_LIMIT) return;
    jobs.push(load(locator).catch(() => undefined).then(resource => { if (!settled) apply(resource); }));
  };
  for (const image of Array.from(document.querySelectorAll('img[src]'))) {
    const locator = image.getAttribute('src')!.trim();
    if (!isLocalLocator(locator)) continue;
    image.removeAttribute('src'); image.removeAttribute('srcset');
    inline(locator, resource => {
      if (resource && canPreviewImage(resource.mediaType)) image.setAttribute('src', `data:${resource.mediaType};base64,${resource.contentBase64}`);
    });
  }
  for (const link of Array.from(document.querySelectorAll('link[href]'))) {
    const locator = link.getAttribute('href')!.trim();
    if (!isLocalLocator(locator)) continue;
    if (!/(?:^|\s)stylesheet(?:\s|$)/i.test(link.getAttribute('rel') ?? '')) { link.remove(); continue; }
    const style = document.createElement('style');
    const media = link.getAttribute('media');
    if (media) style.setAttribute('media', media);
    link.replaceWith(style);
    // The Host names text by its content, so a stylesheet arrives as plain text.
    inline(locator, resource => {
      if (resource?.mediaType.startsWith('text/')) style.textContent = decodeText(resource.contentBase64) ?? '';
    });
  }
  // A data URL keeps a script's type, defer and async; relative imports of a module cannot resolve from it.
  for (const script of Array.from(document.querySelectorAll('script[src]'))) {
    const locator = script.getAttribute('src')!.trim();
    if (!isLocalLocator(locator)) continue;
    script.removeAttribute('src');
    inline(locator, resource => {
      if (resource?.mediaType.startsWith('text/')) script.setAttribute('src', `data:text/javascript;base64,${resource.contentBase64}`);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(jobs), new Promise(resolve => { timer = setTimeout(resolve, options.deadlineMs ?? RESOURCE_DEADLINE_MS); })]);
  clearTimeout(timer);
  settled = true;
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function decodeText(base64: string): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), character => character.charCodeAt(0))); }
  catch { return undefined; }
}
