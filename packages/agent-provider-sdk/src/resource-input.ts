import type { AgentInputPart, AgentUserMessagePart } from './image-input.js';
const prefix = '<agent-resource>';
const suffix = '</agent-resource>';
/** A local file reference for runtimes without generic native file input. Receiving it never executes the file. */
export function resourceInputText(part: Extract<AgentInputPart, {type:'resource'}>): string {
  return `${prefix}${JSON.stringify({ locator: `input-resource:${part.resourceId}`, path: part.path, name: part.name, mediaType: part.mediaType, byteLength: part.byteLength, sha256: part.sha256, label: part.label })}${suffix}`;
}
export function parseResourceInputText(text: string): Extract<AgentUserMessagePart, {type:'resource'}> | undefined {
  if (!text.startsWith(prefix) || !text.endsWith(suffix) || text.length > 16384) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length, -suffix.length));
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    if (typeof item.locator !== 'string' || !/^input-resource:[a-zA-Z0-9-]{1,256}$/.test(item.locator)
      || typeof item.name !== 'string' || typeof item.mediaType !== 'string' || typeof item.label !== 'string'
      || typeof item.byteLength !== 'number' || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return undefined;
    return { type: 'resource', locator: item.locator, name: item.name, mediaType: item.mediaType, label: item.label, byteLength: item.byteLength, sha256: item.sha256 };
  } catch { return undefined; }
}
/** Preserve ordinary text surrounding resource references when a native runtime merges text blocks. */
export function projectResourceInputText(text: string): AgentUserMessagePart[] {
  const parts: AgentUserMessagePart[] = [];
  let offset = 0;
  for (const match of text.matchAll(/<agent-resource>[^\n]*?<\/agent-resource>/g)) {
    const part = parseResourceInputText(match[0]);
    if (!part) continue;
    if (match.index > offset) parts.push({ type:'text', text:text.slice(offset, match.index) });
    parts.push(part); offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({type:'text',text:text.slice(offset)});
  return parts;
}
