import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';

const MAX_ADAPTED_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class PreviewContentError extends Error {
  override readonly name = 'PreviewContentError';
}

export interface PreviewContentRoute {
  readonly id: string;
  readonly target: string;
  readonly pathMode: 'strip' | 'preserve';
}

export interface PreviewContentInput {
  readonly body: ReadableStream<Uint8Array> | undefined;
  readonly headers: Headers;
  readonly route: PreviewContentRoute;
  readonly requestPath: string;
  readonly status: number;
}

export interface AdaptedPreviewContent {
  readonly body?: ReadableStream<Uint8Array>;
  readonly headers: Headers;
}

export async function adaptPreviewContent(input: PreviewContentInput): Promise<AdaptedPreviewContent> {
  const contentType = input.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!input.body || input.status === 206 || input.headers.has('content-range') || input.route.pathMode === 'preserve'
    || (contentType !== 'text/html' && contentType !== 'text/css')) {
    return { body: input.body, headers: input.headers };
  }
  assertUtf8(input.headers);
  const encoding = input.headers.get('content-encoding')?.trim().toLowerCase();
  const declaredLength = Number(input.headers.get('content-length'));
  if ((!encoding || encoding === 'identity') && Number.isFinite(declaredLength) && declaredLength > MAX_ADAPTED_BYTES) {
    await input.body.cancel('Preview content adaptation limit exceeded.');
    throw adaptationLimitError();
  }
  let decodedBody = input.body;
  if (encoding && encoding !== 'identity') {
    if (encoding !== 'gzip') throw new PreviewContentError(`Unsupported preview content encoding "${encoding}". Configure the upstream to serve identity or gzip for adaptable HTML and CSS.`);
    const decompressor = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
    decodedBody = decodedBody.pipeThrough(decompressor);
  }

  let bytes: Uint8Array;
  try { bytes = await readBounded(decodedBody); }
  catch (error) {
    if (error instanceof Error && error.message.includes('1 MiB adaptation limit')) throw error;
    if (encoding === 'gzip') throw new PreviewContentError('Gzip preview content could not be decompressed. Configure the upstream to serve a valid gzip representation or use preserve path mode.');
    throw error;
  }
  let source: string;
  try { source = decoder.decode(bytes); }
  catch { throw new PreviewContentError('Preview HTML and CSS adaptation requires valid UTF-8 content. Configure the application to serve UTF-8 or use preserve path mode.'); }
  const output = contentType === 'text/html'
    ? rewriteHtml(source, input.route)
    : rewriteCss(source, input.route);
  const headers = transformedHeaders(input.headers);
  return { body: byteStream(encoder.encode(output)), headers };
}

