import { lazy, Suspense, useMemo, useState } from 'react';
import { RemoteTeamClient } from '@orchardworks/agent-client';
import type { Team, TeamAction } from '@orchardworks/agent-remote-protocol';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { workspaceFetch } from '../../kernel/workspace-access.js';
const RoomView = lazy(() => import('../team/RoomView.js').then(module => ({ default: module.RoomView })));
import { Icon } from '../../ui/Icon.js';

/** A room that ended stays listed for a day, so its result can be read. */
const ENDED_SHOWN_MS = 24 * 60 * 60_000;

/**
 * Rooms in Chats (bots design 4 and 10): the account's open rooms, and those that ended in the last day, above the bots, from the Teams
 * the page keeps. A room opens as a group chat: what each member said, who speaks now, and the person's own message.
 */
export function BotRooms({ scope, rooms: listed, client: given, now = Date.now }: { scope: string; rooms: readonly Team[]; client?: Pick<RemoteTeamClient, 'action'>; now?: () => number }) {
  const t = useTranslate();
  const client = useMemo(() => given ?? new RemoteTeamClient(scope, workspaceFetch), [scope, given]);
  // A room the person just changed shows as the Relay answered, until the page's Teams catch up.
  const [answered, setAnswered] = useState<Record<string, Team>>({}), [open, setOpen] = useState<string>(), [busy, setBusy] = useState(false);
  const rooms = listed.map(team => answered[team.id] && answered[team.id]!.revision > team.revision ? answered[team.id]! : team)
    .filter(team => team.room && (team.room.state === 'open' || now() - team.updatedAt < ENDED_SHOWN_MS));
  const change = async (input: TeamAction): Promise<boolean> => {
    setBusy(true);
    try { const team = await client.action(input); setAnswered(current => ({ ...current, [team.id]: team })); return true; }
    catch { return false; } finally { setBusy(false); }
  };
  if (!rooms.length) return null;
  const shown = rooms.find(room => room.id === open);
  return <section className="lab-bot-rooms" aria-label={t('assistants.rooms')}>
    <h3>{t('assistants.rooms')}</h3>
    <ul>{rooms.map(team => <li key={team.id}>
      <button type="button" className="lab-bot-row" data-room={team.id} onClick={() => setOpen(team.id)}>
        <Icon name="team" size={18} />
        <span className="lab-bot-row-text"><strong className="lab-bot-name">{team.room!.name}</strong>
          <small>{team.room!.state === 'open' ? t('assistants.roomMembers', { count: team.members.length }) : t(team.room!.state === 'done' ? 'team.room.done' : 'team.room.closed')}</small></span>
      </button></li>)}</ul>
    {shown ? <Sheet open title={t('team.room.label', { name: shown.room!.name })} detent="large" onClose={() => setOpen(undefined)}>
      <Suspense fallback={null}><RoomView team={shown} busy={busy} onChange={change} /></Suspense></Sheet> : null}
  </section>;
}
