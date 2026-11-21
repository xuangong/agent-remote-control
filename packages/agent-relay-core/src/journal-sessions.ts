import type { JournalPageRequest, JournalPageResult } from '@orchardworks/agent-remote-journal';
import type { NativeRefusal, NativeSessionOwner } from '@orchardworks/agent-remote-protocol';

import type { HostJournals, JournalFilled, JournalPublished, JournalReadRequest } from './host-journals.js';
import type { HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessionStream, type JournalReads, type JournalSessionStream } from './journal-session-stream.js';
import type { BrokerScheduler, RelaySocket } from './transport.js';

/** The key of a session's journal within its Host. */
export const journalSessionKey = (providerId: string, nativeSessionId: string): string => `${providerId}:${nativeSessionId}`;

/** What decides whether a session is read from its journal. Once a Host is loaded, every answer comes from memory. */
export interface JournalGate {
  /** Whether the owner turned smart reading on for the provider of the Host. */
  readingEnabled(hostId: string, providerId: string): boolean;
  /** Whether the session has a journal head; undefined while the Host's sessions are not loaded. */
  served(hostId: string, sessionKey: string): boolean | undefined;
  /** Loads the Host's sessions that have a head. */
  loadServed(hostId: string): Promise<void>;
}

/** How long opening a stream waits for a Host's sessions to load before it is served crude. */
export const JOURNAL_GATE_LOAD_WAIT_MS = 2000;

export interface JournalSessionsOptions {
  journals: Pick<HostJournals, 'status' | 'page' | 'unserve'>;
  gate: JournalGate;
  /** Asks the Host's Controller to read bodies again; rejects when it is offline or cannot. */
  requestFill(hostId: string, sessionKey: string, itemKeys: string[], read: JournalReadRequest): Promise<JournalFilled>;
  /** Asks the Host's Controller to read older history and publish it; rejects when it is offline or cannot. */
  requestOlder(hostId: string, sessionKey: string, limit: number, beforeItemKey: string): Promise<{ olderAvailable: boolean }>;
  scheduler: BrokerScheduler;
  /** Told when a session of the Host starts or stops being shown by any page (`shown`). */
  shownChanged?(hostId: string): void;
}

export interface JournalSessionAttachment {
  hostId: string;
  providerId: string;
  sessionKey: string;
  publicAgentId: string;
  client: Pick<RelaySocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
  hostStreams: HostStreamOpener;
  /** Asks the Controller who holds the session natively; see `JournalSessionStreamOptions`. */
  readNativeOwner(): Promise<NativeSessionOwner | undefined>;
  /** The CLI's refusal of the Controller as a client of the session now, if any; see `JournalSessionStreamOptions`. */
  nativeRefusal?(): NativeRefusal | undefined;
  /** Asks the Relay to attach the refused session again; see `JournalSessionStreamOptions`. */
  retryNative?(): void;
}

export interface JournalSessions {
  /**
   * Whether the session's reads are served from its journal: the owner turned smart reading on for the provider, and the
   * session has a journal head. A Host whose sessions were never loaded is loaded once, within a bound, however many opens
   * ask; after that the answer is immediate and never waits on the store or on the Host's journal queue.
   */
  serves(hostId: string, providerId: string, sessionKey: string): Promise<boolean>;
  /** Smart reading was turned off for the provider of the Host: its journal-served streams close with 1012, so their clients reconnect crude. */
  stopReading(hostId: string, providerId: string): void;
  /** Starts serving one browser stream; the caller routes the stream's messages to it and closes it when the stream ends. */
  attach(attachment: JournalSessionAttachment): JournalSessionStream;
  /** Delivers what a stored publication changed to the streams subscribed to the session. */
  published(hostId: string, sessionKey: string, result: JournalPublished): void;
  /** The Host's sessions that a page shows now: at least one stream negotiated for its content and has not ended. */
  shown(hostId: string): string[];
  /** Tells the streams of a session that the CLI refuses the Controller as its client, and why, or that it no longer does. */
  refused(hostId: string, sessionKey: string, refusal: NativeRefusal | undefined): void;
}

/** What the streams of one session share. */
interface SharedSession {
  hostId: string;
  providerId: string;
  sessionKey: string;
  /** The browser sockets of the session's streams, to close them when the session stops being served. */
  clients: Map<JournalSessionStream, Pick<RelaySocket, 'close'>>;
  streams: Set<JournalSessionStream>;
  /** How many of the streams show the conversation (negotiated for content). */
  showing: number;
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
  /** The load of each Host's sessions in flight, shared by every open that asks. */
  const loads = new Map<string, Promise<void>>();
  const loadServed = (hostId: string): Promise<void> => {
    let load = loads.get(hostId);
    if (!load) {
      load = options.gate.loadServed(hostId).finally(() => { loads.delete(hostId); });
      loads.set(hostId, load);
    }
    return load;
  };
  const closeClients = (shared: SharedSession, reason: string): void => {
    for (const client of [...shared.clients.values()]) {
      try { client.close(1012, reason); }
      catch { /* A client that cannot be closed is gone. */ }
    }
  };
  /** The shared state goes when no stream uses it and no read is pending; it is checked again whenever either changes. */
  function release(key: string, shared: SharedSession): void {
    if (shared.streams.size === 0 && shared.pending === 0 && sessions.get(key) === shared) sessions.delete(key);
  }