async function readBounded(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_ADAPTED_BYTES) {
        await reader.cancel('Preview content adaptation limit exceeded.');
        throw adaptationLimitError();
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function adaptationLimitError(): PreviewContentError {
  return new PreviewContentError('Preview HTML or CSS exceeds the 1 MiB adaptation limit. Configure the application with the preview base and use preserve path mode.');
}

function transformedHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('content-md5');
  headers.delete('digest');
  headers.delete('content-digest');
  headers.delete('repr-digest');
  const etag = headers.get('etag');
  if (etag && !/^W\//i.test(etag)) headers.delete('etag');
  return headers;
}

function assertUtf8(headers: Headers): void {
  const charset = headers.get('content-type')?.match(/;\s*charset\s*=\s*["']?([^;"']+)/i)?.[1]?.trim().toLowerCase();
  if (charset && charset !== 'utf-8' && charset !== 'utf8' && charset !== 'us-ascii') {
    throw new PreviewContentError(`Unsupported preview text charset "${charset}". Configure UTF-8 output or use preserve path mode.`);
  }
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];

function rewriteHtml(source: string, route: PreviewContentRoute): string {
  const document = parse(source);
  visit(document, route);
  return serialize(document);
}

function visit(node: HtmlNode, route: PreviewContentRoute): void {
  if (isElement(node)) rewriteElement(node, route);
  const children = 'childNodes' in node ? node.childNodes : undefined;
  children?.forEach(child => visit(child, route));
}

function rewriteElement(element: HtmlElement, route: PreviewContentRoute): void {
  let stylesheetChanged = false;
  for (const attribute of element.attrs) {
    if (attribute.name === 'srcset') {
      attribute.value = rewriteSrcset(attribute.value, route);
      continue;
    }
    if (attribute.name === 'style') {
      attribute.value = rewriteInlineStyle(attribute.value, route);
      continue;
    }
    if (!['src', 'href', 'action', 'poster'].includes(attribute.name)) continue;
    const rewritten = rewriteReference(attribute.value, route);
    stylesheetChanged ||= attribute.name === 'href' && rewritten !== attribute.value && isStylesheet(element);
    attribute.value = rewritten;
  }
  if (stylesheetChanged) element.attrs = element.attrs.filter(attribute => attribute.name !== 'integrity');
  if (element.tagName === 'style') {
    for (const child of element.childNodes) {
      if (child.nodeName === '#text' && 'value' in child) child.value = rewriteCss(child.value, route);
    }
  }
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && 'attrs' in node;
}

function isStylesheet(element: HtmlElement): boolean {
  return element.tagName === 'link' && element.attrs.some(attribute => attribute.name === 'rel'
    && attribute.value.split(/\s+/).some(value => value.toLowerCase() === 'stylesheet'));
}

function rewriteSrcset(source: string, route: PreviewContentRoute): string {
  return source.split(/,(?=\s*(?:(?:https?:)?\/\/|\/|\.))/i).map(candidate => {
    const match = candidate.match(/^(\s*)(\S+)(.*)$/s);
    return match ? `${match[1]}${rewriteReference(match[2]!, route)}${match[3]}` : candidate;
  }).join(',');
}

function rewriteInlineStyle(source: string, route: PreviewContentRoute): string {
  const root = postcss.parse(`a{${source}}`);
  root.walkDecls(declaration => { declaration.value = rewriteCssValue(declaration.value, route); });
  const rule = root.first;
  return rule && 'nodes' in rule ? rule.nodes?.map(node => node.toString()).join(';') ?? source : source;
}

function rewriteCss(source: string, route: PreviewContentRoute): string {
  const root = postcss.parse(source);
  root.walkDecls(declaration => { declaration.value = rewriteCssValue(declaration.value, route); });
  root.walkAtRules('import', rule => { rule.params = rewriteImport(rule.params, route); });
  return root.toString();
}

function rewriteCssValue(source: string, route: PreviewContentRoute): string {
  let output = '';
  let cursor = 0;
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === '"' || character === "'") { index = skipQuoted(source, index, character); continue; }
    if (character === '/' && source[index + 1] === '*') { index = skipComment(source, index); continue; }
    const prefix = source.slice(index, index + 3);
    const previous = source[index - 1];
    if (prefix.toLowerCase() !== 'url' || (previous && /[\w-]/.test(previous))) { index += 1; continue; }
    let opening = index + 3;
    while (/\s/.test(source[opening] ?? '')) opening += 1;
    if (source[opening] !== '(') { index += 1; continue; }
    const closing = findFunctionEnd(source, opening + 1);
    if (closing < 0) break;
    const inner = source.slice(opening + 1, closing);
    const match = inner.match(/^(\s*)(?:(['"])([\s\S]*)\2|([^'"][\s\S]*?))(\s*)$/);
    if (!match) { index = closing + 1; continue; }
    const quote = match[2] ?? '';
    const value = match[3] ?? match[4] ?? '';
    output += source.slice(cursor, opening + 1);
    output += `${match[1]}${quote}${rewriteReference(value.trim(), route)}${quote}${match[5]}`;
    output += ')';
    cursor = closing + 1;
    index = cursor;
  }
  return output + source.slice(cursor);
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function skipComment(source: string, start: number): number {
  const end = source.indexOf('*/', start + 2);
  return end < 0 ? source.length : end + 2;
}

function findFunctionEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"' || character === "'") { index = skipQuoted(source, index, character) - 1; continue; }
    if (character === '/' && source[index + 1] === '*') { index = skipComment(source, index) - 1; continue; }
    if (character === ')') return index;
  }
  return -1;
}

function rewriteImport(source: string, route: PreviewContentRoute): string {
  const viaUrl = rewriteCssValue(source, route);
  if (viaUrl !== source) return viaUrl;
  return source.replace(/^(\s*)(['"])(.*?)\2/, (_whole, spacing: string, quote: string, value: string) => `${spacing}${quote}${rewriteReference(value, route)}${quote}`);
}

function rewriteReference(source: string, route: PreviewContentRoute): string {
  const value = source.trim();
  if (!value || value.startsWith('#') || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return source;
  const target = new URL(route.target);
  const prefix = `/p/${encodeURIComponent(route.id)}`;
  if (value.startsWith('/') && !value.startsWith('//')) return value === prefix || value.startsWith(`${prefix}/`) ? source : `${prefix}${value}`;
  let absolute: URL;
  try { absolute = new URL(value, target); } catch { return source; }
  const explicitlyAbsolute = /^(?:https?:)?\/\//i.test(value);
  if (!explicitlyAbsolute || absolute.origin !== target.origin) return source;
  return `${prefix}${absolute.pathname}${absolute.search}${absolute.hash}`;
}
