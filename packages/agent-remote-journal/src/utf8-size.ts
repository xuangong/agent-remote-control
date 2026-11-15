const encoder = new TextEncoder();

/** The size of a string in UTF-8 bytes. A lone surrogate counts as the three bytes of the replacement character, as `TextEncoder` encodes it. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}
