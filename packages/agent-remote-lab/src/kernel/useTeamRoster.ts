// The Team roster the page reads: tasks, rooms and bots' inboxes are Teams on the Relay, and the task directory, rooms and boards show them.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { errorWords, RemoteTeamClient, watchList } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { workspaceFetch } from './workspace-access.js';

/** How often the Team roster refreshes while a room is open (`watchingMs`), and otherwise (`idleMs`). */
export interface TeamRefreshPeriods { watchingMs: number; idleMs: number }
export const TEAM_REFRESH_PERIODS: TeamRefreshPeriods = { watchingMs: 4_000, idleMs: 30_000 };
/** The periods the roster refreshes at; a page keeps `TEAM_REFRESH_PERIODS`, and a test passes shorter ones instead of waiting them out. */
export const TeamRefresh = createContext<TeamRefreshPeriods>(TEAM_REFRESH_PERIODS);

/** The Teams that are not tasks, links, inboxes or answer sessions: a room, or a Team of an earlier build. Answer sessions travel with the tasks. */
interface Inputs {
  baseUrl: string; enabled: boolean;
  /** The loaded Teams of this `baseUrl`, absent until the first read. */
  teams: readonly Team[] | undefined;
  publish(baseUrl: string, teams: Team[], tasks: Team[]): void;
}
/** Loads the Team roster from the Relay and keeps it current: closely while a room is open, otherwise twice a minute. */
export function useTeamRoster({ baseUrl, enabled, teams, publish }: Inputs): { loadError: string } {
  const t = useTranslate();
  const client = useMemo(() => new RemoteTeamClient(baseUrl, workspaceFetch), [baseUrl]);
  const [loadError, setLoadError] = useState('');
  const currentClient = useRef(client); currentClient.current = client;
  const publishing = useRef(publish); publishing.current = publish;
  const generation = useRef(0);
  const refresh = async () => {
    const ticket = ++generation.current;
    const value = await client.list();
    // Tasks, links, inboxes, answer sessions and rooms travel as Teams on the Relay; the page shows them in conversations and Chats.
    if (currentClient.current === client && ticket === generation.current) {
      publishing.current(baseUrl, value.filter(team => !team.task && !team.link && !team.inbox && !team.ask), value.filter(team => !!team.task || !!team.inbox || !!team.ask));
      setLoadError('');
    }
  };
  useEffect(() => { setLoadError(''); }, [client]);
  const loader = useRef<() => Promise<void>>();
  useEffect(() => {
    ++generation.current;
    if (!enabled) return;
    let stopped = false, inFlight = false;
    const load = async () => { if (stopped || inFlight || document.visibilityState === 'hidden') return; inFlight = true;
      try { await refresh(); }
      catch (error) { if (!stopped) setLoadError(errorWords(error, t, 'team.team.operationFailed')); } finally { inFlight = false; }
    };
    loader.current = load;
    const unwatch = watchList(load);
    return () => { stopped = true; ++generation.current; if (loader.current === load) loader.current = undefined; unwatch(); };
  }, [client, enabled, baseUrl]);
  // An open room changes as its members speak, so it is followed closely; otherwise the roster stays current twice a minute
  // instead of polling every few seconds on every open page.
  const watching = !!teams?.some(team => team.room?.state === 'open');
  const periods = useContext(TeamRefresh);
  useEffect(() => {
    if (!enabled) return;
    // A room just opened: refresh at once.
    if (watching) void loader.current?.();
    const timer = setInterval(() => void loader.current?.(), watching ? periods.watchingMs : periods.idleMs);
    return () => clearInterval(timer);
  }, [client, enabled, baseUrl, watching, periods]);
  return { loadError };
}
