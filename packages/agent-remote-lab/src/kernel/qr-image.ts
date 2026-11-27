import { withMessageKey } from '@orchardworks/agent-client';

/**
 * Reads the QR code in an image the person pasted or dropped, such as a screenshot of the terminal that printed a
 * session link. The decoder and the browser's image decoding are ports, so the rule is checked without a browser.
 */
export interface QrPixels { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number }
export interface QrImagePorts {
  /** The image's pixels, scaled down so that neither side is longer than `longest`. */
  pixels(image: Blob, longest: number): Promise<QrPixels>;
  /** The text of the QR code in the pixels; undefined when there is none. */
  decode(pixels: QrPixels): Promise<string | undefined>;
}

/** Screenshots of large displays are scaled to this; a terminal's QR code stays far above the decoder's smallest module size. */
export const LONGEST_SIDE = 2400;

export async function readQrImage(image: Blob, ports: QrImagePorts = browserQrImagePorts): Promise<string> {
  if (!image.type.startsWith('image/')) throw withMessageKey(new Error('This is not an image.'), 'sessions.qrImage.notImage');
  let pixels: QrPixels;
  try { pixels = await ports.pixels(image, LONGEST_SIDE); }
  catch { throw withMessageKey(new Error('This image could not be read.'), 'sessions.qrImage.unreadable'); }
  const text = await ports.decode(pixels);
  if (!text) throw withMessageKey(new Error('No QR code was found in this image.'), 'sessions.qrImage.none');
  return text;
}

/** The first image among pasted or dropped items, if any. */
export function imageOf(items: { files?: FileList | null; items?: DataTransferItemList | null } | null | undefined): File | undefined {
  for (const file of Array.from(items?.files ?? [])) if (file.type.startsWith('image/')) return file;
  for (const item of Array.from(items?.items ?? [])) if (item.kind === 'file' && item.type.startsWith('image/')) { const file = item.getAsFile(); if (file) return file; }
  return undefined;
}

export const browserQrImagePorts: QrImagePorts = {
  async pixels(image, longest) {
    const bitmap = await createImageBitmap(image);
    try {
      const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas is unavailable.');
      // A transparent screenshot would read as black: put the code on white.
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const read = context.getImageData(0, 0, width, height);
      return { data: read.data, width, height };
    } finally { bitmap.close(); }
  },
  async decode(pixels) {
    // The decoder loads with the first image read, not with the workbench.
    const { default: decodeQr } = await import('jsqr');
    return decodeQr(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data || undefined;
  },
};