  return {
    async serves(hostId, providerId, sessionKey) {
      if (!options.gate.readingEnabled(hostId, providerId)) return false;
      const known = options.gate.served(hostId, sessionKey);
      if (known !== undefined) return known;
      await waitFor(loadServed(hostId), JOURNAL_GATE_LOAD_WAIT_MS, options.scheduler);
      // The switch may have been turned off while the Host loaded.
      return options.gate.readingEnabled(hostId, providerId) && options.gate.served(hostId, sessionKey) === true;
    },

    stopReading(hostId, providerId) {
      for (const shared of [...sessions.values()]) {
        if (shared.hostId === hostId && shared.providerId === providerId) closeClients(shared, 'Smart reading turned off');
      }
    },

    attach(attachment) {
      const { hostId, providerId, sessionKey } = attachment;
      const key = keyOf(hostId, sessionKey);
      const shared: SharedSession = sessions.get(key) ?? { hostId, providerId, sessionKey, clients: new Map(), streams: new Set<JournalSessionStream>(), showing: 0, olderExhausted: false, replacements: 0, fillTail: Promise.resolve(), pending: 0 };
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
            // The journal's oldest item anchors the request; a journal without one has nothing to read older than.
            shared.older = options.journals.status(hostId, sessionKey)
              .then(status => status?.oldestItemKey === undefined ? { olderAvailable: false } : options.requestOlder(hostId, sessionKey, limit, status.oldestItemKey))
              .then(({ olderAvailable }) => { if (!olderAvailable && shared.replacements === began) shared.olderExhausted = true; })
              .finally(() => { shared.older = undefined; shared.pending -= 1; release(key, shared); });
          }
          return shared.older;
        },
        olderBeyondJournal: () => !shared.olderExhausted,
        noHead: () => options.journals.unserve(hostId, sessionKey),
        readFailed: () => options.journals.unserve(hostId, sessionKey),
      };
      const shown = (on: boolean) => {
        shared.showing += on ? 1 : -1;
        if (shared.showing === (on ? 1 : 0)) {
          try { options.shownChanged?.(hostId); }
          catch { /* Telling the Controller never affects the stream. */ }
        }
      };
      const stream = createJournalSessionStream({ publicAgentId: attachment.publicAgentId, client: attachment.client, reads, hostStreams: attachment.hostStreams, readNativeOwner: attachment.readNativeOwner, scheduler: options.scheduler, shown,
        ...(attachment.nativeRefusal ? { nativeRefusal: attachment.nativeRefusal } : {}), ...(attachment.retryNative ? { retryNative: attachment.retryNative } : {}) });
      shared.streams.add(stream);
      shared.clients.set(stream, attachment.client);
      return {
        receive: stream.receive,
        deliver: stream.deliver,
        nativeRefused: stream.nativeRefused,
        close() {
          stream.close();
          shared.streams.delete(stream);
          shared.clients.delete(stream);
          release(key, shared);
        },
      };
    },

    refused(hostId, sessionKey, refusal) {
      const shared = sessions.get(keyOf(hostId, sessionKey));
      for (const stream of [...shared?.streams ?? []]) {
        try { stream.nativeRefused(refusal); }
        catch { /* One stream's failure does not stop the others. */ }
      }
    },

    shown(hostId) {
      return [...sessions.values()].filter(shared => shared.hostId === hostId && shared.showing > 0).map(shared => shared.sessionKey);
    },

    published(hostId, sessionKey, result) {
      const shared = sessions.get(keyOf(hostId, sessionKey));
      if (!shared) return;
      if (result.unserved) { closeClients(shared, 'Journal unavailable'); return; }
      if (result.events.some(event => event.kind === 'replaced')) { shared.olderExhausted = false; shared.replacements += 1; }
      if (result.prependRefused) shared.olderExhausted = true;
      for (const stream of [...shared.streams]) {
        try { stream.deliver(result); }
        catch { /* One stream's failure does not stop the others. */ }
      }
    },
  };
}

/** Resolves when the work settles or after `ms`, whichever is first; a failure of the work is not an error here. */
function waitFor(work: Promise<void>, ms: number, scheduler: BrokerScheduler): Promise<void> {
  return new Promise(resolve => {
    const timer = scheduler.setTimeout(resolve, ms);
    work.then(() => undefined, () => undefined).then(() => { scheduler.clearTimeout(timer); resolve(); });
  });
}
