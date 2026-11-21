// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { markSvg, orchardColors } from '@orchardworks/agent-client-web/theme';

const publicFile = (path: string) => new URL(`../public/${path}`, import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

it('serves the favicon cut from the one drawing of the mark', () => {
  expect(readFileSync(publicFile('favicon.svg'), 'utf8'), 'favicon.svg differs from markSvg(): run `pnpm brand:assets`').toBe(markSvg());
});

it.each([['app/icon-192.png', 192], ['app/icon-512.png', 512]] as const)('has %s at %i x %i', (path, size) => {
  const png = readFileSync(publicFile(path));
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
});

it('names the installed app Orchard on the light ground', () => {
  const manifest = JSON.parse(readFileSync(publicFile('app/manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
  expect(manifest).toMatchObject({ name: 'Orchard', short_name: 'Orchard', background_color: orchardColors.ground.light, theme_color: orchardColors.ground.light });
  expect((manifest.icons as { src: string }[]).map(icon => icon.src)).toEqual(['/app/icon-192.png', '/app/icon-512.png']);
});

it('titles the page Orchard and gives the browser chrome each theme\'s ground', () => {
  expect(html).toContain('<title>Orchard</title>');
  expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${orchardColors.ground.light}" />`);
  expect(html).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${orchardColors.ground.dark}" />`);
  expect(html).toContain('<meta name="color-scheme" content="light dark" />');
  expect(html).toContain('<link rel="apple-touch-icon" href="/app/icon-192.png" />');
  // iOS names a home-screen icon from the page title unless this says otherwise; the title changes with the conversation.
  expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Orchard" />');
});

it('links only the paths the Relay already serves', () => {
  // gateway-static.ts and worker.ts serve exactly these brand paths; a new one would need both allowlists.
  const served = ['/favicon.svg', '/favicon.ico', '/app/favicon-32.png', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png'];
  const linked = [...html.matchAll(/<link [^>]*href="([^"]+)"/g)].map(match => match[1]!);
  expect(linked.filter(path => !served.includes(path))).toEqual([]);
});
