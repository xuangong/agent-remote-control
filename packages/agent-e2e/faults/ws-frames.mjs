// An incremental decoder of RFC 6455 frames for the proxy's tap: it turns the bytes of one direction of a WebSocket into text
// messages. It reads only; the bytes still pass on unchanged. Binary messages are counted, not decoded. Compressed messages
// (the RSV1 bit) cannot be read, so the proxy asks the server not to negotiate compression.

/**
 * Returns `{ push(chunk) }`. `onText(text)` is called for each complete text message, `onClose(code)` for a close frame and
 * `onOther(kind)` for a binary message (`'binary'`) or a compressed one (`'compressed'`). With `skipHttpHead`, the bytes up to
 * the blank line that ends the HTTP upgrade response are skipped first.
 */
export function createFrameDecoder({ onText, onClose = () => {}, onOther = () => {}, skipHttpHead = false }) {
  let buffer = Buffer.alloc(0);
  let headDone = !skipHttpHead;
  let fragments = [];
  let fragmentOpcode = 0;
  let fragmentCompressed = false;

  const finish = (opcode, payload, compressed) => {
    if (compressed) onOther('compressed');
    else if (opcode === 1) onText(payload.toString('utf8'));
    else if (opcode === 2) onOther('binary');
  };

  const readFrame = () => {
    if (buffer.length < 2) return false;
    const first = buffer[0], second = buffer[1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) { if (buffer.length < 4) return false; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) return false; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return false;
    let payload = buffer.subarray(offset, offset + length);
    if (masked) {
      const key = buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload);
      for (let at = 0; at < payload.length; at += 1) payload[at] ^= key[at % 4];
    }
    buffer = buffer.subarray(offset + length);
    const fin = (first & 0x80) !== 0, compressed = (first & 0x40) !== 0, opcode = first & 0x0f;
    if (opcode === 8) onClose(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
    else if (opcode === 9 || opcode === 10) { /* ping and pong carry no messages */ }
    else {
      if (opcode !== 0) { fragments = []; fragmentOpcode = opcode; fragmentCompressed = compressed; }
      fragments.push(payload);
      if (fin) { finish(fragmentOpcode, Buffer.concat(fragments), fragmentCompressed); fragments = []; }
    }
    return true;
  };

  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (!headDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        buffer = buffer.subarray(end + 4);
        headDone = true;
      }
      while (readFrame());
    },
  };
}

/** Encodes one text message as a frame, masked when `mask` is given (a client frame). For tests of the decoder and the proxy. */
export function encodeTextFrame(text, { mask, fin = true, opcode = 1 } = {}) {
  const payload = Buffer.from(text, 'utf8');
  const head = [(fin ? 0x80 : 0) | opcode];
  const flag = mask ? 0x80 : 0;
  if (payload.length < 126) head.push(flag | payload.length);
  else if (payload.length < 65536) head.push(flag | 126, payload.length >> 8, payload.length & 0xff);
  else { const long = Buffer.alloc(8); long.writeBigUInt64BE(BigInt(payload.length)); head.push(flag | 127, ...long); }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const masked = Buffer.from(payload);
  for (let at = 0; at < masked.length; at += 1) masked[at] ^= mask[at % 4];
  return Buffer.concat([Buffer.from(head), Buffer.from(mask), masked]);
}
