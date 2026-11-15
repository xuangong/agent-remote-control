import { encodeRemoteHostUplinkMessage, JOURNAL_INDEX_PAGE_MAX_ITEMS, REMOTE_HOST_UPLINK_VERSION } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { packIndex } from './journal-index-pages.js';

const entry = (at: number, keyLength = 8) => ({
  itemKey: `${at}-`.padEnd(keyLength, 'k'), seqStart: at, seqEnd: at, state: 'complete' as const, liveOnly: false, revision: 1, resident: true });
const asMessage = (index: ReturnType<typeof entry>[]) =>
  ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_index_page' as const, requestId: 'index-1', sessionKey: 'codex:thread-1', index });

describe('packIndex', () => {
  it('packs nothing from nothing and everything that fits', () => {
    expect(packIndex([])).toEqual([]);
    const index = Array.from({ length: 50 }, (_, at) => entry(at));
    expect(packIndex(index)).toEqual(index);
  });

  it('stops at the item bound', () => {
    const index = Array.from({ length: JOURNAL_INDEX_PAGE_MAX_ITEMS + 5 }, (_, at) => entry(at));
    expect(packIndex(index)).toHaveLength(JOURNAL_INDEX_PAGE_MAX_ITEMS);
  });

  it('stops at the byte bound, always packs one entry, and what it packs fits one message', () => {
    const index = Array.from({ length: 1200 }, (_, at) => entry(at, 4000));
    const packed = packIndex(index);
    expect(packed.length).toBeGreaterThan(0);
    expect(packed.length).toBeLessThan(index.length);
    expect(packed).toEqual(index.slice(0, packed.length));
    expect(encodeRemoteHostUplinkMessage(asMessage(packed)).status).toBe('ok');
  });
});
