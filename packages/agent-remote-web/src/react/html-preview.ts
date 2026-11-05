import { isLocalLocator } from './markdown-resources.js';
import { canPreviewImage } from './ResourceCard.js';

export interface HtmlPreviewResource { readonly mediaType: string; readonly contentBase64: string }

/** Local images and stylesheets one preview inlines; more stay unresolved. */
const RESOURCE_LIMIT = 64;
/** A preview renders with the resources loaded by then. */
const RESOURCE_DEADLINE_MS = 15_000;
/**
 * The rendered document reaches no network: Host files are inlined as data, as Markdown previews load them, and
 * remote resources stay blocked as remote Markdown images do. The frame's sandbox runs no scripts.
 */
const DOCUMENT_POLICY = "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'";

/**
 * A self-contained copy of an HTML file for a sandboxed frame: local images and stylesheets are read from the Host
 * relative to the file, external links open a new tab, and local links, which only the conversation can open,
 * become plain text.
 */
export async function renderHtmlPreview(html: string, load: (locator: string) => Promise<HtmlPreviewResource | undefined>,
  deadlineMs = RESOURCE_DEADLINE_MS): Promise<string> {
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const element of Array.from(document.querySelectorAll('script, base, meta[http-equiv]'))) {
    if (element.localName !== 'meta' || element.getAttribute('http-equiv')!.trim().toLowerCase() === 'refresh') element.remove();
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = DOCUMENT_POLICY;
  document.head.prepend(policy);
  for (const link of Array.from(document.querySelectorAll('a[href], area[href]'))) {
    const href = link.getAttribute('href')!.trim();
    if (href.startsWith('#')) continue;
    if (/^(?:https?|mailto):/i.test(href)) { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer'); continue; }
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(jobs), new Promise(resolve => { timer = setTimeout(resolve, deadlineMs); })]);
  clearTimeout(timer);
  settled = true;
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function decodeText(base64: string): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), character => character.charCodeAt(0))); }
  catch { return undefined; }
}
