import type { BotPicture } from '@orchardworks/agent-remote-protocol';
import { avatarGazes, avatarShapeNames, avatarWith, type AvatarGaze, type AvatarShape } from '@orchardworks/agent-client-web/theme';
import { avatarPalette } from '@orchardworks/agent-client-web/theme';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';

const GAZES: Readonly<Record<AvatarGaze, 'upLeft' | 'upRight' | 'left' | 'right' | 'downLeft' | 'downRight'>> = { 0: 'upLeft', 1: 'upRight', 2: 'left', 3: 'right', 4: 'downLeft', 5: 'downRight' };

/**
 * Changes an assistant's avatar: one of the four shapes, one of the eight colours (the 32 pairs) and one of the six gazes.
 * Each choice keeps the others; the avatar's outline and phase still come from its id.
 */
export function AvatarPicker({ id, picture, onChange }: { id: string; picture?: BotPicture; onChange(picture: BotPicture): void }) {
  const t = useTranslate();
  const current = avatarWith(id, picture);
  const choose = (change: Partial<{ shape: AvatarShape; color: string; gaze: AvatarGaze }>) => onChange({ shape: current.shape, color: current.color, gaze: current.gaze, ...change });
  return <div className="lab-avatar-picker">
    <fieldset><legend>{t('card.shape')}</legend>
      {avatarShapeNames.map(shape => <button key={shape} type="button" aria-pressed={shape === current.shape} aria-label={t(`card.shape.${shape}`)}
        onClick={() => choose({ shape })}><AssistantAvatar id={id} picture={{ shape, color: current.color, gaze: current.gaze }} size={28} /></button>)}
    </fieldset>
    <fieldset><legend>{t('card.colour')}</legend>
      {avatarPalette.map(color => <button key={color.value} type="button" aria-pressed={color.value === current.color} aria-label={t(`card.colour.${color.name}` as 'card.colour.orange')}
        onClick={() => choose({ color: color.value })}><span className="lab-avatar-swatch" style={{ background: color.value }} /></button>)}
    </fieldset>
    <fieldset><legend>{t('card.gaze')}</legend>
      {avatarGazes.map(gaze => <button key={gaze} type="button" aria-pressed={gaze === current.gaze} aria-label={t('card.gaze.option', { direction: t(`card.gaze.${GAZES[gaze]}`) })}
        onClick={() => choose({ gaze })}><AssistantAvatar id={id} picture={{ shape: current.shape, color: current.color, gaze }} size={28} /></button>)}
    </fieldset>
  </div>;
}
