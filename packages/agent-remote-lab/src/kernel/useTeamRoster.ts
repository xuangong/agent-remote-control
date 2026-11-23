// The Team roster the page reads: tasks, rooms and bots' inboxes are Teams on the Relay, and the task directory, rooms and work items show them.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { errorWords, RemoteTeamClient, watchList } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from './workspace-access.js';

/** How often the Team roster refreshes while someone looks at it or a Team is forming (`watchingMs`), and otherwise (`idleMs`). */
export interface TeamRefreshPeriods { watchingMs: number; idleMs: number }
export const TEAM_REFRESH_PERIODS: TeamRefreshPeriods = { watchingMs: 4_000, idleMs: 30_000 };
/** The periods the roster refreshes at; a page keeps `TEAM_REFRESH_PERIODS`, and a test passes shorter ones instead of waiting them out. */
export const TeamRefresh = createContext<TeamRefreshPeriods>(TEAM_REFRESH_PERIODS);

export interface TeamRosterControls {
  loading: boolean; loadError: string;
  /** Reads the roster now; rejects when the Relay cannot be read. */
  refresh(): Promise<void>;
  /** Someone looks at the roster: it refreshes closely while they do. */
  watch(watching: boolean): void;
  /** A change is under way: reads wait until the returned function is called. */
  hold(): () => void;
}
/** The open conversations' pool, which keeps the sessions the roster names open. */
interface SessionRetention { retainSessions(reason: string, sessions: Array<{ hostId: string; providerId: string; nativeSessionId: string }>): void }
interface Inputs {
  baseUrl: string; enabled: boolean;
  /** A Team member's conversation is open: its seat follows the member's successor through the roster, which then refreshes closely. */
  following?: boolean;
  /** The loaded Teams of this `baseUrl`, absent until the first read. */
  teams: readonly Team[] | undefined;
  publish(baseUrl: string, teams: Team[], tasks: Team[]): void;
  connections?: SessionRetention;
}
/** Loads the Team roster from the Relay and keeps it current: closely while watched or forming, otherwise twice a minute. */
export function useTeamRoster({ baseUrl, enabled, following, teams, publish, connections }: Inputs): TeamRosterControls {
  const t = useTranslate();
  const client = useMemo(() => new RemoteTeamClient(baseUrl, workspaceFetch), [baseUrl]);
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(''), [watched, setWatched] = useState(false);
  const currentClient = useRef(client); currentClient.current = client;
  const publishing = useRef(publish); publishing.current = publish;
  const generation = useRef(0), held = useRef(0);
  const refresh = async () => {
    if (held.current) return;
    const ticket = ++generation.current;
    const value = await client.list();
    // Tasks, links, inboxes and rooms travel as Teams on the Relay; the page shows them in conversations and Chats.
    if (currentClient.current === client && ticket === generation.current) {
      publishing.current(baseUrl, value.filter(team => !team.task && !team.link && !team.inbox), value.filter(team => !!team.task || !!team.inbox));
      setLoadError('');
    }
  };
  useEffect(() => { setLoadError(''); }, [client]);
  const loader = useRef<() => Promise<void>>();
  useEffect(() => {
    ++generation.current;
    if (!enabled) { setLoading(false); return; }
    let stopped = false, inFlight = false;
    const load = async () => { if (stopped || inFlight || document.visibilityState === 'hidden') return; inFlight = true;
      try { await refresh(); }
      catch (error) { if (!stopped) setLoadError(errorWords(error, t, 'team.team.operationFailed')); } finally { inFlight = false; if (!stopped) setLoading(false); }
    };
    loader.current = load;
    setLoading(true);
    const unwatch = watchList(load);
    return () => { stopped = true; ++generation.current; if (loader.current === load) loader.current = undefined; unwatch(); };
  }, [client, enabled, baseUrl]);
  // The roster follows changes closely while someone looks at it, a Team is forming or a member's conversation is open (its
  // seat follows the member's successor through the roster); otherwise it stays current for
  // roles and attention twice a minute instead of polling every few seconds on every open page (stage 6).
  const forming = !!teams?.some(team => team.status === 'active' && team.members.some(member => member.creation === 'reserved'));
  const watching = watched || forming || !!following;
  const periods = useContext(TeamRefresh);
  useEffect(() => {
    if (!enabled) return;
    // Something to follow just appeared (a member's conversation opened, a Team began forming): refresh at once.
    if (watching) void loader.current?.();
    const timer = setInterval(() => void loader.current?.(), watching ? periods.watchingMs : periods.idleMs);
    return () => clearInterval(timer);
  }, [client, enabled, baseUrl, watching, periods]);
  useEffect(() => {
    // Temporary access or catalog failures must not discard the last confirmed retention set.
    if (!enabled || !teams) return;
    connections?.retainSessions('team-leaders', teams.filter(team => team.status !== 'archived').flatMap(team => team.members
      .filter(member => member.role === 'leader' && member.creation === 'ready' && member.nativeSessionId)
      .map(member => ({ hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId! }))));
  }, [connections, client, enabled, teams]);
  useEffect(() => () => connections?.retainSessions('team-leaders', []), [connections, client]);
  return useMemo(() => ({ loading, loadError, refresh, watch: setWatched, hold: () => {
    held.current++; ++generation.current;
    return () => { ++generation.current; held.current--; };
  } }), [loading, loadError, client]);
}
