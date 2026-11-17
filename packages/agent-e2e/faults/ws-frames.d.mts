export interface FrameDecoder { push(chunk: Buffer): void }
export function createFrameDecoder(options: {
  onText(text: string): void;
  onClose?(code: number): void;
  onOther?(kind: 'binary' | 'compressed'): void;
  skipHttpHead?: boolean;
}): FrameDecoder;
export function encodeTextFrame(text: string, options?: { mask?: number[] | Uint8Array; fin?: boolean; opcode?: number }): Buffer;
