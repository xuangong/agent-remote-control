import { describe, expect, it } from 'vitest';
import { decodeClientMessage, decodeServerMessage } from './codec.js';
import { PROTOCOL_VERSION } from './version.js';

const envelope = { protocolVersion: PROTOCOL_VERSION, type: 'send_message' };
const identity = { requestId: 'request', agentId: 'agent', operationId: '019c6e27-e55b-73d1-87d8-4e01f1f75043' };
describe('ordered image input contract', () => {
  it('preserves legacy text and accepts image-only input', () => {
    expect(decodeClientMessage(JSON.stringify({ ...envelope, payload: { ...identity, text: 'hello' } })).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify({ ...envelope, payload: { ...identity, content: [{ type: 'image', attachmentId: 'a', label: 'image #1' }] } })).status).toBe('ok');
  });
  it.each([
    { text: 'ambiguous', content: [{ type: 'text', text: 'hello' }] },
    { content: [{ type: 'image', path: '/private/image.png', label: 'image #1' }] },
    { content: [{ type: 'image', url: 'https://example.com/image.png', label: 'image #1' }] },
    { content: [] },
  ])('rejects mixed payloads, injected paths/URLs, and empty content', payload => {
    expect(decodeClientMessage(JSON.stringify({ ...envelope, payload: { ...identity, ...payload } })).status).toBe('rejected');
  });
  it('rejects malformed and oversized chunks before dispatch', () => {
    for (const contentBase64 of ['?', 'a', 'AAAA'.repeat(10924)]) {
      expect(decodeClientMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'image_upload_chunk', payload: { requestId: 'r', agentId: 'a', uploadId: 'u', offset: 0, contentBase64 } })).status).toBe('rejected');
    }
  });
  it('accepts completed receipts with detected dimensions', () => {
    expect(decodeServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'image_upload_result', payload: { requestId: 'r', agentId: 'a', uploadId: 'u', offset: 1,
      attachment: { attachmentId: 'image', mediaType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64), imageDimensions: { width: 1, height: 1 } } } })).status).toBe('ok');
  });
});
