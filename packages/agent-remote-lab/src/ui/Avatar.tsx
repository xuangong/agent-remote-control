import type { CSSProperties } from 'react';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';

/**
 * Fallback colors for a bot without a stored picture. The letter ink is chosen per color by readableOn,
 * so any stored color stays readable; these are simply the palette a missing picture is drawn from.
 */
export const AVATAR_COLORS = ['#0071e3', '#8944ab', '#c93400', '#1a7431', '#d70015', '#0071a4', '#a05a00', '#636366'] as const;

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/** The ink for a `#rrggbb` background: white when it reaches 4.5:1 against white, otherwise the dark label ink. */
export function readableOn(hex: string): 'light' | 'dark' {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05) >= 4.5 ? 'light' : 'dark';
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

/** The first letter or number of a name, as one upper-cased grapheme; empty when the name has none. */
export function avatarInitial(name: string): string {
  const parts = graphemes ? [...graphemes.segment(name)].map(part => part.segment) : [...name];
  const first = parts.find(part => /[\p{L}\p{N}]/u.test(part));
  if (!first) return '';
  const upper = first.toUpperCase();
  return [...upper].length === 1 ? upper : first;
}

/** A bot's picture: its stored shape and color with the first letter of its name. */
export function Avatar({ name, picture, size = 28 }: { name: string; picture?: WindowBotDetails['picture']; size?: number }) {
  const color = picture?.color && /^#[0-9a-f]{6}$/i.test(picture.color) ? picture.color.toLowerCase() : avatarColor(name);
  return <span aria-hidden="true" className="ui-avatar" data-shape={picture?.shape ?? 'circle'} data-ink={readableOn(color)}
    style={{ '--ui-avatar-color': color, '--ui-avatar-size': `${size}px` } as CSSProperties}>{avatarInitial(name)}</span>;
}
