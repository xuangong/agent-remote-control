import { describe, expect, it } from 'vitest';

import { utf8ByteLength } from './utf8-size.js';

/** Counts by code point, the way UTF-8 does; a lone surrogate counts as the three bytes of U+FFFD. */
function oracle(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) { bytes += 4; at += 1; }
    else bytes += 3;
  }
  return bytes;
}

describe('utf8ByteLength', () => {
  it('counts each width, including lone surrogates', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('字')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('\udc00x')).toBe(4);
  });

  it('agrees with a count by code point over random strings', () => {
    let state = 12345;
    const random = (limit: number) => { state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 1_013_904_223) >>> 0; return state % limit; };
    const units = [0x41, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff];
    for (let round = 0; round < 500; round++) {
      const text = String.fromCharCode(...Array.from({ length: random(40) }, () => (random(3) === 0 ? random(0x10000) : units[random(units.length)]!)));
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(oracle(text));
    }
  });
});
