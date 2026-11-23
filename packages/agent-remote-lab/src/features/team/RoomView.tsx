import { useState } from 'react';
import './team.css';
import type { Team, TeamAction } from '@orchardworks/agent-remote-protocol';
import { MarkdownContent, useTranslate } from '@orchardworks/agent-client-web/react';

/** A room: what was said, who speaks now, and the person's own message. */
export function RoomView({ team, busy, onChange }: { team: Team; busy: boolean; onChange(input: TeamAction): Promise<boolean> }) {
  const t = useTranslate();
  const [text, setText] = useState('');
  const room = team.room!, open = room.state === 'open' && team.status === 'active';
  const speaker = team.members.find(member => member.id === room.speaker)?.name;
  const state = room.state === 'done' ? t('team.room.done') : room.state === 'closed' ? t('team.room.closed') : speaker ? t('team.room.speaking', { name: speaker }) : t('team.room.waiting');
  async function send() {
    const value = text.trim();
    if (!value || !await onChange({ teamId: team.id, action: 'room_post', operationId: crypto.randomUUID(), text: value })) return;
    setText('');
  }
  return <div className="lab-room" aria-label={t('team.room.label', { name: room.name })}>
    <p className="lab-room-state" role="status">{state}</p>
    <ol className="lab-room-transcript">{room.transcript.map(entry => <li key={entry.id} data-from={entry.from}>
      <strong>{entry.name}</strong><MarkdownContent markdown={entry.text} />
    </li>)}</ol>
    {open ? <form className="lab-room-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label={t('team.room.message')} value={text} maxLength={8000} disabled={busy} onChange={event => setText(event.target.value)} />
      <div className="lab-team-actions">
        <button type="submit" disabled={busy || !text.trim()}>{t('team.room.send')}</button>
        <button type="button" disabled={busy} onClick={() => void onChange({ teamId: team.id, action: 'close_room' })}>{t('team.room.end')}</button>
      </div>
    </form> : null}
  </div>;
}
