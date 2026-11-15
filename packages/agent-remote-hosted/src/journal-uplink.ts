import { randomUUID } from 'node:crypto';

import {
  encodeRemoteHostUplinkMessage, JOURNAL_FILL_MAX_ITEMS, JOURNAL_INDEX_MAX_ITEMS, JOURNAL_INDEX_PAGE_MAX_ITEMS, JOURNAL_OLDER_MAX_LIMIT, REMOTE_HOST_UPLINK_VERSION,
  type JournalRefusalReason, type RemoteHostUplinkMessage,
} from '@orchardworks/agent-remote-protocol';

import type { HostJournals, JournalFilled, JournalPublished, JournalReadRequest } from './host-journals.js';
import { packIndex } from './journal-index-pages.js';

/** The most requests one connection has open to its Host at a time. */
export const JOURNAL_REQUEST_LIMIT = 32;
/** How long the Host has to answer a request, including the time the journal needs to store the answer. */
export const JOURNAL_REQUEST_TIMEOUT_MS = 15_000;

/** The journal messages a Host sends to its Relay. */
export type JournalHostMessage = Extract<RemoteHostUplinkMessage,
  { type: 'journal_open' | 'journal_index_request' | 'journal_publish' | 'journal_fill' | 'journal_older_done' | 'journal_unserve' | 'journal_request_refused' }>;

export function isJournalHostMessage(message: RemoteHostUplinkMessage): message is JournalHostMessage {
  return message.type === 'journal_open' || message.type === 'journal_index_request' || message.type === 'journal_publish' || message.type === 'journal_fill' || message.type === 'journal_older_done'
    || message.type === 'journal_unserve' || message.type === 'journal_request_refused';
}

/**
 * Whether a message of a Controller needs the journal grant 2: unserving, request refusals, a reset open, amendments, open
 * items and corrections (no digest), and a head that names an attention item. A Controller granted 1 never sends one.
 */
export function needsJournalGrantTwo(message: JournalHostMessage): boolean {
  switch (message.type) {
    case 'journal_unserve': case 'journal_request_refused': return true;
    case 'journal_open': return message.reset === true;
    case 'journal_publish': return message.entries.some(entry => entry.op === 'rebind' || entry.op === 'outcome'
      || (entry.op === 'correct' && entry.digest === undefined)
      || ((entry.op === 'replace' || entry.op === 'prepend') && entry.items.some(item => item.digest === undefined))
      || (entry.op === 'head' && entry.head.attentionItemKey !== undefined));
    default: return false;
  }
}

export class JournalRequestError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'busy' | 'in_flight' | 'timeout' | 'closed' | 'refused', message: string) {
    super(message);
    this.name = 'JournalRequestError';
  }
}

export interface JournalConnectionOptions {
  hostId: string;
  journals: HostJournals;
  send(message: RemoteHostUplinkMessage): void;
  /** Whether this is still the Host's current uplink connection. */
  current(): boolean;
  scheduler: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void };
  requestTimeoutMs?: number;
  /** Told about journal failures: a message that does not encode, a store that fails, a fan-out that throws, a publication the quota refused, and live-only items the journal removed. */
  diagnostic?(event: 'journal_message_unencodable' | 'journal_store_failed' | 'journal_fanout_failed' | 'journal_quota_exceeded' | 'journal_live_only_dropped'): void;
  /**
   * Called with the result of every publication the journal stored, after the store holds it and whether or not this
   * connection is still current: the rows are durable, so subscribers must see them. It is not called for a refused
   * fenced publication. It is also called, with no events, for an open that took the session out of serving (`unserved`: a
   * refusal for an index that is too large, or a reset) and for an unserve the Controller asked for, so the broker stops the
   * session's journal-served streams for all of them. It must be synchronous: the connection does not wait for it. A failure is reported through
   * `diagnostic` and changes nothing.
   */
  published?(sessionKey: string, result: JournalPublished): void;
}

export interface JournalConnection {
  /** Handles one journal message from the Host. Calls made in order enqueue their journal work in that order. */
  receive(message: JournalHostMessage): Promise<void>;
  /**
   * Asks the Host's Controller to read item bodies again from native history; resolves once the journal took them. With
   * `read`, the journal also reads the page in the same step as it takes the bodies, and the result carries it.
   */
  requestFill(sessionKey: string, itemKeys: readonly string[], read?: JournalReadRequest): Promise<JournalFilled>;
  /** Asks the Host's Controller to read older history and publish it as prepended items. */
  requestOlder(sessionKey: string, limit: number): Promise<{ olderAvailable: boolean }>;
  /** Ends the connection: pending requests fail and its sessions need opening again. */
  close(): void;
}

