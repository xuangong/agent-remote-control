// Writes the Orchard favicon and app icons from the one drawing of the mark (agent-client-web theme/mark.ts):
// public/favicon.svg is markSvg() itself, and icon-192.png and icon-512.png are rasterized from it with Playwright Chromium.
// Run through `pnpm brand:assets`, which builds agent-client-web first. The outputs are committed.
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { markSvg } = await import(new URL('../packages/agent-client-web/dist/theme/mark.js', import.meta.url).href);
const { chromium } = createRequire(`${root}packages/agent-remote-lab/package.json`)('@playwright/test');
const publicDirectory = `${root}packages/agent-remote-lab/public/`;
const svg = markSvg();

await writeFile(`${publicDirectory}favicon.svg`, svg);
const browser = await chromium.launch({ headless: true });
try {
  const rasterize = async size => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html, body { margin: 0; background: transparent; } svg { display: block; width: ${size}px; height: ${size}px; }</style>${svg}`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    return png;
  };
  for (const size of [192, 512]) await writeFile(`${publicDirectory}app/icon-${size}.png`, await rasterize(size));
  await writeFile(`${publicDirectory}app/favicon-32.png`, await rasterize(32));
  // favicon.ico for browsers that ignore SVG icons (older Safari) and for the implicit /favicon.ico request.
  await writeFile(`${publicDirectory}favicon.ico`, icoOf(await Promise.all([16, 32, 48].map(async size => ({ size, png: await rasterize(size) })))));
} finally {
  await browser.close();
}
console.log('Wrote favicon.svg, favicon.ico, app/favicon-32.png, app/icon-192.png and app/icon-512.png from the mark.');

/** An ICO file holding PNG images, one directory entry each (supported by every browser that reads ICO). */
function icoOf(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(image => image.png)]);
}
