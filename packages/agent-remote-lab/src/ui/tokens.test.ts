// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** The index of the first `text` at or after `from` in the token stylesheet; throws when there is none. */
function find(text: string, from = 0): number {
  const index = source.indexOf(text, from);
  if (index < 0) throw new Error(`tokens.css has no "${text}" at or after offset ${from}`);
  return index;
}

/** The declarations of the first `:root` block in the token stylesheet; throws unless it lies wholly between `from` and `to`. */
function block(from: number, to: number): Map<string, string> {
  const open = find(':root', from);
  const close = find('}', open); // Assumes a flat `:root` block: it ends at the first `}`.
  if (close >= to) throw new Error(`tokens.css has no :root block between offsets ${from} and ${to}`);
  const body = source.slice(find('{', open) + 1, close);
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
}
const darkAt = find('@media (prefers-color-scheme: dark)');
const reducedAt = find('@media (prefers-reduced-motion: reduce)');
const light = block(0, darkAt);
const dark = block(darkAt, reducedAt);

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`${hex} is not a #rrggbb color`);
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
/** What `color-mix(in srgb, a <weightOfA>, b)` gives for two #rrggbb colors: each 0–255 channel interpolates linearly. */
function mix(a: string, b: string, weightOfA: number): string {
  const channels = (hex: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`${hex} is not a #rrggbb color`);
    return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
  };
  const other = channels(b);
  return `#${channels(a).map((value, index) => Math.round(value * weightOfA + other[index]! * (1 - weightOfA)).toString(16).padStart(2, '0')).join('')}`;
}

/** The sorted names of the tokens whose value is a literal color. */
function colorNames(tokens: Map<string, string>): string[] {
  return [...tokens].filter(([, value]) => /^#|^rgb/.test(value)).map(([name]) => name).sort();
}
const colorTokens = colorNames(light);
const surfaces = ['--ui-background', '--ui-background-grouped', '--ui-background-elevated', '--ui-sidebar', '--ui-selection'];
const texts = ['--ui-label', '--ui-label-secondary', '--ui-accent-text', '--ui-status-failure', '--ui-status-success', '--ui-status-attention', '--ui-status-working'];

it('defines every color token for both appearances', () => {
  expect(colorTokens.length).toBeGreaterThan(20);
  expect(colorNames(dark), 'dark color tokens').toEqual(colorTokens);
  expect([...dark.keys()].filter(name => !light.has(name)), 'tokens only dark defines').toEqual([]);
  expect(source).toContain('color-scheme: light dark');
});

it.each([['light', light], ['dark', dark]] as const)('keeps %s text readable on every surface (WCAG AA)', (_appearance, tokens) => {
  for (const text of texts) for (const surface of surfaces) {
    expect(contrast(tokens.get(text)!, tokens.get(surface)!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(tokens.get('--ui-on-accent')!, tokens.get('--ui-accent')!)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens.get('--ui-on-attention')!, tokens.get('--ui-status-attention')!)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens.get('--ui-on-failure')!, tokens.get('--ui-status-failure')!), 'failure ink on failure fill').toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens.get('--ui-code-text')!, tokens.get('--ui-code-background')!), 'code text on code background').toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens.get('--ui-label')!, tokens.get('--ui-segment-selected')!), 'label on the selected segment').toBeGreaterThanOrEqual(4.5);
  // The Send button and the Session View's --agent-on-signal set the surface color on the action fill, --ui-accent-text.
  expect(contrast(tokens.get('--ui-background')!, tokens.get('--ui-accent-text')!), 'surface ink on the action fill').toBeGreaterThanOrEqual(4.5);
  // app.css mixes --agent-setting-pending-surface from the attention color at 8% over --obs-surface, which is --ui-background.
  const pending = mix(tokens.get('--ui-status-attention')!, tokens.get('--ui-background')!, 0.08);
  expect(contrast(tokens.get('--ui-status-attention')!, pending), `attention text on the pending-setting surface ${pending}`).toBeGreaterThanOrEqual(4.5);
  for (const surface of ['--ui-background', '--ui-background-grouped', '--ui-sidebar']) {
    expect(contrast(tokens.get('--ui-control-border')!, tokens.get(surface)!), `control border on ${surface}`).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens.get('--ui-focus-ring')!, tokens.get(surface)!), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3);
  }
});

it('turns motion off when the system asks for reduced motion', () => {
  const reduced = block(reducedAt, source.length);
  expect(Object.fromEntries(reduced)).toMatchObject({ '--ui-duration-short': '0ms', '--ui-duration': '0ms' });
});

const app = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../../agent-remote-web/src/styles.css', import.meta.url), 'utf8');

/** The app.css text from `opening` up to the first `}` after it; throws when either is missing. */
function appRule(opening: string): string {
  const start = app.indexOf(opening);
  if (start < 0) throw new Error(`app.css has no "${opening}"`);
  const end = app.indexOf('}', start);
  if (end < 0) throw new Error(`app.css has no "}" after "${opening}"`);
  return app.slice(start, end);
}

it('maps the Lab variables and the Session View code colors onto the tokens', () => {
  const lab = [...appRule(':root {').matchAll(/(--obs-[\w-]+)\s*:\s*([^;]+);/g)];
  expect(lab.length, '--obs-* variables in the app.css :root block').toBeGreaterThanOrEqual(20);
  for (const [, name, value] of lab) {
    expect(value!.trim(), name).toMatch(/^var\(--ui-[\w-]+\)$|^color-mix\(in \w+, var\(--[\w-]+\) \d+%, var\(--[\w-]+\)\)$/);
  }
  const mapping = appRule('.lab-shell, .lab-session-view, .agent-image-preview, .agent-preview-browser {');
  for (const name of ['--agent-panel-raised', '--agent-code-block-background', '--agent-code-block-text', '--agent-code-background', '--agent-overlay-shadow',
    '--agent-shadow-ink', '--agent-backdrop', '--agent-running']) {
    expect(mapping, name).toMatch(new RegExp(`${name}\\s*:\\s*var\\(--ui-`));
  }
  // The pairs the WCAG test checks as the surface ink on the action fill and as the pending-setting surface.
  expect(appRule(':root {')).toContain('--obs-surface: var(--ui-background);');
  expect(appRule(':root {')).toContain('--obs-action: var(--ui-accent-text);');
  expect(mapping).toContain('--agent-signal: var(--obs-action);');
  expect(mapping).toContain('--agent-on-signal: var(--obs-surface);');
  expect(mapping).toContain('--agent-setting-pending-surface: color-mix(in srgb, var(--ui-status-attention) 8%, var(--obs-surface));');
  expect(shared).toMatch(/\.agent-markdown pre \{[^}]*background: var\(--agent-code-block-background\)/);
  expect(shared).toMatch(/\.agent-markdown pre \{[^}]*color: var\(--agent-code-block-text\)/);
});

it('gives the browser a theme color and color scheme for each appearance', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />');
  expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1e" />');
  expect(html).toContain('<meta name="color-scheme" content="light dark" />');
  const manifest = JSON.parse(readFileSync(new URL('../../public/app/manifest.webmanifest', import.meta.url), 'utf8')) as Record<string, unknown>;
  expect(manifest).toMatchObject({ background_color: '#ffffff', theme_color: '#ffffff' });
});
