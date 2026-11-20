import { useContext, type ReactNode } from 'react';
import type { WindowBotDetails, WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { AssistantAvatar } from '@orchardworks/agent-client-web/primitives';
import type { AvatarMood } from '@orchardworks/agent-client-web/theme';
import { projectChats, type BotRosterModel, type BotRow } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { sessionKey } from '../session-tree.js';
import { Icon } from '../ui/Icon.js';
import { dateLocale, replyTime } from '../reply-time.js';
import { LocaleContext, useTranslate } from '@orchardworks/agent-client-web/react';

/** A bot's avatar: generated from its view id, which survives a handoff, unless its stored picture overrides it. */
export function BotPicture({ id, picture, size = 26, mood = 'idle' }: Pick<WindowBotDetails, 'picture'> & { id: string; size?: number; mood?: AvatarMood }) {
  return <AssistantAvatar id={id} {...(picture ? { picture } : {})} size={size} mood={mood} />;
}
export function botPlaceKey(place: BotPlace): string {
  return place.kind === 'bot' ? JSON.stringify([place.groupId, place.viewId]) : place.kind === 'session' ? sessionKey(place.session) : place.groupId;
}

/** One assistant as a row: avatar, name with its tags, one sentence. The directory adds its marks and action beside it. */
export function BotMember({ row, current, compact, hostName, onSelect, marks, extra }: { row: BotRow; current: boolean; compact: boolean; hostName(hostId: string): string; onSelect(place: BotPlace): void;
  /** Words beside the name, such as Hidden in Chats. */ marks?: ReactNode; /** A control after the row, such as Show in Chats. */ extra?: ReactNode }) {
  const t = useTranslate();
  const name = row.name, destination: BotPlace = { kind: 'bot', groupId: row.groupId, viewId: row.viewId };
  const locale = useContext(LocaleContext);
  const time = row.reply ? replyTime(row.reply.replyAt, undefined, dateLocale(locale), t) : undefined;
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
          {marks}
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
    {extra}
    {row.asks.length ? <ul className="lab-bot-asks" data-bot-asks={row.viewId} aria-label={t('assistants.asks', { name })}>
      {/* An Ask opens inside its bot's conversation. */}
      {row.asks.map(ask => <li key={ask.viewId}><button type="button" className="lab-bot-ask" onClick={() => onSelect(destination)}>
        <Icon name="question" size={14} /><span>{ask.title}</span></button></li>)}
    </ul> : null}
  </div>;
}

/** Chats: the assistants Bot mode shows as one list, with no group headings (pinned first, then by latest reply), then Other sessions. */
export function BotRoster({ model, place, onSelect, directoryControls, hostName = id => id, compact = false }: {
  model: BotRosterModel; place?: BotPlace; onSelect(place: BotPlace): void; directoryControls: ReactNode;
  /** A phone's roster: larger pictures and taller rows, as in a native chat list. */
  compact?: boolean;
  /** A Host's display name for a Host ID; rows show names, never raw IDs. */
  hostName?(hostId: string): string;
}) {
  const t = useTranslate();
  const chats = projectChats(model);
  return <nav aria-label={t('navigation.chats')} className="lab-bot-roster-list">
    {chats.rows.length ? <div className="lab-bot-chats">{chats.rows.map(row => <BotMember key={row.viewId} row={row} compact={compact} hostName={hostName} onSelect={onSelect}
      current={place?.kind === 'bot' && place.groupId === row.groupId && place.viewId === row.viewId} />)}</div>
      : <p className="lab-bot-empty">{t('navigation.chatsEmpty')}</p>}
    <details className="lab-bot-section lab-bot-other">
      <summary><h2>{t('assistants.other')}</h2></summary>
      {chats.other.map(session => { const destination: BotPlace = { kind: 'session', session }; const host = hostName(session.hostId ?? 'local');
        return <button key={sessionKey(session)} type="button" className="lab-bot-row"
          aria-label={`${session.title || session.nativeSessionId} · ${host} · ${session.providerId}`}
          data-bot-place={botPlaceKey(destination)} aria-current={place?.kind === 'session' && sessionKey(place.session) === sessionKey(session) || undefined} onClick={() => onSelect(destination)}>
          <span className="lab-bot-row-text"><strong>{session.title || session.nativeSessionId}</strong><small>{host} · {session.providerId}</small></span>
        </button>; })}
      {directoryControls}
    </details>
  </nav>;
}
