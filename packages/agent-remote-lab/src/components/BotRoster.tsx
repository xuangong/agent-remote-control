import type { CSSProperties, ReactNode } from 'react';
import type { WindowBotDetails } from '@orchardworks/agent-remote-protocol';
import type { BotRosterModel } from '../bot-roster.js';
import type { BotPlace } from '../workbench-mode.js';
import { sessionKey } from '../session-tree.js';

export function BotPicture({ picture }: Pick<WindowBotDetails, 'picture'>) {
  const color = picture?.color && /^#[0-9a-f]{6}$/.test(picture.color) ? picture.color : undefined;
  return <span aria-hidden="true" className="lab-bot-picture" data-shape={picture?.shape ?? 'circle'}
    style={color ? { '--bot-picture-color': color } as CSSProperties : undefined} />;
}
export function botPlaceKey(place: BotPlace): string {
  return place.kind === 'bot' ? JSON.stringify([place.groupId, place.viewId]) : place.kind === 'session' ? sessionKey(place.session) : place.groupId;
}
export function BotRoster({ model, place, onSelect, onNewSection, directoryControls }: {
  model: BotRosterModel; place?: BotPlace; onSelect(place: BotPlace): void; onNewSection(): void; directoryControls: ReactNode;
}) {
  return <nav aria-label="Bots" className="lab-bot-roster-list">
    <div className="lab-bot-roster-actions"><button type="button" onClick={onNewSection}>New section</button></div>
    {model.sections.map(section => <section key={section.groupId} className="lab-bot-section" aria-labelledby={`bot-section-${section.groupId}`}>
      <h2 id={`bot-section-${section.groupId}`}><button type="button" onClick={() => onSelect({ kind: 'section', groupId: section.groupId })}>{section.title}</button>
        {section.status ? <small>{section.status}</small> : null}</h2>
      {!section.rows.length ? <p className="lab-bot-empty">No bots in this section yet. Organize sessions in a Window, then choose Show as section.</p> : null}
      {section.rows.map(row => {
        const destination: BotPlace = { kind: 'bot', groupId: row.groupId, viewId: row.viewId };
        return <button key={row.viewId} type="button" className="lab-bot-row" aria-label={row.binding.title || row.binding.nativeSessionId}
          data-bot-place={botPlaceKey(destination)} aria-current={place?.kind === 'bot' && place.groupId === row.groupId && place.viewId === row.viewId || undefined}
          onClick={() => onSelect(destination)}>
          <BotPicture picture={row.details.picture} /><span className="lab-bot-row-text"><strong>{row.binding.title || row.binding.nativeSessionId}</strong>
            {row.details.label ? <span>{row.details.label}</span> : null}<small>{row.binding.hostId} · {row.binding.providerId}</small>
            {row.status ? <span className="lab-bot-status">{row.status}</span> : null}</span>
          {row.details.pinned ? <span className="lab-bot-pinned" aria-label="Pinned">⌖</span> : null}
        </button>;
      })}
    </section>)}
    <section className="lab-bot-section lab-bot-other"><h2>Other sessions</h2>
      {model.other.map(session => { const destination: BotPlace = { kind: 'session', session }; return <button key={sessionKey(session)} type="button" className="lab-bot-row"
        aria-label={`${session.title || session.nativeSessionId} · ${session.hostId ?? 'local'} · ${session.providerId}`}
        data-bot-place={botPlaceKey(destination)} aria-current={place?.kind === 'session' && sessionKey(place.session) === sessionKey(session) || undefined} onClick={() => onSelect(destination)}>
        <span className="lab-bot-row-text"><strong>{session.title || session.nativeSessionId}</strong><small>{session.hostId ?? 'local'} · {session.providerId}</small></span>
      </button>; })}
      {directoryControls}
    </section>
  </nav>;
}
