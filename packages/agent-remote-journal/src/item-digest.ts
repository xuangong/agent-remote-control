import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

/**
 * Digest of an item's content: equal for an item built from live deltas and the same item read again from native
 * history. Background outcomes merge in later and the client message id is written by the journal, so both are left
 * out.
 */
export async function itemDigest(item: AgentTimelineItem): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalContent(item));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The canonical JSON of an item's content: the text an item digest is taken of, without the background and the client message id. */
export function canonicalContent(item: AgentTimelineItem): string {
  const { background: _background, clientMessageId: _clientMessageId, ...content } = item as AgentTimelineItem & { clientMessageId?: string };
  return canonicalJson(content);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
}
