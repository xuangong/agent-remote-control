import { useRef, useState } from 'react';
import type { BotPicture } from '@orchardworks/agent-remote-protocol';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Menu, type MenuEntry } from '../../ui/Menu.js';
import { Icon } from '../../ui/Icon.js';
import { AvatarPicker } from './AvatarPicker.js';

export type CardAction = Extract<MenuEntry, { label: string }>;

/**
 * The assistant's name card: its avatar (which opens the picker when the avatar can change), its name, which a click edits
 * where the name can be stored, and one line of its role. One action stands visible (Pin to a workbench, or Open in Bot mode);
 * the others are in the card's ⋯ menu (Label…, Sleep or Wake, Hide in Bot mode, Remove from group…).
 */
export function AssistantCard({ id, picture, name, label, role, mood = 'idle', action, actions = [], setPicture, rename }: {
  id: string; picture?: BotPicture; name: string; label?: string; role?: string; mood?: AvatarMood;
  action?: CardAction; actions?: readonly MenuEntry[]; setPicture?(picture: BotPicture): void; rename?(name: string): void;
}) {
  const t = useTranslate();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const nameButton = useRef<HTMLButtonElement>(null), settled = useRef(false);
  const avatar = <AssistantAvatar id={id} {...(picture ? { picture } : {})} size={72} mood={mood} />;
  function finish(value: string | undefined) {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    if (value !== undefined && value.trim() && value.trim() !== name) rename?.(value.trim());
    queueMicrotask(() => nameButton.current?.focus({ preventScroll: true }));
  }
  return <div className="lab-assistant-card orchard-card" data-tone="tint">
    {setPicture ? <button type="button" className="lab-assistant-card-avatar" aria-label={t('card.avatar')} aria-expanded={picking} onClick={() => setPicking(open => !open)}>{avatar}</button>
      : <span className="lab-assistant-card-avatar">{avatar}</span>}
    {picking && setPicture ? <AvatarPicker id={id} {...(picture ? { picture } : {})} onChange={setPicture} /> : null}
    {editing ? <input className="lab-assistant-card-name" aria-label={t('card.name')} defaultValue={name} maxLength={60} autoFocus
      onFocus={event => event.currentTarget.select()} onBlur={event => finish(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); finish(event.currentTarget.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(undefined); }
      }} />
      : rename ? <button ref={nameButton} type="button" className="lab-assistant-card-name" aria-label={t('card.rename', { name })} title={t('card.rename', { name })}
        onClick={() => { settled.current = false; setEditing(true); }}>{name}</button>
      : <p className="lab-assistant-card-name">{name}</p>}
    <p className="lab-assistant-card-role">{[role, label].filter(Boolean).join(' · ') || t('details.yourAssistant')}</p>
    {action || actions.length ? <div className="lab-assistant-card-actions">
      {action ? <button type="button" className="lab-assistant-action" disabled={action.disabled} onClick={action.onSelect}>
        {action.icon ? <Icon name={action.icon} size={16} /> : null}<span>{action.label}</span></button> : null}
      {actions.length ? <Menu label={t('card.more', { name })} items={actions} /> : null}
    </div> : null}
  </div>;
}
