// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { markSvg, orchardColors } from '@orchardworks/agent-client-web/theme';
import { STATIC_SITE_FILES } from '@orchardworks/agent-relay-core/static-site';

const publicFile = (path: string) => new URL(`../public/${path}`, import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(publicFile('app/manifest.webmanifest'), 'utf8')) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose: string }[] };
/** A PNG's width and height from its header. */
const pngSize = (path: string) => { const png = readFileSync(publicFile(path)); expect(png.subarray(1, 4).toString('latin1')).toBe('PNG'); return [png.readUInt32BE(16), png.readUInt32BE(20)]; };

it('serves the favicon cut from the one drawing of the mark', () => {
  expect(readFileSync(publicFile('favicon.svg'), 'utf8'), 'favicon.svg differs from markSvg(): run `pnpm brand:assets`').toBe(markSvg());
});

it.each([
  ['app/icon-192.png', 192], ['app/icon-512.png', 512], ['app/icon-maskable-192.png', 192], ['app/icon-maskable-512.png', 512],
  ['app/icon-monochrome-192.png', 192], ['app/icon-monochrome-512.png', 512], ['app/apple-touch-icon.png', 180],
] as const)('has %s at %i x %i', (path, size) => {
  expect(pngSize(path)).toEqual([size, size]);
});

it('installs as Orchard, standalone over the whole site, with its title bar given to the page where the platform allows', () => {
  expect(manifest).toMatchObject({ id: '/', name: 'Orchard', short_name: 'Orchard', start_url: '/', scope: '/', display: 'standalone',
    display_override: ['window-controls-overlay'], background_color: orchardColors.ground.light, theme_color: orchardColors.ground.light });
});

it('gives every platform an icon of its kind, each in two sizes', () => {
  expect(manifest.icons.map(icon => [icon.src, icon.sizes, icon.purpose])).toEqual([
    ['/app/icon-192.png', '192x192', 'any'], ['/app/icon-512.png', '512x512', 'any'],
    ['/app/icon-maskable-192.png', '192x192', 'maskable'], ['/app/icon-maskable-512.png', '512x512', 'maskable'],
    ['/app/icon-monochrome-192.png', '192x192', 'monochrome'], ['/app/icon-monochrome-512.png', '512x512', 'monochrome'],
  ]);
  for (const icon of manifest.icons) expect(pngSize(icon.src.slice(1))).toEqual(icon.sizes.split('x').map(Number));
});

it('titles the page Orchard, opens it as a home-screen app and gives the browser chrome each theme\'s ground', () => {
  expect(html).toContain('<title>Orchard</title>');
  expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${orchardColors.ground.light}" />`);
  expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${orchardColors.ground.dark}" />`);
  expect(html).toContain('<meta name="color-scheme" content="light dark" />');
  expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
  expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/app/apple-touch-icon.png" />');
  // iOS names a home-screen icon from the page title unless this says otherwise; the title changes with the conversation.
  expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Orchard" />');
});

it('links only the files the Relay serves, and the Relay serves every icon of the manifest', () => {
  // gateway-static.ts and worker.ts serve exactly STATIC_SITE_FILES besides the built bundles.
  const linked = [...html.matchAll(/<link [^>]*href="([^"]+)"/g)].map(match => match[1]!);
  expect(linked.filter(path => !STATIC_SITE_FILES.includes(path))).toEqual([]);
  expect(manifest.icons.map(icon => icon.src).filter(path => !STATIC_SITE_FILES.includes(path))).toEqual([]);
  expect(STATIC_SITE_FILES).toContain('/sw.js');
});
