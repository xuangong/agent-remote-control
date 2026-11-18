import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

import { timelineEntryKey } from './timeline-entry-key.js';

/**
 * Absorbing an item window: the replica's side of the window decision. A Relay journal replaced by a new epoch sends its
 * newest window as the tail of that epoch. The replica takes it without an empty state in between, by item key:
 * - a held row whose key and content are in the window stays as it is, the same object, and only its sequences change;
 * - a row the window lacks leaves, including rows older than the window, which `loadOlder` reads again;
 * - a new row is placed in the window's order;
 * - a key repeated in the window counts once, at its first place.
 * Pure: it reads its arguments and returns entries, and holds no state.
 */
export function absorbWindow(
  held: readonly ProjectedTimelineEntry[],
  offered: readonly ProjectedTimelineEntry[],
): ProjectedTimelineEntry[] {
  const heldByKey = new Map(held.map((entry) => [timelineEntryKey(entry), entry]));
  const seen = new Set<string>();
  return offered.flatMap((incoming) => {
    const key = timelineEntryKey(incoming);
    if (seen.has(key)) return [];
    seen.add(key);
    return [absorbEntry(heldByKey.get(key), incoming)];
  });
}

/** A held row an `after` page updates: its content and last sequence change, its first sequence and so its place do not. */
export function updateInPlace(held: ProjectedTimelineEntry, incoming: ProjectedTimelineEntry): ProjectedTimelineEntry {
  const moved = { ...incoming, seqStart: held.seqStart };
  return absorbEntry(held, moved);
}

/** The entry a window brings for a key the replica may hold: the held one when its content is equal, the window's otherwise. */
export function absorbEntry(held: ProjectedTimelineEntry | undefined, incoming: ProjectedTimelineEntry): ProjectedTimelineEntry {
  if (!held || !sameContent(held, incoming)) return structuredClone(incoming);
  if (held.seqStart === incoming.seqStart && held.seqEnd === incoming.seqEnd && JSON.stringify(held.sourceSeqRanges) === JSON.stringify(incoming.sourceSeqRanges)) return held;
  return { ...held, seqStart: incoming.seqStart, seqEnd: incoming.seqEnd, sourceSeqRanges: structuredClone(incoming.sourceSeqRanges) };
}

const contentOf = new WeakMap<ProjectedTimelineEntry, string>();

/** Row equality is content: the item without its background outcome and client message id, and the ids of its resources. */
export function sameContent(left: ProjectedTimelineEntry, right: ProjectedTimelineEntry): boolean {
  return entryContent(left) === entryContent(right);
}

function entryContent(entry: ProjectedTimelineEntry): string {
  let content = contentOf.get(entry);
  if (content === undefined) {
    const { background: _background, clientMessageId: _clientMessageId, ...item } = entry.item as ProjectedTimelineEntry['item'] & { clientMessageId?: string };
    content = canonicalJson({ item, resources: entry.resources.map((resource) => resource.resourceId) });
    contentOf.set(entry, content);
  }
  return content;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const fields = Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${fields.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
}
