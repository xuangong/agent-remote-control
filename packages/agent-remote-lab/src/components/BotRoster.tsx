import type { ReactNode } from 'react';
import type { WindowBotDetails, WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import type { BotRosterModel, BotRow, BotSection } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { sessionKey } from '../session-tree.js';
import { Avatar } from '../ui/Avatar.js';
import { Icon } from '../ui/Icon.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';

/** The name a bot is known by; its avatar letter comes from here. A label or role never replaces it. */
export function botDisplayName(binding: WindowSessionBinding): string {
  return binding.title || binding.nativeSessionId;
}
export function BotPicture({ picture, name, size = 26 }: Pick<WindowBotDetails, 'picture'> & { name: string; size?: number }) {
  return <Avatar name={name} picture={picture} size={size} />;
}
export function botPlaceKey(place: BotPlace): string {
  return place.kind === 'bot' ? JSON.stringify([place.groupId, place.viewId]) : place.kind === 'session' ? sessionKey(place.session) : place.groupId;
}

function BotMember({ row, current, compact, hostName, onSelect }: { row: BotRow; current: boolean; compact: boolean; hostName(hostId: string): string; onSelect(place: BotPlace): void }) {
  const name = botDisplayName(row.binding), destination: BotPlace = { kind: 'bot', groupId: row.groupId, viewId: row.viewId };
  // The role and label are tags beside the name, like a job title; screen readers hear them after the name.
  const description = [row.role, row.details.label, row.status].filter(Boolean).join(' · ');
  return <div className="lab-bot-member">
    <button type="button" className="lab-bot-row" aria-label={name} aria-description={description || undefined}
      title={`${hostName(row.binding.hostId)} · ${row.binding.providerId}`}
      data-bot-place={botPlaceKey(destination)} aria-current={current || undefined} onClick={() => onSelect(destination)}>
      <BotPicture picture={row.details.picture} name={name} size={compact ? 36 : 26} />
      <span className="lab-bot-row-text">
        <span className="lab-bot-name-line"><strong className="lab-bot-name">{name}</strong>
          {row.role ? <span className="lab-bot-role">{row.role}</span> : null}
          {row.details.label ? <span className="lab-bot-label">{row.details.label}</span> : null}</span>
        {row.status ? <span className="lab-bot-status" data-attention={row.status === 'Needs you' || undefined} data-failed={row.status === 'Failed' || undefined}>{row.status}</span> : null}
      </span>
      {row.details.pinned ? <span className="lab-bot-pinned" aria-label="Pinned">⌖</span> : null}
    </button>
    {row.asks.length ? <ul className="lab-bot-asks" data-bot-asks={row.viewId} aria-label={`Asks of ${name}`}>
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
  return <nav aria-label="Bots" className="lab-bot-roster-list">
    {model.sections.map(section => <section key={section.groupId} className="lab-bot-section" aria-labelledby={`bot-section-${section.groupId}`}>
      <div className="lab-bot-section-head">
        <h2 id={`bot-section-${section.groupId}`}><button type="button" onClick={() => onSelect({ kind: 'section', groupId: section.groupId })}>{section.title}</button>
          {section.status ? <small>{section.status}</small> : null}</h2>
        {groupActions ? <Menu label={`Group actions: ${section.title}`} items={groupActions(section)} /> : null}
      </div>
      {!section.rows.length ? <p className="lab-bot-empty">{section.hidden.length ? 'Its bots are hidden in Bot mode.' : 'No bots in this group yet.'}</p> : null}
      {section.rows.map(row => <BotMember key={row.viewId} row={row} compact={compact} hostName={hostName} onSelect={onSelect}
        current={place?.kind === 'bot' && place.groupId === row.groupId && place.viewId === row.viewId} />)}
    </section>)}
    <details className="lab-bot-section lab-bot-other">
      <summary><h2>Other sessions</h2></summary>
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
