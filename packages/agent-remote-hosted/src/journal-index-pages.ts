import type { JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import { JOURNAL_INDEX_PAGE_MAX_ITEMS } from '@orchardworks/agent-remote-protocol';

/** The most UTF-8 bytes of index entries in one message; a journal message may be 8 MiB, so a page leaves ample room for its envelope. */
export const JOURNAL_INDEX_PAGE_MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** The leading entries that fit one message: at most the page's items and bytes, and always the first entry. */
export function packIndex(entries: readonly JournalIndexEntry[]): JournalIndexEntry[] {
  const packed: JournalIndexEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (packed.length >= JOURNAL_INDEX_PAGE_MAX_ITEMS) break;
    const size = encoder.encode(JSON.stringify(entry)).length + 1;
    if (packed.length > 0 && bytes + size > JOURNAL_INDEX_PAGE_MAX_BYTES) break;
    packed.push(entry);
    bytes += size;
  }
  return packed;
}
