// @vitest-environment node
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { browserQrImagePorts, readQrImage, type QrImagePorts, type QrPixels } from './qr-image.js';

/** Pixels of a QR code as a screenshot would hold them: black modules on white, with a quiet zone and some surrounding page. */
function screenshot(text: string, options: { scale?: number; margin?: number; inverted?: boolean } = {}): QrPixels {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const scale = options.scale ?? 4, margin = options.margin ?? 4, page = 40;
  const side = (modules.size + margin * 2) * scale + page * 2;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const mx = Math.floor((x - page) / scale) - margin, my = Math.floor((y - page) / scale) - margin;
    const dark = mx >= 0 && my >= 0 && mx < modules.size && my < modules.size && modules.get(my, mx) === 1;
    const value = dark !== (options.inverted === true) ? 0 : 255, at = (y * side + x) * 4;
    data[at] = data[at + 1] = data[at + 2] = value; data[at + 3] = 255;
  }
  return { data, width: side, height: side };
}
const ports = (pixels: QrPixels | Error): QrImagePorts => ({ pixels: async () => { if (pixels instanceof Error) throw pixels; return pixels; }, decode: browserQrImagePorts.decode });
const png = new Blob(['x'], { type: 'image/png' });
const LINK = 'https://arc.example/?host=desk&provider=claude&session=43f1dca1-ea0d-46f3-a1c6-83d3d635cd3c&as=bot&name=Reuse+test';

describe('reading a QR code from an image', () => {
  it('returns the text of a session link pasted as a screenshot', async () => {
    expect(await readQrImage(png, ports(screenshot(LINK)))).toBe(LINK);
  });

  it('reads a light-on-dark code too', async () => {
    expect(await readQrImage(png, ports(screenshot(LINK, { inverted: true })))).toBe(LINK);
  });

  it('says no QR code was found in an image without one', async () => {
    const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 };
    await expect(readQrImage(png, ports(blank))).rejects.toMatchObject({ messageKey: 'sessions.qrImage.none' });
  });

  it('says the file is not an image, or could not be read', async () => {
    await expect(readQrImage(new Blob(['x'], { type: 'text/plain' }), ports(screenshot(LINK)))).rejects.toMatchObject({ messageKey: 'sessions.qrImage.notImage' });
    await expect(readQrImage(png, ports(new Error('bad')))).rejects.toMatchObject({ messageKey: 'sessions.qrImage.unreadable' });
  });

  it('asks for pixels no larger than the limit', async () => {
    let asked = 0;
    await readQrImage(png, { pixels: async (_image, longest) => { asked = longest; return screenshot(LINK); }, decode: browserQrImagePorts.decode });
    expect(asked).toBe(2400);
  });
});
