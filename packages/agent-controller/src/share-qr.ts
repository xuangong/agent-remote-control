import QRCode from 'qrcode';

/** Two square modules per terminal cell, with an explicit white quiet zone on either terminal theme. */
export async function renderSessionQr(url: string): Promise<string> {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const margin = 4, width = modules.size + margin * 2;
  const black = (x: number, y: number) => x >= margin && y >= margin && x < width - margin && y < width - margin
    && modules.get(y - margin, x - margin);
  const lines: string[] = [];
  for (let y = 0; y < width; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = black(x, y), bottom = black(x, y + 1);
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(`\x1b[47m\x1b[30m${line}\x1b[0m`);
  }
  return lines.join('\n') + '\n';
}
