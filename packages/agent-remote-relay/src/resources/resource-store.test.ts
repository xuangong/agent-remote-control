import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InMemoryResourceStore } from '../index.js';

describe('InMemoryResourceStore', () => {
  it('stores immutable content-addressed bytes and idempotently accepts the same blob', () => {
    const store = new InMemoryResourceStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    store.putBlob({ sha256, mediaType: 'application/octet-stream', bytes });
    bytes[0] = 9;
    store.putBlob({ sha256, mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) });

    const firstRead = store.getBlob(sha256);
    expect(firstRead).toEqual({
      sha256,
      mediaType: 'application/octet-stream',
      byteLength: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    if (!firstRead) throw new Error('Expected stored bytes.');
    firstRead.bytes[1] = 8;
    expect(store.getBlob(sha256)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('keeps resource records scoped to their Agent identity', () => {
    const store = new InMemoryResourceStore();
    store.createRecord({
      resourceId: 'resource-1', agentId: 'agent-a', locator: 'output.png',
      normalizedLocator: 'output.png', state: { status: 'pending', retryAfterMs: 250 },
    });

    expect(store.getRecord('agent-a', 'resource-1')).toMatchObject({ locator: 'output.png' });
    expect(store.getRecord('agent-b', 'resource-1')).toBeUndefined();
  });

  it('rejects bytes that do not match their declared SHA-256 identity', () => {
    const store = new InMemoryResourceStore();

    expect(() => store.putBlob({
      sha256: '0'.repeat(64), mediaType: 'application/octet-stream', bytes: new Uint8Array([1]),
    })).toThrow('SHA-256');
  });
});
