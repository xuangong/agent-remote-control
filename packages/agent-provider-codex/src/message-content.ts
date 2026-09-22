import type { AgentInputPart } from '@orchardworks/agent-provider-sdk';
import { isRecord } from './native.js';

export type CodexInput = { type: 'text'; text: string; text_elements: Array<{
  byteRange: { start: number; end: number }; placeholder: string;
}> } | { type: 'localImage'; path: string };
export function codexMessageInput(parts: readonly AgentInputPart[]): CodexInput[] {
  if (!parts.some(part => part.type === 'image' || part.text.trim())) throw new Error('Codex message must not be empty.');
  let imageIndex = 0;
  return parts.flatMap<CodexInput>(part => {
    if (part.type === 'text') return [{ type: 'text', text: part.text, text_elements: [] }];
    const text = `[${part.label ?? `image #${imageIndex + 1}`}]`;
    imageIndex++;
    return [
      { type: 'text', text, text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(text) }, placeholder: text }] },
      { type: 'localImage', path: part.path },
    ];
  });
}

/** Only fold an explicitly marked placeholder paired with its adjacent image. */
export function codexImagePlaceholderLabel(entry: unknown, image: unknown): string | undefined {
  if (!isRecord(entry) || entry.type !== 'text' || typeof entry.text !== 'string'
    || !isRecord(image) || !['localImage', 'image'].includes(String(image.type))
    || !Array.isArray(entry.text_elements) || entry.text_elements.length !== 1) return undefined;
  const element = entry.text_elements[0];
  if (!isRecord(element) || !isRecord(element.byteRange) || element.byteRange.start !== 0
    || element.byteRange.end !== Buffer.byteLength(entry.text) || element.placeholder !== entry.text
    || !entry.text.startsWith('[') || !entry.text.endsWith(']') || entry.text.length <= 2) return undefined;
  return entry.text.slice(1, -1);
}
