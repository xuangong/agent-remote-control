import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeTextFrame } from './ws-frames.mjs';
import { seededRandom } from './seeded-random.mjs';

const collect = (options: { skipHttpHead?: boolean } = {}) => {
  const seen = { text: [] as string[], close: [] as number[], other: [] as string[] };
  const decoder = createFrameDecoder({ onText: text => seen.text.push(text), onClose: code => seen.close.push(code), onOther: kind => seen.other.push(kind), ...options });
  return { seen, decoder };
};

describe('the WebSocket frame decoder', () => {
  it('reads unmasked and masked text frames, including the 16-bit and 64-bit lengths', () => {
    const { seen, decoder } = collect();
    const long = 'x'.repeat(70_000);
    decoder.push(encodeTextFrame('server says hi'));
    decoder.push(encodeTextFrame('client says hi', { mask: [1, 2, 3, 4] }));
    decoder.push(encodeTextFrame('y'.repeat(300)));
    decoder.push(encodeTextFrame(long, { mask: [9, 8, 7, 6] }));
    expect(seen.text.map(text => text.length)).toEqual([14, 14, 300, 70_000]);
    expect(seen.text[1]).toBe('client says hi');
  });
  it('reassembles a frame split across chunks and a message split across fragments', () => {
    const { seen, decoder } = collect();
    const frame = encodeTextFrame('split me', { mask: [5, 6, 7, 8] });
    decoder.push(frame.subarray(0, 3));
    decoder.push(frame.subarray(3));
    decoder.push(Buffer.concat([encodeTextFrame('one ', { fin: false }), encodeTextFrame('two', { opcode: 0 })]));
    expect(seen.text).toEqual(['split me', 'one two']);
  });
  it('skips the HTTP upgrade response, reports close codes and counts binary and compressed messages', () => {
    const { seen, decoder } = collect({ skipHttpHead: true });
    const compressed = encodeTextFrame('zz'); compressed[0] = compressed[0]! | 0x40;
    const binary = encodeTextFrame('bin', { opcode: 2 });
    const close = Buffer.from([0x88, 2, 0x03, 0xe8]);
    decoder.push(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'), encodeTextFrame('first')]));
    decoder.push(Buffer.concat([compressed, binary, encodeTextFrame('', { opcode: 9 }), close]));
    expect(seen).toEqual({ text: ['first'], close: [1000], other: ['compressed', 'binary'] });
  });
});

describe('the seeded generator', () => {
  it('replays from its seed and differs between seeds', () => {
    const run = (seed: number) => { const random = seededRandom(seed); return [random.next(), random.int(1, 6), random.pick(['a', 'b', 'c'])]; };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });
});
