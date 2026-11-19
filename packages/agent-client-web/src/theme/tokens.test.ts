import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { avatarPalette, contrastRatio, orchardColors, orchardMotion, renderThemeCss, textPairs, type OrchardColorName, type ThemeName } from './tokens.js';

const themes: readonly ThemeName[] = ['light', 'dark'];
const color = (name: OrchardColorName, theme: ThemeName) => orchardColors[name][theme];

describe.each(themes)('the %s theme', theme => {
  it('meets every promised text pair (WCAG AA), with alpha composited over the surface', () => {
    const failing = textPairs.flatMap(([text, surface, minimum]) => {
      const ratio = contrastRatio(color(text, theme), color(surface, theme));
      return ratio >= minimum ? [] : [`${text} on ${surface}: ${ratio.toFixed(2)} < ${minimum}`];
    });
    expect(failing).toEqual([]);
  });

  it('promises the secondary grey, the brand ink, the user bubble, failure words and the focus ring on their surfaces', () => {
    const promised = new Set(textPairs.map(([text, surface, minimum]) => `${text}/${surface}/${minimum}`));
    const required = [
      ...['ground', 'surface', 'fill', 'tint'].map(surface => `text-secondary/${surface}/4.5`),
      'on-brand/brand/4.5', 'on-mine/mine/4.5',
      ...['surface', 'fill', 'tint'].map(surface => `danger-text/${surface}/4.5`),
      'focus/ground/3', 'focus/surface/3',
    ];
    expect(required.filter(pair => !promised.has(pair))).toEqual([]);
  });

  it('keeps the eyes at 3:1 on every avatar fill and on the resting grey', () => {
    for (const fill of [...avatarPalette.map(entry => entry.value), color('avatar-resting', theme)]) {
      expect(contrastRatio(color('avatar-eye', theme), fill), `eye on ${fill}`).toBeGreaterThanOrEqual(3);
    }
  });
});

it('keeps the brand orange exactly, and ink on it dark in both themes', () => {
  expect(orchardColors.brand).toEqual({ light: '#ff7f45', dark: '#ff7f45' });
  expect(contrastRatio('#ffffff', '#ff7f45')).toBeLessThan(4.5);
});

it('composites a translucent colour over the surface before measuring', () => {
  expect(contrastRatio('rgb(0 0 0 / 0)', '#ffffff')).toBeCloseTo(1, 5);
  expect(contrastRatio('rgb(0 0 0 / 1)', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
});

describe('theme.css', () => {
  const css = renderThemeCss();

  it('is the committed file, byte for byte', () => {
    const committed = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
    expect(committed === css, 'theme.css differs from renderThemeCss(): run `pnpm --filter @orchardworks/agent-client-web theme:write`').toBe(true);
  });

  it('declares each colour token once, as a light-dark() pair', () => {
    for (const [name, { light, dark }] of Object.entries(orchardColors)) {
      const declarations = css.split('\n').filter(line => line.trim().startsWith(`--orchard-${name}:`));
      expect(declarations, name).toEqual([`  --orchard-${name}: light-dark(${light}, ${dark});`]);
    }
  });

  it('follows the system and lets data-theme pin either theme', () => {
    expect(css).toMatch(/:root \{\n {2}color-scheme: light dark;/);
    expect(css).toContain(':root[data-theme="light"] { color-scheme: light; }');
    expect(css).toContain(':root[data-theme="dark"] { color-scheme: dark; }');
  });

  it('sets every duration to 0 under reduced motion, and declares no keyframes', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const name of Object.keys(orchardMotion.durations)) expect(reduced).toContain(`--orchard-duration-${name}: 0ms;`);
    expect(css).not.toContain('@keyframes');
  });
});
