import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

/**
 * Digest of an item's content: equal for an item built from live deltas and the same item read again from native
 * history. Background outcomes merge in later and are left out.
 */
export async function itemDigest(item: AgentTimelineItem): Promise<string> {
  const { background: _background, ...content } = item;
  const bytes = new TextEncoder().encode(canonicalJson(content));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
}
