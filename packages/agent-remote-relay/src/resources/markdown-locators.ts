import { posix } from 'node:path';

import type { AgentTimelineItem } from '@orchardworks/agent-provider-sdk';

export interface MarkdownLocator {
  locator: string;
  normalizedLocator: string;
}

const FORBIDDEN_SCHEMES = new Set([
  'data',
  'file',
  'ftp',
  'ftps',
  'http',
  'https',
  'javascript',
  'ws',
  'wss',
]);

export function discoverMarkdownLocators(markdown: string): MarkdownLocator[] {
  const discovered: MarkdownLocator[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < markdown.length; offset += 1) {
    if (markdown[offset] !== ']' || markdown[offset + 1] !== '(' || isEscaped(markdown, offset)) continue;
    const parsed = readDestination(markdown, offset + 2);
    if (!parsed) continue;
    offset = parsed.end;
    const normalizedLocator = normalizeFileLocator(parsed.locator);
    if (!normalizedLocator || seen.has(normalizedLocator)) continue;
    seen.add(normalizedLocator);
    discovered.push({ locator: parsed.locator, normalizedLocator });
  }
  return discovered;
}

export function discoverTimelineLocators(item: AgentTimelineItem): MarkdownLocator[] {
  if (item.type === 'user_message') return (item.content ?? []).flatMap(part => {
    if (part.type !== 'image') return [];
    const normalizedLocator = normalizeFileLocator(part.locator);
    return normalizedLocator ? [{ locator: part.locator, normalizedLocator }] : [];
  });
  if (item.type === 'assistant_message') return discoverMarkdownLocators(item.text);
  if (item.type !== 'tool_call' || item.status !== 'completed') return [];
  if (item.detail.type === 'write' || item.detail.type === 'edit') {
    const normalizedLocator = normalizeFileLocator(item.detail.filePath);
    return normalizedLocator ? [{ locator: item.detail.filePath, normalizedLocator }] : [];
  }
  if (item.detail.type === 'other') return discoverMarkdownLocators(item.detail.description);
  return [];
}

export function normalizeFileLocator(locator: string): string | undefined {
  const trimmed = locator.trim();
  if (
    !trimmed
    || trimmed.includes('\0')
    || trimmed.includes('\\')
    || trimmed.startsWith('//')
    || trimmed.startsWith('#')
    || posix.isAbsolute(trimmed)
  ) return undefined;

  const schemeMatch = /^([a-z][a-z\d+.-]*):(.*)$/i.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1]?.toLowerCase();
    const opaque = schemeMatch[2];
    if (!scheme || !opaque || FORBIDDEN_SCHEMES.has(scheme) || opaque.startsWith('//') || opaque.startsWith('/')) {
      return undefined;
    }
    if (hasTraversalSegment(opaque)) return undefined;
    return `${scheme}:${opaque}`;
  }

  if (hasTraversalSegment(trimmed)) return undefined;
  const normalized = posix.normalize(trimmed);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function hasTraversalSegment(locator: string): boolean {
  return locator.split('/').some((segment) => segment === '..');
}

function readDestination(markdown: string, start: number): { locator: string; end: number } | undefined {
  let cursor = start;
  while (/\s/.test(markdown[cursor] ?? '')) cursor += 1;
  if (markdown[cursor] === '<') {
    const end = markdown.indexOf('>', cursor + 1);
    if (end === -1) return undefined;
    const closing = markdown.indexOf(')', end + 1);
    if (closing === -1) return undefined;
    return { locator: markdown.slice(cursor + 1, end), end: closing };
  }

  const destinationStart = cursor;
  let depth = 0;
  while (cursor < markdown.length) {
    const character = markdown[cursor] as string;
    if (character === '\n' || character === '\r') return undefined;
    if (character === '(' && !isEscaped(markdown, cursor)) depth += 1;
    if (character === ')' && !isEscaped(markdown, cursor)) {
      if (depth === 0) break;
      depth -= 1;
    }
    if (/\s/.test(character) && depth === 0) break;
    cursor += 1;
  }
  if (cursor === destinationStart) return undefined;
  const locator = markdown.slice(destinationStart, cursor);
  while (cursor < markdown.length && markdown[cursor] !== ')') cursor += 1;
  return markdown[cursor] === ')' ? { locator, end: cursor } : undefined;
}

function isEscaped(value: string, offset: number): boolean {
  let slashCount = 0;
  for (let index = offset - 1; index >= 0 && value[index] === '\\'; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}
