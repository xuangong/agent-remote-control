import { imageSize } from 'image-size';
import type { ImageDimensions } from '@agent-remote-controller/agent-remote-protocol';

const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function readImageDimensions(bytes: Uint8Array, mediaType: string): ImageDimensions | undefined {
  if (!supportedTypes.has(mediaType)) return undefined;
  try {
    // Keep header readers within this view, including pooled or truncated buffers.
    const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes);
    const size = imageSize(input);
    // Browsers display EXIF-rotated JPEGs with their oriented dimensions.
    const rotated = size.orientation !== undefined && size.orientation >= 5 && size.orientation <= 8;
    const width = rotated ? size.height : size.width;
    const height = rotated ? size.width : size.height;
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) return undefined;
    return { width, height };
  } catch {
    // Invalid or incomplete headers must not prevent the normal resource response.
    return undefined;
  }
}
