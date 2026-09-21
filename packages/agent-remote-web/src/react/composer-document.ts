import type { MessagePart } from '@orchardworks/agent-remote-protocol';

export type DraftPart = { type: 'text'; text: string } | { type: 'image'; imageId: string; label: string };

export function normalizeDraftParts(parts: readonly DraftPart[]): DraftPart[] {
  const result: DraftPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (!part.text) continue;
      const last = result.at(-1);
      if (last?.type === 'text') last.text += part.text;
      else result.push({ ...part });
    } else result.push({ ...part });
  }
  return result;
}
export function draftText(parts: readonly DraftPart[]): string { return parts.map(part => part.type === 'text' ? part.text : '').join(''); }
export function draftHasContent(parts: readonly DraftPart[]): boolean { return parts.some(part => part.type === 'image' || part.text.trim().length > 0); }
export function snapshotContent(parts: readonly DraftPart[], attachments: Readonly<Record<string, { attachmentId: string } | undefined>>): MessagePart[] {
  return normalizeDraftParts(parts).map(part => {
    if (part.type === 'text') return { ...part };
    const attachment = attachments[part.imageId];
    if (!attachment) throw new Error(`${part.label} is not ready.`);
    return { type: 'image', attachmentId: attachment.attachmentId, label: part.label };
  });
}
