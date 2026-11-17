import { expect, it } from 'vitest';
import jsQR from 'jsqr';
import { renderSessionQr } from './share-qr.js';
import { readSessionCode } from '../../agent-remote-lab/src/session-transfer.js';

it('renders a compact terminal QR with a quiet border that decodes to a browser-accepted session link', async () => {
  const url = 'https://agents.xianliao.de5.net/?host=70b07c4c-a940-4359-b7f3-a88f13200772&provider=codex&session=01a0c221-54cd-7bd3-86df-554565d9d9ee';
  const terminal = await renderSessionQr(url);
  const lines = terminal.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n$/, '').split('\n');
  // Do not trim rows: whitespace is part of the quiet border.
  const width = lines[0]!.length, height = lines.length * 2;
  const scale = 6, rgba = new Uint8ClampedArray(width * height * scale * scale * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const glyph = lines[Math.floor(y / 2)]?.[x] ?? ' ';
    const black = glyph === '█' || glyph === (y % 2 ? '▄' : '▀');
    if (black) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = (((y * scale + dy) * width * scale) + x * scale + dx) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  const decoded = jsQR(rgba, width * scale, height * scale)?.data;
  expect(decoded).toBe(url);
  expect(readSessionCode(decoded!, 'https://agents.xianliao.de5.net')).toEqual({ hostId: '70b07c4c-a940-4359-b7f3-a88f13200772',
    providerId: 'codex', nativeSessionId: '01a0c221-54cd-7bd3-86df-554565d9d9ee' });
  expect(lines[0]).toBe(' '.repeat(width));
});
