import { AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';
import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';

import { NativeSessionOwnerError } from '../native-session-owner.js';

/**
 * Terminal refresh: a session a terminal CLI wrote to while the Controller held no runtime of it still shows the turn.
 *
 * Contract.
 * - Coverage. For each session this process published and released, the module remembers the native update time its journal covers
 *   (`released`). A session that was released because something else had written to its transcript covers only what this process wrote.
 *   Only the sessions released most recently are kept, at most `JOURNAL_REFRESH_SESSIONS`.
 * - Due. A listing summary is due when the session is remembered, has no runtime and no demand, its update time is newer than its
 *   coverage, and that time is at least `JOURNAL_REFRESH_QUIET_MS` old, so a terminal that is still writing is left alone between turns.
 *   Due sessions are attached newest first and released again at once, so the Relay's journal reads the native history.
 * - At most one refresh runs at a time; a listing that arrives meanwhile, while stopping, or for a provider that is not followed, starts nothing.
 *   A refresh never fails the listing it rides on.
 * - A resident session whose transcript something else wrote to (its directory's `checkDivergence`, by content) and that may be released is
 *   read again: one nothing holds is expired, so the next attach reads it; one a page shows or something holds is released and attached
 *   again at once (`reread`), so the page follows native history without waiting for a send.
 * - Retry. The coverage moves to the summary's update time before the attach, so a failed attach waits for the next change. An attach
 *   refused because a terminal owns the session, or because the session is in use, puts the old coverage back, so the next listing tries again.
 * - A directory whose listing is read only on request does not move when a terminal writes: its remembered sessions are read one by one,
 *   at most `JOURNAL_REFRESH_READS` at once.
 * - Nothing here touches a provider without journal support or a session this process never published: they have no coverage.
 *
 * Mutable state: the coverage map and the running flag. Time, directories, runtimes and the journal are ports.
 */
export const JOURNAL_REFRESH_READS = 4;
export const JOURNAL_REFRESH_SESSIONS = 20;
export const JOURNAL_REFRESH_QUIET_MS = 30_000;

export interface RefreshBinding { agentId: string; providerId: string; nativeSessionId: string; parentNativeSessionId?: string }

/** What the refresh asks of a provider's directory. */
export interface RefreshDirectory {
  /** Present when the listing is read only on request. */
  readonly listing?: unknown;
  sessionSummary?(nativeSessionId: string): Promise<RemoteSessionSummary | undefined>;
  canReleaseSession?(nativeSessionId: string): boolean;
  /** When this process last wrote to a session whose transcript something else has written to since; none when it did not diverge. */
  divergedAt?(nativeSessionId: string): number | undefined;
  /** Checks a resident session's transcript by its content, with the update time the listing read; the verdict feeds `divergedAt`. */
  checkDivergence?(nativeSessionId: string, listedUpdatedAt?: number): Promise<boolean>;
}

export interface TerminalRefreshPorts {
  now(): number;
  directory(providerId: string): RefreshDirectory | undefined;
  bindings(): Iterable<RefreshBinding>;
  bindingOf(providerId: string, nativeSessionId: string): RefreshBinding | undefined;
  /** Whether the session has a runtime now. */
  isLive(agentId: string): boolean;
  /** Whether a browser, a manager or a command holds the session. */
  hasDemand(agentId: string): boolean;
  /** Releases the runtime of an idle session as soon as it can be. */
  expire(agentId: string): void;
  /** Releases a held session whose transcript something else wrote to and attaches it again at once, so it reads native history. */
  reread(agentId: string): Promise<void>;
  /** Whether the connection holds the Relay's journal grant, so a session published now would be read. */
  granted(): boolean;
  /** Closing or draining: nothing new starts. */
  stopped(): boolean;
  /** Attaches the session once, as a browser's open does, and lets go of it. */
  attachAndRelease(agentId: string): Promise<void>;
  /** Publishes what the session still holds and stops following it; true when the journal was serving it. */
  releaseJournal(agentId: string): Promise<boolean>;
}

export interface TerminalRefresh {
  /** Every read of a directory's listing passes its summaries here. Returns at once; the refresh runs behind it. */
  listed(providerId: string, summaries: readonly RemoteSessionSummary[]): void;
  /** The same refresh, awaited. */
  refresh(providerId: string, summaries: readonly RemoteSessionSummary[]): Promise<void>;
  /** Publishes what the session holds, stops following it, and remembers what its journal now covers. */
  releaseJournal(binding: RefreshBinding): Promise<void>;
  /** The coverage of each remembered session by key `providerId:nativeSessionId`, oldest release first. */
  coverage(): ReadonlyMap<string, number>;
}

const keyOf = (providerId: string, nativeSessionId: string): string => `${providerId}:${nativeSessionId}`;

export function createTerminalRefresh(ports: TerminalRefreshPorts): TerminalRefresh {
  const windowAt = new Map<string, number>();
  let running = false;

  async function releaseJournal(binding: RefreshBinding): Promise<void> {
    const startedAt = ports.now();
    // A session released because something else wrote to its transcript is behind it: its journal covers only what this process wrote.
    const diverged = ports.directory(binding.providerId)?.divergedAt?.(binding.nativeSessionId);
    if (!await ports.releaseJournal(binding.agentId)) return;
    const key = keyOf(binding.providerId, binding.nativeSessionId);
    // Never earlier than what a listing already told: a clock behind the native one must not make the same write look new again.
    const covered = diverged ?? Math.max(windowAt.get(key) ?? 0, startedAt);
    // Re-inserted so the map keeps the sessions released most recently, and no more of them than a refresh may read.
    windowAt.delete(key);
    windowAt.set(key, covered);
    while (windowAt.size > JOURNAL_REFRESH_SESSIONS) windowAt.delete(windowAt.keys().next().value!);
  }

  async function refresh(providerId: string, listedSummaries: readonly RemoteSessionSummary[]): Promise<void> {
    const directory = ports.directory(providerId);
    if (!directory) return;
    // A resident session whose transcript something else wrote to is read again: one nothing holds is expired and the attach below reads
    // it; one a page shows is released and attached again at once, so the page follows what native history shows.
    for (const binding of [...ports.bindings()]) {
      if (binding.providerId !== providerId || binding.parentNativeSessionId || !ports.isLive(binding.agentId)) continue;
      const listed = Date.parse(listedSummaries.find(summary => summary.nativeSessionId === binding.nativeSessionId)?.updatedAt ?? '');
      await directory.checkDivergence?.(binding.nativeSessionId, Number.isFinite(listed) ? listed : undefined).catch(() => false);
      if (ports.stopped() || !directory.canReleaseSession?.(binding.nativeSessionId) || directory.divergedAt?.(binding.nativeSessionId) === undefined) continue;
      if (ports.hasDemand(binding.agentId)) await ports.reread(binding.agentId).catch(() => undefined);
      else ports.expire(binding.agentId);
    }
    if (!ports.granted()) return;
    const unheld = [...windowAt.keys()].flatMap(key => {
      const binding = key.startsWith(`${providerId}:`) ? ports.bindingOf(providerId, key.slice(providerId.length + 1)) : undefined;
      return binding && !ports.isLive(binding.agentId) && !ports.hasDemand(binding.agentId) ? [binding] : [];
    });
    if (!unheld.length) return;
    let summaries: readonly RemoteSessionSummary[] = listedSummaries;
    if (directory.listing && directory.sessionSummary) {
      const read: RemoteSessionSummary[] = [];
      for (let at = 0; at < unheld.length; at += JOURNAL_REFRESH_READS) {
        const batch = await Promise.all(unheld.slice(at, at + JOURNAL_REFRESH_READS).map(binding => directory.sessionSummary!(binding.nativeSessionId).catch(() => undefined)));
        for (const summary of batch) if (summary) read.push(summary);
      }
      summaries = read;
    }
    const due = summaries.flatMap(summary => {
      const updatedAt = Date.parse(summary.updatedAt), key = keyOf(providerId, summary.nativeSessionId), known = windowAt.get(key);
      const binding = unheld.find(candidate => candidate.nativeSessionId === summary.nativeSessionId);
      // A terminal that is still writing is left alone until it has been quiet for a while, so a session is not attached between its turns.
      return known !== undefined && binding && Number.isFinite(updatedAt) && updatedAt > known && ports.now() - updatedAt >= JOURNAL_REFRESH_QUIET_MS ? [{ binding, key, known, updatedAt }] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const { binding, key, known, updatedAt } of due) {
      if (ports.stopped()) return;
      // Taken before the attach: a failed attach waits for the next change, and a session written meanwhile is newer again.
      windowAt.set(key, updatedAt);
      try {
        await ports.attachAndRelease(binding.agentId);
      } catch (error) {
        if (error instanceof NativeSessionOwnerError || error instanceof AgentSessionInUseError) windowAt.set(key, known);
      }
    }
  }

  return {
    listed(providerId, summaries) {
      if (running || ports.stopped()) return;
      running = true;
      void refresh(providerId, summaries).catch(() => undefined).finally(() => { running = false; });
    },
    refresh,
    releaseJournal,
    coverage: () => windowAt,
  };
}
