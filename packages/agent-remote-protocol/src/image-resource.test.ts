import { describe, expect, it } from 'vitest';
import { decodeResourceResponse, encodeResourceResponse } from './codec.js';
import { PROTOCOL_VERSION } from './version.js';

describe('image resource payloads', () => {
  it.each(['A', 'AA', 'AAA', 'AA=A', 'AAAA=', 'AAAA===', 'AA\nA'])('rejects malformed base64 %j', contentBase64 => {
    expect(decodeResourceResponse(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'resource_response', payload: {
      requestId: 'r', agentId: 'a', resourceId: 'image', state: { status: 'available',
        mediaType: 'image/png', sha256: 'a'.repeat(64), byteLength: 3, contentBase64 },
    } })).status).toBe('rejected');
  });
  it('round trips a maximum-size input image without overflowing validation', () => {
    const byteLength = 10 * 1024 * 1024;
    const message = { protocolVersion: PROTOCOL_VERSION, type: 'resource_response' as const, payload: {
      requestId: 'r', agentId: 'a', resourceId: 'image', state: { status: 'available' as const,
        mediaType: 'image/png', sha256: 'a'.repeat(64), byteLength, contentBase64: Buffer.alloc(byteLength).toString('base64') },
    } };
    const encoded = encodeResourceResponse(message);
    expect(encoded.status).toBe('ok');
    if (encoded.status !== 'ok') throw new Error('Encoding failed.');
    expect(decodeResourceResponse(encoded.json)).toEqual({ status: 'ok', value: message });
  });
});
