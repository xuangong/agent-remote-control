import { useEffect, useMemo, useRef } from 'react';
import { botViews, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import type { SessionReply, SessionStateRef } from '@orchardworks/agent-client';
import { readStoredReplies, writeStoredReplies } from '../kernel/stored-replies.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { SharedFeeds } from '../kernel/shared-feeds.js';

/**
 * The latest reply of each assistant of `groups` as this device last saw it, for a roster that has not heard the live states yet. Live replies win and are
 * remembered for the next start; reading what the device stored waits for nothing (`canRead`).
 */
export function useLastKnownReplies(scope: string, canRead: boolean, groups: readonly WindowGroup[], feeds: SharedFeeds): (session: SessionStateRef) => SessionReply | undefined {
  const replies = useMemo(() => canRead ? readStoredReplies(scope) : new Map<string, SessionReply>(), [scope, canRead]);
  const latest = useRef(groups); latest.current = groups;
  useEffect(() => {
    if (!canRead) return;
    let queued: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      const states = feeds.get().states;
      if (!states) return;
      let changed = false;
      for (const group of latest.current) for (const view of botViews(group)) {
        const reply = states.reply(view.binding), key = sessionKey(view.binding);
        const known = replies.get(key);
        if (reply && (!known || known.replyAt !== reply.replyAt || known.preview !== reply.preview)) { replies.set(key, reply); changed = true; }
      }
      if (changed) { clearTimeout(queued); queued = setTimeout(() => writeStoredReplies(scope, replies), 500); }
    };
    remember();
    const stop = feeds.subscribe(remember);
    return () => { stop(); if (queued !== undefined) { clearTimeout(queued); writeStoredReplies(scope, replies); } };
  }, [feeds, scope, canRead, replies]);
  return session => { const reply = replies.get(sessionKey(session)); return reply && { ...reply }; };
}
