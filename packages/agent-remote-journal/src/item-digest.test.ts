import { describe, expect, it } from 'vitest';

import { itemDigest } from './item-digest.js';

describe('itemDigest', () => {
  it('is the same for the same content in any key order', async () => {
    const first = await itemDigest({ type: 'assistant_message', text: 'Hello', messageId: 'message-1' });
    const second = await itemDigest({ messageId: 'message-1', text: 'Hello', type: 'assistant_message' });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the content', async () => {
    expect(await itemDigest({ type: 'reasoning', text: 'a' })).not.toBe(await itemDigest({ type: 'reasoning', text: 'b' }));
  });
});
