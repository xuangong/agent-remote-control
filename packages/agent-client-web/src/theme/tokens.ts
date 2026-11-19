/**
 * The Orchard design tokens as data: colours for both themes, radii, space, type, elevation, motion and breakpoints.
 * theme.css is generated from these values by renderThemeCss(), and the contrast rules, the avatar palette and the
 * manifest colours are checked against the same values. Pure: no DOM, clock or imports, so Node can run it with its
 * types stripped (`theme:write`).
 */

export type ThemeName = 'light' | 'dark';
/** A colour for each theme: `#rrggbb`, or `rgb(r g b / a)` for a translucent one. */
export interface ThemedColor { readonly light: string; readonly dark: string }

const both = (value: string): ThemedColor => ({ light: value, dark: value });

export const orchardColors = {
  /** The warm ground the panels float on. */
  ground: { light: '#f3efe9', dark: '#151517' },
  /** Panels, and the surround of the selected segment. */
  surface: { light: '#ffffff', dark: '#232327' },
  /** Their bubble, chips, grouped rows, the composer and the segmented track. */
  fill: { light: '#f4f4f6', dark: '#2f2f34' },
  /** Pressed and hovered fills, and the toggle's off track. */
  'fill-strong': { light: '#e8e8ec', dark: '#3b3b41' },
  /** A light tint of the brand: the selected assistant, the name card, the approval card. */
  tint: { light: '#fff1e6', dark: '#3a2d24' },
  text: { light: '#2a2b30', dark: '#dcdde2' },
  'text-strong': { light: '#1d1d1f', dark: '#f2f2f5' },
  /** Status sentences, times, the work-summary line and labels: the one secondary grey, AA on every surface it sits on. */
  'text-secondary': { light: '#696d75', dark: '#9a9da4' },
  /** Non-text marks only (list markers, the composer's + glyph, separators' ink): below text contrast. */
  'ink-faint': { light: '#a0a3aa', dark: '#6a6d74' },
  /** The user's bubble. */
  mine: { light: '#2a2b30', dark: '#f2f2f4' },
  'on-mine': { light: '#ffffff', dark: '#1d1d20' },
  /** The primary action, a toggle that is on, the selected mode, the unread dot and send. */
  brand: both('#ff7f45'),
  /** Ink on a brand fill: white is 2.5:1 on the orange, this dark ink 6.7:1. */
  'on-brand': both('#1d1d1f'),
  focus: { light: '#d9581c', dark: '#ff7f45' },
  'danger-text': { light: '#c4321f', dark: '#ff7a6b' },
  /** The machine's online dot (non-text). */
  online: both('#39b56a'),
  separator: { light: 'rgb(0 0 0 / 0.06)', dark: 'rgb(255 255 255 / 0.07)' },
  /** Elevation only: shadows mix from it, never from a text colour. */
  'shadow-ink': { light: 'rgb(20 20 30 / 0.14)', dark: 'rgb(0 0 0 / 0.5)' },
  backdrop: { light: 'rgb(0 0 0 / 0.25)', dark: 'rgb(0 0 0 / 0.5)' },
  /** A resting avatar's fill; the dark value is lifted from the mockup's #55575d so the eyes keep 3:1 on it. */
  'avatar-resting': { light: '#c9cbd0', dark: '#66686e' },
  'avatar-eye': both('#16161a'),
  'brand-tile': both('#24242a'),
  'brand-body': both('#ff7f45'),
  'brand-stem': both('#2f8f55'),
  'brand-leaf': both('#4cc27a'),
  'brand-eye': both('#16161a'),
} as const satisfies Record<string, ThemedColor>;
export type OrchardColorName = keyof typeof orchardColors;

/** The mark's colours, the same in both themes; the favicon and icons carry them as literals. */
export const brandColors = {
  tile: orchardColors['brand-tile'].light, body: orchardColors['brand-body'].light, stem: orchardColors['brand-stem'].light,
  leaf: orchardColors['brand-leaf'].light, eye: orchardColors['brand-eye'].light,
} as const;

export type AvatarColorName = 'orange' | 'blue' | 'violet' | 'green' | 'pink' | 'teal' | 'yellow' | 'coral';
export interface AvatarColor { readonly name: AvatarColorName; readonly value: string }
/** The assistants' fills, the same in both themes. The eye reaches 3:1 on each. */
export const avatarPalette: readonly AvatarColor[] = [
  { name: 'orange', value: '#ff8a3d' }, { name: 'blue', value: '#3d8bff' }, { name: 'violet', value: '#8b6cff' },
  { name: 'green', value: '#34b878' }, { name: 'pink', value: '#ff6fa8' }, { name: 'teal', value: '#22b3c2' },
  { name: 'yellow', value: '#f2bf3a' }, { name: 'coral', value: '#ff6b5e' },
];

/** Pixels. The mark's tile corner is 15/64 of its size (mark.ts). */
export const orchardRadii = {
  panel: 22, bubble: 20, 'bubble-tail': 6, card: 18, row: 18, group: 16, composer: 24, toggle: 10, pill: 999,
} as const;
/** Pixels: `l` is the gap between panels, `xl` between messages, `2xl` a panel's padding, `3xl` the conversation column's. */
export const orchardSpace = { '2xs': 2, xs: 4, s: 6, m: 8, l: 10, xl: 14, '2xl': 16, '3xl': 24, '4xl': 32, column: 580 } as const;

