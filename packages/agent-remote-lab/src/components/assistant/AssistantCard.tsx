import { useState } from 'react';
import type { BotPicture } from '@orchardworks/agent-remote-protocol';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { MenuEntry } from '../../ui/Menu.js';
import { Icon } from '../../ui/Icon.js';
import { AvatarPicker } from './AvatarPicker.js';

/**
 * The assistant's name card: its avatar (which opens the picker when the avatar can change), its name, label and role, then
 * the actions its place owns (Label…, Sleep or Wake, Hide in Bot mode, Remove from group…, Pin to a window or Open in Bot mode).
 */
export function AssistantCard({ id, picture, name, label, role, mood = 'idle', actions = [], setPicture }: {
  id: string; picture?: BotPicture; name: string; label?: string; role?: string; mood?: AvatarMood;
  actions?: readonly MenuEntry[]; setPicture?(picture: BotPicture): void;
}) {
  const t = useTranslate();
  const [picking, setPicking] = useState(false);
  const avatar = <AssistantAvatar id={id} {...(picture ? { picture } : {})} size={72} mood={mood} />;
  const buttons = actions.flatMap(entry => 'label' in entry ? [entry] : []);
  return <div className="lab-assistant-card orchard-card" data-tone="tint">
    {setPicture ? <button type="button" className="lab-assistant-card-avatar" aria-label={t('card.avatar')} aria-expanded={picking} onClick={() => setPicking(open => !open)}>{avatar}</button>
      : <span className="lab-assistant-card-avatar">{avatar}</span>}
    {picking && setPicture ? <AvatarPicker id={id} {...(picture ? { picture } : {})} onChange={setPicture} /> : null}
    <p className="lab-assistant-card-name">{name}</p>
    {role || label ? <p className="lab-assistant-card-tags">{role ? <span className="lab-bot-role">{role}</span> : null}{label ? <span className="lab-bot-label">{label}</span> : null}</p>
      : <p className="lab-assistant-card-role">{t('details.yourAssistant')}</p>}
    {buttons.length ? <div className="lab-assistant-card-actions">
      {buttons.map(entry => <button key={entry.label} type="button" className="lab-assistant-action" data-destructive={entry.destructive || undefined} disabled={entry.disabled}
        onClick={entry.onSelect}>{entry.icon ? <Icon name={entry.icon} size={16} /> : null}<span>{entry.label}</span></button>)}
    </div> : null}
  </div>;
}
