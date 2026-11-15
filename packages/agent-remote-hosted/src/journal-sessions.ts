import type { JournalPageRequest, JournalPageResult } from '@orchardworks/agent-remote-journal';

import type { HostJournals, JournalFilled, JournalPublished, JournalReadRequest } from './host-journals.js';
import type { HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessionStream, type JournalReads, type JournalSessionStream } from './journal-session-stream.js';
import type { BrokerScheduler, RelaySocket } from './transport.js';

/** The key of a session's journal within its Host. */
export const journalSessionKey = (providerId: string, nativeSessionId: string): string => `${providerId}:${nativeSessionId}`;

export interface JournalSessionsOptions {
  journals: Pick<HostJournals, 'status' | 'page'>;
  /** Asks the Host's Controller to read bodies again; rejects when it is offline or cannot. */
  requestFill(hostId: string, sessionKey: string, itemKeys: string[], read: JournalReadRequest): Promise<JournalFilled>;
  /** Asks the Host's Controller to read older history and publish it; rejects when it is offline or cannot. */
  requestOlder(hostId: string, sessionKey: string, limit: number): Promise<{ olderAvailable: boolean }>;
  scheduler: BrokerScheduler;
}

export interface JournalSessionAttachment {
  hostId: string;
  sessionKey: string;
  publicAgentId: string;
  client: Pick<RelaySocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  hostStreams: HostStreamOpener;
}

export interface JournalSessions {
  /** Whether the session's reads are served from its journal: a journal with a head exists. */
  serves(hostId: string, sessionKey: string): Promise<boolean>;
  /** Starts serving one browser stream; the caller routes the stream's messages to it and closes it when the stream ends. */
  attach(attachment: JournalSessionAttachment): JournalSessionStream;
  /** Delivers what a stored publication changed to the streams subscribed to the session. */
  published(hostId: string, sessionKey: string, result: JournalPublished): void;
  /** The Host's Controller connected again: streams of the Host that wait for it close so their clients reconnect. */
  hostReturned(hostId: string): void;
}

/** What the streams of one session share. */
interface SharedSession {
  hostId: string;
  streams: Set<JournalSessionStream>;
  /** True once a Controller said it holds no history older than the journal; reset by a replacement. */
  olderExhausted: boolean;
  /** How many replacements the journal had; an answer about older history that began before one says nothing about the new epoch. */
  replacements: number;
  /** The last queued fill: fills of a session run one after another, each with its own items. */
  fillTail: Promise<void>;
  older?: Promise<void>;
  /** Fills and older-history reads that have not settled; the state stays while any is pending. */
  pending: number;
}

export function createJournalSessions(options: JournalSessionsOptions): JournalSessions {
  const sessions = new Map<string, SharedSession>();
  const keyOf = (hostId: string, sessionKey: string) => JSON.stringify([hostId, sessionKey]);
  /** The shared state goes when no stream uses it and no read is pending; it is checked again whenever either changes. */
  function release(key: string, shared: SharedSession): void {
    if (shared.streams.size === 0 && shared.pending === 0 && sessions.get(key) === shared) sessions.delete(key);
  }

  return {
    async serves(hostId, sessionKey) {
      return (await options.journals.status(hostId, sessionKey))?.head !== undefined;
    },

    attach(attachment) {
      const { hostId, sessionKey } = attachment;
      const key = keyOf(hostId, sessionKey);
      const shared = sessions.get(key) ?? { hostId, streams: new Set<JournalSessionStream>(), olderExhausted: false, replacements: 0, fillTail: Promise.resolve(), pending: 0 };
      sessions.set(key, shared);
      const reads: JournalReads = {
        status: () => options.journals.status(hostId, sessionKey),
        page: (request: JournalPageRequest): Promise<JournalPageResult | undefined> => options.journals.page(hostId, sessionKey, request, !shared.olderExhausted),
        fill(itemKeys, request) {
          // One fill per session at a time, each asking for its own items. The page is read in the same step as the fill.
          shared.pending += 1;
          const run = shared.fillTail.then(() => options.requestFill(hostId, sessionKey, itemKeys, { request, olderBeyondJournal: () => !shared.olderExhausted })).then(filled => filled.page);
          shared.fillTail = run.then(() => undefined, () => undefined);
          return run.finally(() => { shared.pending -= 1; release(key, shared); });
        },
        older(limit) {
          if (shared.older === undefined) {
            const began = shared.replacements;
            shared.pending += 1;
            shared.older = options.requestOlder(hostId, sessionKey, limit)
              .then(({ olderAvailable }) => { if (!olderAvailable && shared.replacements === began) shared.olderExhausted = true; })
              .finally(() => { shared.older = undefined; shared.pending -= 1; release(key, shared); });
          }
          return shared.older;
        },
        olderBeyondJournal: () => !shared.olderExhausted,
      };
      const stream = createJournalSessionStream({ publicAgentId: attachment.publicAgentId, client: attachment.client, reads, hostStreams: attachment.hostStreams, scheduler: options.scheduler });
      shared.streams.add(stream);
      return {
        receive: stream.receive,
        deliver: stream.deliver,
        hostReturned: stream.hostReturned,
        close() {
          stream.close();
          shared.streams.delete(stream);
          release(key, shared);
        },
      };
    },

    published(hostId, sessionKey, result) {
      const shared = sessions.get(keyOf(hostId, sessionKey));
      if (!shared) return;
      if (result.events.some(event => event.kind === 'replaced')) { shared.olderExhausted = false; shared.replacements += 1; }
      for (const stream of [...shared.streams]) {
        try { stream.deliver(result); }
        catch { /* One stream's failure does not stop the others. */ }
      }
    },

    hostReturned(hostId) {
      for (const shared of [...sessions.values()]) {
        if (shared.hostId !== hostId) continue;
        for (const stream of [...shared.streams]) {
          try { stream.hostReturned(); }
          catch { /* One stream's failure does not stop the others. */ }
        }
      }
    },
  };
}
