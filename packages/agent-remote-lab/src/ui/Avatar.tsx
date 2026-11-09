import type { CSSProperties } from 'react';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';

/** Colors that keep a white letter readable (contrast of at least 4.5:1). */
export const AVATAR_COLORS = ['#0071e3', '#8944ab', '#c93400', '#1a7431', '#d70015', '#0071a4', '#a05a00', '#636366'] as const;

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

/** A bot's picture: its stored shape and color with the first letter of its name. */
export function Avatar({ name, picture, size = 28 }: { name: string; picture?: WindowBotDetails['picture']; size?: number }) {
  const color = picture?.color && /^#[0-9a-f]{6}$/.test(picture.color) ? picture.color : avatarColor(name);
  const initial = [...name.trim()][0]?.toUpperCase() ?? '';
  return <span aria-hidden="true" className="ui-avatar" data-shape={picture?.shape ?? 'circle'}
    style={{ '--ui-avatar-color': color, '--ui-avatar-size': `${size}px` } as CSSProperties}>{initial}</span>;
}
