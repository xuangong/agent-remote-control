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
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html, body { margin: 0; background: transparent; } svg { display: block; width: ${size}px; height: ${size}px; }</style>${svg}`);
    await page.screenshot({ path: `${publicDirectory}app/icon-${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('Wrote favicon.svg, app/icon-192.png and app/icon-512.png from the mark.');
