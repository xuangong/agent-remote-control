import { useContext, type ReactNode } from 'react';
import type { WindowGroup, WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { BotPicture } from '../../kernel/BotPicture.js';
import type { BotRosterModel, BotRow } from '../../kernel/bot-roster.js';
import { groupSections, showsGroupHeadings } from '../../kernel/assistant-groups.js';
import type { BotPlace } from '../../kernel/workbench-mode.js';
import { sessionKey } from '../../kernel/session-tree.js';
import { Icon } from '../../ui/Icon.js';
import { dateLocale, replyTime } from '../../kernel/reply-time.js';
import { LocaleContext, useTaskDirectory, useTranslate } from '@orchardworks/agent-client-web/react';
import { useChainAlerts } from '../../kernel/chain-alerts.js';
import { contextMenuEvents } from '../../ui/ContextMenu.js';

export function botPlaceKey(place: BotPlace): string {
  return place.kind === 'bot' ? JSON.stringify([place.groupId, place.viewId]) : place.kind === 'session' ? sessionKey(place.session) : place.groupId;
}

/** One assistant as a row: avatar, name with its tags, one sentence. The directory adds its marks and action beside it. */
export function BotMember({ row, current, compact, hostName, onSelect, marks, extra, menu }: { row: BotRow; current: boolean; compact: boolean; hostName(hostId: string): string; onSelect(place: BotPlace): void;
  /** Words beside the name, such as Hidden in Chats. */ marks?: ReactNode; /** A control after the row, such as Show in Chats. */ extra?: ReactNode;
  /** Opens the row's context menu: at the pointer for a right-click, beside the row for Shift-F10 or the context menu key. */
  menu?(anchor: HTMLElement, point?: { x: number; y: number }): void }) {
  const t = useTranslate();
  const directory = useTaskDirectory();
  const name = row.name, destination: BotPlace = { kind: 'bot', groupId: row.groupId, viewId: row.viewId };
  const locale = useContext(LocaleContext);
  const chainAlerts = useChainAlerts();
  const time = row.reply ? replyTime(row.reply.replyAt, undefined, dateLocale(locale), t) : undefined;
  // Like a chat list, an unsent draft shows where the latest reply would; the bot on screen has it in its composer.
  const draft = !current && row.draft ? row.draft.replace(/\s+/g, ' ').trim() : undefined;
  // The sentence says what the assistant is doing; a draft takes the place of a quiet one (its latest reply, or ready).
  const quiet = row.assistant.state === 'idle' || row.assistant.state === 'unknown';
  // Needs you is not unread: it asks for the owner, so its dot is distinct and mute never quiets it.
  const needsYou = row.assistant.state === 'needs_you' || !!row.staffNeedsYou || (!!row.details.botId && chainAlerts.some(alert => alert.bot === row.details.botId));
  // A quiet bot that keeps a board shows where its work stands (bots design 10): its latest open item and status.
  const work = quiet ? directory?.board?.(row.session).find(item => item.status !== 'done' && item.status !== 'cancelled') : undefined;
  const sentence = draft && quiet ? undefined : (work ? `${work.title} · ${t(`details.boardStatus.${work.status}`)}` : row.assistant.sentence) || undefined;
  // The role and label are tags beside the name, like a job title; screen readers hear them after the name.
  const staffOf = row.chief ? t('assistants.staffOf', { name: row.chief }) : undefined;
  const description = [row.role, row.details.label, staffOf, sentence, draft ? `${t('assistants.draft')}: ${draft}` : undefined, row.unread ? t('assistants.unread') : undefined,
    row.details.pinned ? t('assistants.pinned') : undefined, row.muted ? t('assistants.muted') : undefined, time].filter(Boolean).join(' · ');
  const menuEvents = menu ? contextMenuEvents(({ target, point }) => {
    const anchor = target.closest<HTMLElement>('.lab-bot-row');
    if (!anchor) return false;
    menu(anchor, point); return true;
  }) : undefined;
  return <div className="lab-bot-member">
    <button type="button" className="lab-bot-row" aria-label={name} aria-description={description || undefined} {...menuEvents}
      title={`${hostName(row.binding.hostId)} · ${row.binding.providerId}`} data-state={row.assistant.state}
      data-bot-place={botPlaceKey(destination)} data-asleep={row.details.asleep || undefined} data-unread={row.unread || undefined} data-needs-you={needsYou || undefined} data-muted={row.muted || undefined} aria-current={current || undefined} onClick={() => onSelect(destination)}>
      <BotPicture id={row.viewId} picture={row.details.picture} size={compact ? 44 : 40} mood={row.assistant.mood} />
      <span className="lab-bot-row-text">
        <span className="lab-bot-name-line"><strong className="lab-bot-name">{name}</strong>
          {row.role ? <span className="lab-bot-role">{row.role}</span> : null}
          {row.details.label ? <span className="lab-bot-label">{row.details.label}</span> : null}
          {staffOf ? <span className="lab-bot-label" data-chief>{staffOf}</span> : null}
          {marks}
          {row.muted ? <span className="lab-bot-muted" aria-hidden="true"><Icon name="bell-off" size={13} /></span> : null}
          {time ? <span className="lab-bot-time" aria-hidden="true">{time}</span> : null}</span>
        {/* One sentence of what the assistant is doing; an unread reply is a dot, never a number, and needs you a ringed dot in its place. */}
        {sentence || draft || row.unread || needsYou ? <span className="lab-bot-summary" aria-hidden="true">
          {sentence ? <span className="lab-bot-sentence" data-state={row.assistant.state}>{sentence}</span> : null}
          {draft ? <span className="lab-bot-draft"><span className="lab-bot-draft-label">{t('assistants.draft')}</span>{draft}</span> : null}
          {needsYou ? <span className="lab-bot-needs-you" /> : row.unread ? <span className="lab-bot-unread" /> : null}
        </span> : null}
      </span>
      {row.details.pinned ? <span className="lab-bot-pinned" role="img" aria-label={t('assistants.pinned')}><Icon name="pin" size={14} /></span> : null}
    </button>
    {extra}
    {row.asks.length ? <ul className="lab-bot-asks" data-bot-asks={row.viewId} aria-label={t('assistants.asks', { name })}>
      {/* An Ask opens inside its bot's conversation. */}
      {row.asks.map(ask => <li key={ask.viewId}><button type="button" className="lab-bot-ask" onClick={() => onSelect(destination)}>
        <Icon name="question" size={14} /><span>{ask.title}</span></button></li>)}
    </ul> : null}
  </div>;
}

/**
 * Chats: the assistants Bot mode shows, by group in the groups' order with the default group last, each group by activity
 * (pinned first, then by latest reply); no headings while the default group is all there is. Then Other sessions.
 */
export function BotRoster({ model, groups, place, onSelect, directoryControls, hostName = id => id, compact = false, menu }: {
  model: BotRosterModel; groups: readonly WindowGroup[]; place?: BotPlace; onSelect(place: BotPlace): void; directoryControls: ReactNode;
  /** Opens an assistant's context menu (pin, mute, rename, move). */
  menu?(row: BotRow, anchor: HTMLElement, point?: { x: number; y: number }): void;
  /** A phone's roster: larger pictures and taller rows, as in a native chat list. */
  compact?: boolean;
  /** A Host's display name for a Host ID; rows show names, never raw IDs. */
  hostName?(hostId: string): string;
}) {
  const t = useTranslate();
  const sections = groupSections(model, groups, { order: 'activity', defaultTitle: t('navigation.groups.default') });
  const headings = showsGroupHeadings(sections);
  const member = (row: BotRow) => <BotMember key={`${row.groupId}/${row.viewId}`} row={row} compact={compact} hostName={hostName} onSelect={onSelect}
    current={place?.kind === 'bot' && place.groupId === row.groupId && place.viewId === row.viewId} {...(menu ? { menu: (anchor, point) => menu(row, anchor, point) } : {})} />;
  return <nav aria-label={t('navigation.chats')} className="lab-bot-roster-list">
    {!sections.length ? <p className="lab-bot-empty">{t('navigation.chatsEmpty')}</p>
      : headings ? sections.map(section => { const key = section.groupId ?? 'default';
        return <section key={key} className="lab-bot-chats lab-chat-group" aria-labelledby={`chat-group-${key}`} data-chat-group={key} data-muted={section.muted || undefined}>
          <h2 id={`chat-group-${key}`} className="lab-chat-group-title"><span>{section.title}</span>
            {section.muted ? <span className="lab-bot-muted" role="img" aria-label={t('navigation.groups.muted')}><Icon name="bell-off" size={13} /></span> : null}</h2>
          {section.rows.map(member)}
        </section>; })
      : <div className="lab-bot-chats">{sections[0]!.rows.map(member)}</div>}
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
