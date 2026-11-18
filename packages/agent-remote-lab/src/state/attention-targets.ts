/**
 * Attention targets: which sessions the Workbench keeps watch over, and where a notification leads.
 *
 * Contract
 * - Pure. The shell passes session lists and lookups in and acts on what comes back.
 * - `attentionSets` names the sessions that may notify (`eligible`) and the ones the person is looking at (`displayed`).
 *   Nothing is watched while attention is off. Window mode watches the tracked sessions, the open Windows and the Ask
 *   sessions with activity, and shows the open Windows and those Ask sessions; Bot mode watches and shows its bots.
 * - `keySignature` is the sorted, duplicate-free list of keys, as a string, so an effect reruns only when the set of
 *   sessions changed and not when their order or their objects did.
 * - `readableSessions` are the sessions a person reads right now, which the shell marks read up to their latest
 *   reply: the visible Windows in Window mode; in Bot mode the visible bots, the selected bot's session and the
 *   sessions before its handoff, and only while a bot is selected and visible.
 * - `attentionDestination` says where a notification for a session leads. Bot mode ignores a session that is not
 *   eligible and otherwise shows the bot's row. Window mode reveals the open Window that shows the session, else opens
 *   the Ask of the open Window whose Ask conversation is the session, else opens the session as history.
 * - `botDirectorySources` lists where Bot mode finds sessions that are not bots yet: the local providers while the
 *   local Host is selected, then each Host's providers. The selected Host keeps its directory client; another Host
 *   gets a client made for it. A source id appears once; the last description of it wins.
 */
export interface AttentionFacts<Tracked, Window, Ask, Bot> {
  readonly enabled: boolean;
  readonly windowMode: boolean;
  readonly tracked: readonly Tracked[];
  readonly openWindows: readonly Window[];
  readonly askSessions: readonly Ask[];
  readonly botTargets: readonly Bot[];
}

export function attentionSets<Tracked, Window, Ask, Bot>(facts: AttentionFacts<Tracked, Window, Ask, Bot>): { eligible: Array<Tracked | Window | Ask | Bot>; displayed: Array<Window | Ask | Bot> } {
  if (!facts.enabled) return { eligible: [], displayed: [] };
  if (!facts.windowMode) return { eligible: [...facts.botTargets], displayed: [...facts.botTargets] };
  return {
    eligible: [...facts.tracked, ...facts.openWindows, ...facts.askSessions],
    displayed: [...facts.openWindows, ...facts.askSessions],
  };
}

export function keySignature<Session>(sessions: readonly Session[], keyOf: (session: Session) => string): string {
  return JSON.stringify([...new Set(sessions.map(keyOf))].sort());
}

export function readableSessions<Window, Bot, Earlier>(facts: {
  readonly windowMode: boolean;
  readonly visibleWindows: readonly Window[];
  readonly visibleBots: readonly Bot[];
  /** The selected bot's session, when a bot is selected. */ readonly botSession: Bot | undefined;
  /** The sessions before the selected bot's handoff; read only when a bot is selected. */ readonly earlier: () => readonly Earlier[];
}): Array<Window | Bot | Earlier> {
  if (facts.windowMode) return [...facts.visibleWindows];
  if (!facts.visibleBots.length || !facts.botSession) return [];
  return [...facts.visibleBots, facts.botSession, ...facts.earlier()];
}

export type AttentionDestination<Session> =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'bot-row' }
  | { readonly kind: 'reveal'; readonly session: Session }
  | { readonly kind: 'ask'; readonly source: Session }
  | { readonly kind: 'open-history' };

export function attentionDestination<Session>(key: string, facts: {
  readonly windowMode: boolean;
  readonly eligibleKeys: ReadonlySet<string>;
  readonly openWindows: readonly Session[];
  readonly keyOf: (session: Session) => string;
  /** The key of the session an open Window's Ask conversation is with. */ readonly askTargetKey: (source: Session) => string | undefined;
}): AttentionDestination<Session> {
  if (!facts.windowMode) return facts.eligibleKeys.has(key) ? { kind: 'bot-row' } : { kind: 'ignore' };
  const shown = facts.openWindows.find(session => facts.keyOf(session) === key);
  if (shown) return { kind: 'reveal', session: shown };
  const source = facts.openWindows.find(session => facts.askTargetKey(session) === key);
  return source ? { kind: 'ask', source } : { kind: 'open-history' };
}

export interface DirectorySource<Directory> { readonly id: string; readonly hostId: string; readonly providerId: string; readonly directory: Directory; readonly online: boolean }

export function botDirectorySources<Directory>(facts: {
  readonly localProviders: readonly { readonly providerId: string }[];
  readonly selectedHostId: string;
  readonly selectedDirectory: Directory | undefined;
  readonly hosts: readonly { readonly id: string; readonly online: boolean; readonly providers?: readonly { readonly providerId: string }[] }[];
  readonly directoryFor: (hostId: string) => Directory;
}): DirectorySource<Directory>[] {
  const sources: DirectorySource<Directory>[] = [];
  if (facts.selectedDirectory && facts.selectedHostId === 'local') {
    for (const provider of facts.localProviders) sources.push({ id: `local/${provider.providerId}`, hostId: 'local', providerId: provider.providerId, directory: facts.selectedDirectory, online: true });
  }
  for (const host of facts.hosts) {
    const directory = host.id === facts.selectedHostId && facts.selectedDirectory ? facts.selectedDirectory : facts.directoryFor(host.id);
    for (const provider of host.providers ?? []) sources.push({ id: `${host.id}/${provider.providerId}`, hostId: host.id, providerId: provider.providerId, directory, online: host.online });
  }
  return [...new Map(sources.map(source => [source.id, source])).values()];
}
