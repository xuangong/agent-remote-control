import { useEffect, useRef, useState } from 'react';
import { sessionKey, type SessionEntry } from '../session-tree.js';

/**
 * Titles a view starts with before anything names its session: opened from a link ("Session"), created on the page
 * ("New session"), or created on its Host before the native agent named it ("New Claude Code session").
 */
const placeholder = (title: string) => title === 'Session' || title === 'New session' || /^New [^\n]{1,40} session$/.test(title);
/** Enough for a session created on the page to receive its first message and its native title. */
const MAX_ATTEMPTS = 8;
/** How long to wait before asking again for a session that has no native title yet. */
const RETRY_MS = 10_000;

/**
 * Gives views that still show a placeholder title the native title their Host reports, such as Claude Code's first
 * message. A native session may have no title until its first turn is written, so a session is asked again when
 * `trigger` changes (the page passes its sessions' activity) and every few seconds, up to a bound. Titles a user or a
 * rename confirmed, and sessions the Host will not describe to this user, are left alone.
 */
export function useNativeTitles({ entries, confirmed, describe, apply, trigger }: {
  entries: readonly SessionEntry[];
  confirmed?: ReadonlyMap<string, string>;
  describe(hostId: string, providerId: string, nativeSessionId: string, signal: AbortSignal): Promise<string | undefined>;
  apply(session: SessionEntry): void;
  trigger: string;
}): void {
  const attempts = useRef(new Map<string, { count: number; trigger?: string; done?: boolean; pending?: boolean }>());
  const [tick, setTick] = useState(0);
  const [waiting, setWaiting] = useState(false);
  // The page re-renders often while sessions run, so the retry clock is independent of the entry list.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick(value => value + 1), RETRY_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  const lastTrigger = useRef(trigger);
  const latest = useRef({ describe, apply });
  latest.current = { describe, apply };
  // Requests outlive re-renders, whose new entry lists would otherwise cancel them; only unmounting stops them.
  const controller = useRef<AbortController>();
  useEffect(() => { const current = new AbortController(); controller.current = current; return () => current.abort(); }, []);
  useEffect(() => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    // New activity, such as a finished first turn, starts a fresh round of attempts.
    if (lastTrigger.current !== trigger) { lastTrigger.current = trigger; for (const attempt of attempts.current.values()) attempt.count = 0; }
    const round = `${trigger}\n${tick}`;
    let unresolved = false;
    for (const entry of entries) {
      const key = sessionKey(entry);
      if (!placeholder(entry.title) || confirmed?.has(key) || !entry.hostId || entry.hostId === 'local') continue;
      const attempt = attempts.current.get(key) ?? { count: 0 };
      attempts.current.set(key, attempt);
      if (attempt.done || attempt.count >= MAX_ATTEMPTS) continue;
      unresolved = true;
      if (attempt.pending || attempt.trigger === round) continue;
      attempt.count++; attempt.trigger = round; attempt.pending = true;
      void latest.current.describe(entry.hostId, entry.providerId, entry.nativeSessionId, signal).then(title => {
        const named = title?.trim();
        if (!named || placeholder(named)) return;
        attempt.done = true;
        latest.current.apply({ hostId: entry.hostId, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId, title: named });
      }, (error: unknown) => {
        const status = (error as { status?: unknown }).status;
        // The Host does not describe this session to this user (a share recipient) or cannot (an older Controller).
        if (status === 400 || status === 403 || status === 404) attempt.done = true;
      }).finally(() => { attempt.pending = false; });
    }
    setWaiting(unresolved);
  }, [entries, confirmed, trigger, tick]);
}
