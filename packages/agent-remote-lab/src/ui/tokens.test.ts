// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** The declarations of the first `:root` block after `start` in the token stylesheet. */
function block(start: number): Map<string, string> {
  const open = source.indexOf(':root', start);
  const body = source.slice(source.indexOf('{', open) + 1, source.indexOf('}', open));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
}
const light = block(0);
const dark = block(source.indexOf('@media (prefers-color-scheme: dark)'));

function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const colorTokens = [...light.keys()].filter(name => /^#|^rgb/.test(light.get(name)!));
const surfaces = ['--ui-background', '--ui-background-grouped', '--ui-background-elevated', '--ui-sidebar', '--ui-selection'];
const texts = ['--ui-label', '--ui-label-secondary', '--ui-accent-text', '--ui-status-failure', '--ui-status-success', '--ui-status-attention'];

it('defines every color token for both appearances', () => {
  expect(colorTokens.length).toBeGreaterThan(20);
  for (const name of colorTokens) expect(dark.has(name), `${name} has no dark value`).toBe(true);
  expect(source).toContain('color-scheme: light dark');
});

it.each([['light', light], ['dark', dark]] as const)('keeps %s text readable on every surface (WCAG AA)', (_appearance, tokens) => {
  for (const text of texts) for (const surface of surfaces) {
    expect(contrast(tokens.get(text)!, tokens.get(surface)!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(tokens.get('--ui-on-accent')!, tokens.get('--ui-accent')!)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens.get('--ui-on-attention')!, tokens.get('--ui-status-attention')!)).toBeGreaterThanOrEqual(4.5);
  for (const surface of ['--ui-background', '--ui-background-grouped', '--ui-sidebar']) {
    expect(contrast(tokens.get('--ui-control-border')!, tokens.get(surface)!), `control border on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});

it('turns motion off when the system asks for reduced motion', () => {
  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{[^}]*--ui-duration: 0ms/);
});