type PendingFill = { kind: 'fill'; itemKeys: ReadonlySet<string>; read?: JournalReadRequest; applying: boolean; resolve(value: JournalFilled): void };
type PendingOlder = { kind: 'older'; resolve(value: { olderAvailable: boolean }): void };
type Pending = (PendingFill | PendingOlder) & { sessionKey: string; reject(error: Error): void; timer: unknown };

/**
 * One uplink connection's side of the journals: it runs the Host's publications through the journal service, tells the
 * Host what was stored or refused, and keeps the requests the Relay made to the Host until they are answered.
 */
export function createJournalConnection(options: JournalConnectionOptions): JournalConnection {
  const { hostId, journals, scheduler } = options;
  const timeoutMs = options.requestTimeoutMs ?? JOURNAL_REQUEST_TIMEOUT_MS;
  /** The generation each session was opened with on this connection. */
  const opened = new Map<string, number>();
  const pending = new Map<string, Pending>();
  /** Whether the message encodes; a message that does not is reported and never sent. */
  function encodes(message: RemoteHostUplinkMessage): boolean {
    if (encodeRemoteHostUplinkMessage(message).status === 'ok') return true;
    options.diagnostic?.('journal_message_unencodable');
    return false;
  }
  /** Sends a message to a connection that is still current; false when nothing was sent. */
  function send(message: RemoteHostUplinkMessage): boolean {
    if (!options.current() || !encodes(message)) return false;
    options.send(message);
    return true;
  }
  const refuse = (sessionKey: string, generation: number, sequence: number, reason: JournalRefusalReason, itemKey?: string) =>
    send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_refused', sessionKey, generation, sequence, reason, ...(itemKey === undefined ? {} : { itemKey }) });

  function request<T>(kind: Pending['kind'], sessionKey: string, message: (requestId: string) => RemoteHostUplinkMessage, track: (resolve: (value: T) => void) => PendingFill | PendingOlder): Promise<T> {
    if (!options.current()) return Promise.reject(new JournalRequestError('unavailable', 'The Host connection is not current.'));
    if (pending.size >= JOURNAL_REQUEST_LIMIT) return Promise.reject(new JournalRequestError('busy', 'Too many pending journal requests.'));
    if ([...pending.values()].some(item => item.kind === kind && item.sessionKey === sessionKey)) {
      return Promise.reject(new JournalRequestError('in_flight', `A journal ${kind} request for ${sessionKey} is already pending.`));
    }
    const requestId = randomUUID();
    const body = message(requestId);
    if (!encodes(body)) return Promise.reject(new JournalRequestError('invalid', `The journal ${kind} request does not encode.`));
    return new Promise<T>((resolve, reject) => {
      const timer = scheduler.setTimeout(() => {
        pending.delete(requestId);
        reject(new JournalRequestError('timeout', 'The Host did not answer the journal request before the Relay deadline.'));
      }, timeoutMs);
      pending.set(requestId, { ...track(resolve), sessionKey, reject, timer });
      try { options.send(body); }
      catch (error) {
        scheduler.clearTimeout(timer);
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error('The journal request could not be written.'));
      }
    });
  }

  /** The pending request of this kind and session that an answer belongs to; undefined when the Relay asked for no such thing. */
  function pendingFor<K extends Pending['kind']>(requestId: string, kind: K, sessionKey: string): Extract<Pending, { kind: K }> | undefined {
    const found = pending.get(requestId);
    return found && found.kind === kind && found.sessionKey === sessionKey ? found as Extract<Pending, { kind: K }> : undefined;
  }
  function settle(requestId: string, found: Pending): void {
    pending.delete(requestId);
    scheduler.clearTimeout(found.timer);
  }

  return {
    async receive(message) {
      switch (message.type) {
        case 'journal_open': {
          const { sessionKey, requestId } = message;
          const result = await journals.open(hostId, sessionKey, message.publisherId,
            { maxIndexItems: JOURNAL_INDEX_MAX_ITEMS, pageItems: JOURNAL_INDEX_PAGE_MAX_ITEMS, allowed: () => options.current(), ...(message.reset ? { reset: true } : {}) });
          if (result.unserved) {
            // The open took the session out of serving, as a quota refusal of a publication does: the broker is told the same way.
            try { options.published?.(sessionKey, { events: [], watermark: 0, unserved: true }); }
            catch { options.diagnostic?.('journal_fanout_failed'); }
          }
          if (!options.current()) return;
          if ('refused' in result) {
            opened.delete(sessionKey);
            if (result.refused === 'index_too_large') {
              send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open_refused', requestId, sessionKey, reason: 'index_too_large' });
            }
            return;
          }
          opened.set(sessionKey, result.generation);
          const index = packIndex(result.index);
          const last = index[index.length - 1];
          send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_opened', requestId, sessionKey, generation: result.generation, watermark: result.watermark,
            epoch: result.epoch, index, ...(last && (result.more || index.length < result.index.length) ? { indexAfter: last.seqStart } : {}) });
          return;
        }
        case 'journal_index_request': {
          const { sessionKey, requestId, generation, epoch, after } = message;
          if (opened.get(sessionKey) !== generation) {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open_refused', requestId, sessionKey, reason: 'invalid' });
            return;
          }
          const entries = await journals.indexPage(hostId, sessionKey, epoch, after, JOURNAL_INDEX_PAGE_MAX_ITEMS + 1);
          if (!options.current()) return;
          if (!entries) {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open_refused', requestId, sessionKey, reason: 'stale_epoch' });
            return;
          }
          const index = packIndex(entries);
          const last = index[index.length - 1];
          send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_index_page', requestId, sessionKey, index, ...(last && entries.length > index.length ? { indexAfter: last.seqStart } : {}) });
          return;
        }
        case 'journal_publish': {
          const { sessionKey, generation } = message;
          if (opened.get(sessionKey) !== generation) {
            refuse(sessionKey, generation, message.entries[0]!.sequence, 'fenced');
            return;
          }
          const result = await journals.publish(hostId, sessionKey, generation, message.entries);
          const stored = result.cursor !== undefined && result.refusal?.reason !== 'fenced';
          if (stored) {
            try { options.published?.(sessionKey, result); }
            catch { options.diagnostic?.('journal_fanout_failed'); }
          }
          if (stored && result.droppedLiveOnly) options.diagnostic?.('journal_live_only_dropped');
          if (result.refusal?.reason === 'quota_exceeded') options.diagnostic?.('journal_quota_exceeded');
          if (!options.current()) return;
          if (result.cursor && stored) {
            send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_ack', sessionKey, generation, watermark: result.watermark, cursor: result.cursor });
          }
          if (result.refusal) {
            const { sequence, reason, itemKey } = result.refusal;
            refuse(sessionKey, generation, sequence, reason, itemKey);
          }
          return;
        }
        case 'journal_fill': {
          const { requestId } = message;
          const found = pendingFor(requestId, 'fill', message.sessionKey);
          if (!found || found.applying) return;
          found.applying = true;
          try {
            const filled = await journals.fill(hostId, message.sessionKey, message.items.filter(({ row }) => found.itemKeys.has(row.itemKey)), found.read);
            if (pending.get(requestId) !== found) return;
            settle(requestId, found);
            found.resolve(filled);
          } catch (error) {
            options.diagnostic?.('journal_store_failed');
            if (pending.get(requestId) !== found) return;
            settle(requestId, found);
            found.reject(error instanceof Error ? error : new Error('The journal could not take the bodies.'));
          }
          return;
        }
        case 'journal_older_done': {
          const found = pendingFor(message.requestId, 'older', message.sessionKey);
          if (!found) return;
          settle(message.requestId, found);
          found.resolve({ olderAvailable: message.olderAvailable });
          return;
        }
        case 'journal_unserve': {
          const { sessionKey, generation } = message;
          if (opened.get(sessionKey) !== generation) return;
          const result = await journals.unserveHead(hostId, sessionKey, generation);
          if (!result) return;
          try { options.published?.(sessionKey, result); }
          catch { options.diagnostic?.('journal_fanout_failed'); }
          return;
        }
        case 'journal_request_refused': {
          const found = pending.get(message.requestId);
          if (!found || found.sessionKey !== message.sessionKey) return;
          settle(message.requestId, found);
          found.reject(new JournalRequestError('refused', `The Controller refused the journal ${found.kind} request: ${message.reason}.`));
          return;
        }
      }
    },

    requestFill(sessionKey, itemKeys, read) {
      if (itemKeys.length < 1 || itemKeys.length > JOURNAL_FILL_MAX_ITEMS || new Set(itemKeys).size !== itemKeys.length) {
        return Promise.reject(new JournalRequestError('invalid', `A fill asks for 1 to ${JOURNAL_FILL_MAX_ITEMS} distinct items.`));
      }
      return request<JournalFilled>('fill', sessionKey, requestId => ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_fill_request', requestId, sessionKey, itemKeys: [...itemKeys] }),
        resolve => ({ kind: 'fill', itemKeys: new Set(itemKeys), ...(read ? { read } : {}), applying: false, resolve }));
    },

    requestOlder(sessionKey, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > JOURNAL_OLDER_MAX_LIMIT) {
        return Promise.reject(new JournalRequestError('invalid', `An older-history read asks for 1 to ${JOURNAL_OLDER_MAX_LIMIT} items.`));
      }
      return request<{ olderAvailable: boolean }>('older', sessionKey, requestId => ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_older_request', requestId, sessionKey, limit }),
        resolve => ({ kind: 'older', resolve }));
    },

    close() {
      opened.clear();
      for (const item of pending.values()) {
        scheduler.clearTimeout(item.timer);
        item.reject(new JournalRequestError('closed', 'The Host connection closed before it answered.'));
      }
      pending.clear();
    },
  };
}
