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

  it('ignores background outcomes that merge in later', async () => {
    const item = { type: 'assistant_message' as const, text: 'Hello', messageId: 'message-1' };
    const withBackground = { ...item, background: { id: 'review-1', kind: 'review' as const, status: 'visible' as const } };
    expect(await itemDigest(withBackground)).toBe(await itemDigest(item));
  });

  it('is the same for nested objects listing the same keys in a different order', async () => {
    const first = await itemDigest({ type: 'tool_call', callId: 'call-1', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'ls', cwd: '/tmp' } });
    const second = await itemDigest({ type: 'tool_call', callId: 'call-1', name: 'shell', status: 'completed', error: null, detail: { cwd: '/tmp', command: 'ls', type: 'shell' } });
    expect(first).toBe(second);
  });

  it('ignores the client message id that the journal writes into user messages', async () => {
    const item = { type: 'user_message' as const, text: 'ask' };
    expect(await itemDigest({ ...item, clientMessageId: 'client-1' })).toBe(await itemDigest(item));
  });
});
