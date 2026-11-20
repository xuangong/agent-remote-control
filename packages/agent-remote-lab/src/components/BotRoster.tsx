import type { ReactNode } from 'react';
import type { WindowBotDetails, WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';
import type { BotRosterModel, BotRow, BotSection } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { sessionKey } from '../session-tree.js';
import { Icon } from '../ui/Icon.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { replyTime } from '../reply-time.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** The name a bot is known by. A label or role never replaces it. */
export function botDisplayName(binding: WindowSessionBinding): string {
  return binding.title || binding.nativeSessionId;
}
/** A bot's avatar: generated from its view id, which survives a handoff, unless its stored picture overrides it. */
export function BotPicture({ id, picture, size = 26, mood = 'idle' }: Pick<WindowBotDetails, 'picture'> & { id: string; size?: number; mood?: AvatarMood }) {
  return <AssistantAvatar id={id} {...(picture ? { picture } : {})} size={size} mood={mood} />;
}
export function botPlaceKey(place: BotPlace): string {
  return place.kind === 'bot' ? JSON.stringify([place.groupId, place.viewId]) : place.kind === 'session' ? sessionKey(place.session) : place.groupId;
}

function BotMember({ row, current, compact, hostName, onSelect }: { row: BotRow; current: boolean; compact: boolean; hostName(hostId: string): string; onSelect(place: BotPlace): void }) {
  const t = useTranslate();
  const name = botDisplayName(row.binding), destination: BotPlace = { kind: 'bot', groupId: row.groupId, viewId: row.viewId };
  const time = row.reply ? replyTime(row.reply.replyAt) : undefined;
  // Like a chat list, an unsent draft shows where the latest reply would; the bot on screen has it in its composer.
  const draft = !current && row.draft ? row.draft.replace(/\s+/g, ' ').trim() : undefined;
  // The sentence says what the assistant is doing; a draft takes the place of a quiet one (its latest reply, or ready).
  const quiet = row.assistant.state === 'idle' || row.assistant.state === 'unknown';
  const sentence = draft && quiet ? undefined : row.assistant.sentence || undefined;
  // The role and label are tags beside the name, like a job title; screen readers hear them after the name.
  const description = [row.role, row.details.label, sentence, draft ? `${t('assistants.draft')}: ${draft}` : undefined, row.unread ? t('assistants.unread') : undefined, time].filter(Boolean).join(' · ');
  return <div className="lab-bot-member">
    <button type="button" className="lab-bot-row" aria-label={name} aria-description={description || undefined}
      title={`${hostName(row.binding.hostId)} · ${row.binding.providerId}`} data-state={row.assistant.state}
      data-bot-place={botPlaceKey(destination)} data-asleep={row.details.asleep || undefined} data-unread={row.unread || undefined} aria-current={current || undefined} onClick={() => onSelect(destination)}>
      <BotPicture id={row.viewId} picture={row.details.picture} size={compact ? 44 : 40} mood={row.assistant.mood} />
      <span className="lab-bot-row-text">
        <span className="lab-bot-name-line"><strong className="lab-bot-name">{name}</strong>
          {row.role ? <span className="lab-bot-role">{row.role}</span> : null}
          {row.details.label ? <span className="lab-bot-label">{row.details.label}</span> : null}
          {time ? <span className="lab-bot-time" aria-hidden="true">{time}</span> : null}</span>
        {/* One sentence of what the assistant is doing; an unread reply is a dot, never a number. */}
        {sentence || draft || row.unread ? <span className="lab-bot-summary" aria-hidden="true">
          {sentence ? <span className="lab-bot-sentence" data-state={row.assistant.state}>{sentence}</span> : null}
          {draft ? <span className="lab-bot-draft"><span className="lab-bot-draft-label">{t('assistants.draft')}</span>{draft}</span> : null}
          {row.unread ? <span className="lab-bot-unread" /> : null}
        </span> : null}
      </span>
      {row.details.pinned ? <span className="lab-bot-pinned" aria-label={t('assistants.pinned')}>⌖</span> : null}
    </button>
    {row.asks.length ? <ul className="lab-bot-asks" data-bot-asks={row.viewId} aria-label={t('assistants.asks', { name })}>
      {/* An Ask opens inside its bot's conversation. */}
      {row.asks.map(ask => <li key={ask.viewId}><button type="button" className="lab-bot-ask" onClick={() => onSelect(destination)}>
        <Icon name="question" size={14} /><span>{ask.title}</span></button></li>)}
    </ul> : null}
  </div>;
}

export function BotRoster({ model, place, onSelect, directoryControls, hostName = id => id, groupActions, compact = false }: {
  model: BotRosterModel; place?: BotPlace; onSelect(place: BotPlace): void; directoryControls: ReactNode;
  /** A phone's roster: larger pictures and taller rows, as in a native chat list. */
  compact?: boolean;
  /** A Host's display name for a Host ID; rows show names, never raw IDs. */
  hostName?(hostId: string): string;
  /** The actions of a group's header menu, beside its title. */
  groupActions?(section: BotSection): readonly MenuEntry[];
}) {
  const t = useTranslate();
  return <nav aria-label={t('assistants.title')} className="lab-bot-roster-list">
    {model.sections.map(section => <section key={section.groupId} className="lab-bot-section" aria-labelledby={`bot-section-${section.groupId}`}>
      <div className="lab-bot-section-head">
        <h2 id={`bot-section-${section.groupId}`}><button type="button" onClick={() => onSelect({ kind: 'section', groupId: section.groupId })}>{section.title}</button>
          {section.unread ? <span className="lab-bot-section-unread" role="img" aria-label={t('assistants.unread')} /> : null}
</h2>
        {groupActions ? <Menu label={t('assistants.groupActions', { group: section.title })} items={groupActions(section)} /> : null}
      </div>
      {!section.rows.length ? <p className="lab-bot-empty">{section.hidden.length ? t('assistants.hiddenEmpty') : t('assistants.empty')}</p> : null}
      {section.rows.map(row => <BotMember key={row.viewId} row={row} compact={compact} hostName={hostName} onSelect={onSelect}
        current={place?.kind === 'bot' && place.groupId === row.groupId && place.viewId === row.viewId} />)}
    </section>)}
    <details className="lab-bot-section lab-bot-other">
      <summary><h2>{t('assistants.other')}</h2></summary>
      {model.other.map(session => { const destination: BotPlace = { kind: 'session', session }; const host = hostName(session.hostId ?? 'local');
        return <button key={sessionKey(session)} type="button" className="lab-bot-row"
          aria-label={`${session.title || session.nativeSessionId} · ${host} · ${session.providerId}`}
          data-bot-place={botPlaceKey(destination)} aria-current={place?.kind === 'session' && sessionKey(place.session) === sessionKey(session) || undefined} onClick={() => onSelect(destination)}>
          <span className="lab-bot-row-text"><strong>{session.title || session.nativeSessionId}</strong><small>{host} · {session.providerId}</small></span>
        </button>; })}
      {directoryControls}
    </details>
  </nav>;
}
