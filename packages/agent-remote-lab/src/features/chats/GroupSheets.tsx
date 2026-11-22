import { useState } from 'react';
import { SegmentedControl, Sheet, Toggle } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { GroupNotifications } from '../../kernel/assistant-groups.js';
import type { BotRow } from '../../kernel/bot-roster.js';
import { BotPicture } from '../../kernel/BotPicture.js';
import { Button } from '../../ui/Button.js';
import { Icon } from '../../ui/Icon.js';

/** A name, for New group, Rename of a group and Rename of an assistant (`field` and `placeholder`). Saving an unchanged or empty name is not offered. */
export function GroupNameSheet({ title, initial = '', field, placeholder, busy, error, onSave, onClose }: {
  title: string; initial?: string; field?: string; placeholder?: string; busy: boolean; error?: string; onSave(name: string): void; onClose(): void;
}) {
  const t = useTranslate();
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return <Sheet open title={title} detent="content" onClose={() => { if (!busy) onClose(); }}>
    <form className="lab-bot-sheet-form" onSubmit={event => { event.preventDefault(); if (trimmed && trimmed !== initial && !busy) onSave(trimmed); }}>
      <input aria-label={field ?? t('navigation.groups.name')} autoFocus maxLength={256} placeholder={placeholder ?? t('navigation.groups.namePlaceholder')} value={name} disabled={busy}
        onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} />
      {error ? <p className="lab-sheet-message" role="alert">{error}</p> : null}
      <div className="lab-sheet-actions">
        <Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || !trimmed || trimmed === initial} aria-busy={busy || undefined}>{t('common.save')}</Button>
      </div>
    </form>
  </Sheet>;
}

/** A destination of Move to group: a group people made, or the default group (`id` absent). */
export interface GroupChoice { readonly id?: string; readonly title: string }
/** Where an assistant goes: every group, the one it is in marked. Choosing another moves it at once. */
export function MoveToGroupSheet({ name, current, choices, busy, error, onMove, onClose }: {
  name: string; current?: string; choices: readonly GroupChoice[]; busy: boolean; error?: string; onMove(target: string | undefined): void; onClose(): void;
}) {
  const t = useTranslate();
  return <Sheet open title={t('navigation.groups.moveTitle', { name })} detent="content" onClose={() => { if (!busy) onClose(); }}>
    <ul className="lab-group-choices" aria-label={t('navigation.groups.moveTitle', { name })}>
      {choices.map(choice => { const here = choice.id === current;
        return <li key={choice.id ?? 'default'}><button type="button" className="lab-group-choice" aria-current={here || undefined} disabled={busy || here} onClick={() => onMove(choice.id)}>
          <span>{choice.title}</span>{here ? <span className="lab-group-choice-mark"><Icon name="check" size={16} />{t('navigation.groups.current')}</span> : null}
        </button></li>; })}
    </ul>
    {error ? <p className="lab-sheet-message" role="alert">{error}</p> : null}
    <div className="lab-sheet-actions"><Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button></div>
  </Sheet>;
}

/** A group's notifications: muted, or which reminders its assistants send (needs you and finished, or only needs you). */
export function GroupNotificationsSheet({ group, muted, notifications, busy, error, onChange, onClose }: {
  group: string; muted: boolean; notifications: GroupNotifications; busy: boolean; error?: string;
  onChange(settings: { muted: boolean; notifications: GroupNotifications }): void; onClose(): void;
}) {
  const t = useTranslate();
  return <Sheet open title={t('navigation.groups.notificationsTitle', { group })} detent="content" onClose={() => { if (!busy) onClose(); }}>
    <div className="lab-group-settings">
      <Toggle className="lab-group-mute" label={t('navigation.groups.mute')} checked={muted} disabled={busy} onChange={next => onChange({ muted: next, notifications })} />
      {/* The choice is kept while the group is muted and applies again when it is not. */}
      <div className="lab-group-setting"><span>{t('navigation.groups.notifyWhen')}</span>
        <SegmentedControl<GroupNotifications> label={t('navigation.groups.notifyWhen')} value={notifications}
          options={[{ value: 'all', label: t('navigation.groups.notifyAll') }, { value: 'needs_you', label: t('navigation.groups.notifyNeedsYou') }]}
          onChange={next => { if (!busy) onChange({ muted, notifications: next }); }} /></div>
      <p className="lab-sheet-note">{muted ? t('navigation.groups.mutedNote') : t('navigation.groups.notifyHint')}</p>
      {error ? <p className="lab-sheet-message" role="alert">{error}</p> : null}
    </div>
    <div className="lab-sheet-actions"><Button variant="primary" disabled={busy} onClick={onClose}>{t('common.done')}</Button></div>
  </Sheet>;
}

/** Adds assistants of other groups to this one: each choice moves that assistant here. */
export function AddAssistantsSheet({ group, candidates, groupTitle, busy, error, onAdd, onClose }: {
  group: string; candidates: readonly BotRow[]; groupTitle(row: BotRow): string; busy: boolean; error?: string; onAdd(row: BotRow): void; onClose(): void;
}) {
  const t = useTranslate();
  return <Sheet open title={t('navigation.groups.addTitle', { group })} detent="medium" onClose={() => { if (!busy) onClose(); }}>
    {!candidates.length ? <p className="lab-sheet-note">{t('navigation.groups.addEmpty')}</p> : null}
    <ul className="lab-group-choices" aria-label={t('navigation.groups.addTitle', { group })}>
      {candidates.map(row => <li key={`${row.groupId}/${row.viewId}`}><button type="button" className="lab-group-choice" disabled={busy}
        aria-label={t('navigation.groups.addOne', { name: row.name })} onClick={() => onAdd(row)}>
        <BotPicture id={row.viewId} picture={row.details.picture} size={32} mood={row.assistant.mood} />
        <span className="lab-group-choice-text"><strong>{row.name}</strong><small>{groupTitle(row)}</small></span>
        <Icon name="plus" size={18} />
      </button></li>)}
    </ul>
    {error ? <p className="lab-sheet-message" role="alert">{error}</p> : null}
    <div className="lab-sheet-actions"><Button variant="primary" disabled={busy} onClick={onClose}>{t('common.done')}</Button></div>
  </Sheet>;
}