export interface TypeStep { readonly size: number; readonly leading: number; readonly weight: number }
export const orchardType = {
  caption: { size: 11.5, leading: 1.4, weight: 400 },
  footnote: { size: 12.5, leading: 1.5, weight: 400 },
  callout: { size: 13, leading: 1.5, weight: 400 },
  body: { size: 14.5, leading: 1.6, weight: 400 },
  headline: { size: 15, leading: 1.4, weight: 600 },
  title: { size: 18, leading: 1.3, weight: 700 },
  'large-title': { size: 26, leading: 1.2, weight: 700 },
  wordmark: { size: 17, leading: 1, weight: 750 },
} as const satisfies Record<string, TypeStep>;
export const orchardFonts = {
  text: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif',
  /** The wordmark's stack. No font is bundled: SF Pro is licensed for Apple platforms only. */
  rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Shadows over `shadow-ink`; panels on the ground are flat. */
export const orchardElevation = {
  flat: 'none',
  popover: '0 8px 24px var(--orchard-shadow-ink)',
  lifted: '0 -8px 32px var(--orchard-shadow-ink)',
  floating: '0 20px 48px var(--orchard-shadow-ink)',
} as const;

/** Durations in milliseconds and easings. An avatar's outline cycle is chosen per assistant in `outline`. */
export const orchardMotion = {
  durations: { fast: 150, base: 220, pop: 360, bob: 2400, glance: 5000, sway: 3200 },
  outline: { min: 5000, max: 7000 },
  easings: { standard: 'cubic-bezier(0.2, 0.8, 0.2, 1)', flow: 'cubic-bezier(0.45, 0, 0.55, 1)' },
  /** The flow easing as SMIL keySplines. */
  flowSpline: '.45 0 .55 1',
} as const;

/** Viewport widths in pixels at or below which a layout applies; written into primitive media queries, not variables. */
export const orchardBreakpoints = { phone: 760, compact: 1180 } as const;

/** Text pairs the theme promises: [text, surface, minimum ratio]. The contrast test reads this. */
export const textPairs: readonly (readonly [OrchardColorName, OrchardColorName, 4.5 | 3])[] = [
  ...(['ground', 'surface', 'fill', 'fill-strong', 'tint'] as const).flatMap(surface => [
    ['text', surface, 4.5] as const, ['text-strong', surface, 4.5] as const]),
  ...(['ground', 'surface', 'fill', 'tint'] as const).map(surface => ['text-secondary', surface, 4.5] as const),
  ...(['surface', 'fill', 'tint'] as const).map(surface => ['danger-text', surface, 4.5] as const),
  ['on-mine', 'mine', 4.5], ['on-brand', 'brand', 4.5],
  ['focus', 'ground', 3], ['focus', 'surface', 3],
];

type Rgba = readonly [number, number, number, number];
function parseColor(color: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map(start => parseInt(hex[1]!.slice(start, start + 2), 16)).concat(1) as unknown as Rgba;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`${color} is neither #rrggbb nor rgb(r g b / a)`);
}
function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** `top` painted over an opaque `bottom`, as sRGB channels. */
export function composite(top: string, bottom: string): string {
  const [r, g, b, a] = parseColor(top);
  const under = parseColor(bottom);
  if (under[3] !== 1) throw new Error(`${bottom} is not opaque`);
  return `#${[r, g, b].map((value, index) => Math.round(value * a + under[index]! * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}
/** The WCAG 2.x contrast ratio of `a` over `b`; a translucent `a` is composited over `b`, which must be opaque. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(parseColor(composite(a, b))), luminance(parseColor(b))].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const px = (value: number) => `${value}px`;
/** The exact text of theme.css. */
export function renderThemeCss(): string {
  const declarations = [
    ...Object.entries(orchardColors).map(([name, { light, dark }]) =>
      `--orchard-${name}: light-dark(${light}, ${dark});`),
    ...Object.entries(orchardRadii).map(([name, value]) => `--orchard-radius-${name}: ${px(value)};`),
    ...Object.entries(orchardSpace).map(([name, value]) => `--orchard-space-${name}: ${px(value)};`),
    ...Object.entries(orchardFonts).map(([name, value]) => `--orchard-font-${name}: ${value};`),
    ...Object.entries(orchardType).flatMap(([name, step]) => [
      `--orchard-type-${name}-size: ${px(step.size)};`, `--orchard-type-${name}-leading: ${step.leading};`, `--orchard-type-${name}-weight: ${step.weight};`]),
    ...Object.entries(orchardElevation).map(([name, value]) => `--orchard-elevation-${name}: ${value};`),
    ...Object.entries(orchardMotion.durations).map(([name, value]) => `--orchard-duration-${name}: ${value}ms;`),
    ...Object.entries(orchardMotion.easings).map(([name, value]) => `--orchard-ease-${name}: ${value};`),
  ];
  const reduced = Object.keys(orchardMotion.durations).map(name => `--orchard-duration-${name}: 0ms;`);
  return [
    '/* Generated from tokens.ts by renderThemeCss(); edit tokens.ts and run `pnpm --filter @orchardworks/agent-client-web theme:write`. */',
    '/* Colours are light-dark() pairs: the page follows the system, and data-theme on the root pins one theme. */',
    ':root {',
    '  color-scheme: light dark;',
    ...declarations.map(line => `  ${line}`),
    '}',
    ':root[data-theme="light"] { color-scheme: light; }',
    ':root[data-theme="dark"] { color-scheme: dark; }',
    '@media (prefers-reduced-motion: reduce) {',
    `  :root { ${reduced.join(' ')} }`,
    '}',
    '',
  ].join('\n');
}
