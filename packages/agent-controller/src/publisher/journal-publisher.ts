import { randomUUID } from 'node:crypto';

import { encodeRemoteHostUplinkMessage, REMOTE_HOST_UPLINK_VERSION, type JournalRelayMessage } from '@orchardworks/agent-remote-protocol';

import {
  DEFAULT_PUBLISHER_LIMITS, SessionPublication, type JournalPublisherDiagnostic, type JournalSource, type PublicationContext, type PublisherLimits,
} from './journal-publication.js';

export type { JournalPublisherDiagnostic, JournalSource, PublisherLimits } from './journal-publication.js';

/** The connection's way to write journal messages, held while the Relay's grant holds. */
interface JournalWriter { send(json: string): void }

interface JournalPublisherOptions {
  /** The providers whose adapters declare journal support. Sessions of any other provider are not published. */
  providers(): Iterable<string>;
  /** How a provider's reread lists the siblings of a turn, as its adapter declares (`reread.order`); the live order when absent. */
  rereadOrder?(providerId: string): 'live' | 'siblings_unordered';
  /** Names this Controller process to the Relay. A restart is a different publisher, and a reconnect is the same one. */
  publisherId?: string;
  limits?: Partial<PublisherLimits>;
  now?(): number;
  /** Where timers run; tests drive it by hand. */
  scheduler?: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(timer: unknown): void };
  diagnostic?(entry: JournalPublisherDiagnostic): void;
}

interface PublishedSession {
  agentId: string;
  providerId: string;
  nativeSessionId: string;
  source: JournalSource;
}

export interface JournalPublisher {
  /** Whether any provider can publish, which decides whether this Controller asks the Relay for journals. */
  capable(): boolean;
  /** The connection holds the Relay's grant (a writer) or does not: sessions open their journals, or wait. */
  available(writer: JournalWriter | undefined): void;
  /** A journal message of the Relay. */
  receive(message: JournalRelayMessage): void;
  /** Starts publishing a session; false for a provider that does not declare journal support. */
  attach(session: PublishedSession): boolean;
  /** Publishes what the session still holds, then stops following it. True when its journal was serving the session, so the Relay holds what it held. */
  release(agentId: string): Promise<boolean>;
  /** Whether the connection holds the Relay's grant, so sessions publish rather than wait. */
  granted(): boolean;
  /** Waits until every session has published what it holds, for at most `timeoutMs` each. */
  drain(timeoutMs: number): Promise<void>;
  close(): void;
}

/** A pool of room: how many bytes may be in flight, handed out in the order they were asked for. One message is always admitted when none is in flight, so a message larger than the pool does not wait for ever. */
function createRoom(maxBytes: number) {
  let used = 0;
  const waiting: Array<{ needed: number; grant(): void }> = [];
  const pump = (): void => {
    while (waiting.length > 0) {
      const next = waiting[0]!;
      if (used > 0 && used + next.needed > maxBytes) return;
      waiting.shift();
      used += next.needed;
      next.grant();
    }
  };
  return {
    reserve(needed: number): Promise<() => void> {
      return new Promise(resolve => {
        waiting.push({ needed, grant: () => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            used -= needed;
            pump();
          });
        } });
        pump();
      });
    },
  };
}

export function createJournalPublisher(options: JournalPublisherOptions): JournalPublisher {
  const limits: PublisherLimits = { ...DEFAULT_PUBLISHER_LIMITS, ...options.limits };
  const publisherId = options.publisherId ?? randomUUID();
  const room = createRoom(limits.inFlightBytes);
  const sessions = new Map<string, SessionPublication>();
  const byKey = new Map<string, SessionPublication>();
  let writer: JournalWriter | undefined;
  let closed = false;

  const context: PublicationContext = {
    publisherId, limits, now: options.now ?? Date.now,
    send(message, providerId) {
      const connection = writer;
      if (!connection) return 'offline';
      const encoded = encodeRemoteHostUplinkMessage(message);
      if (encoded.status !== 'ok') {
        context.diagnostic({ event: 'journal_message_unencodable', providerId });
        return 'unencodable';
      }
      connection.send(encoded.json);
      return 'sent';
    },
    reserve: bytes => room.reserve(bytes),
    diagnostic(entry) {
      try { options.diagnostic?.(entry); } catch { /* A diagnostic sink cannot stop publishing. */ }
    },
    schedule(callback, delayMs) {
      if (options.scheduler) return options.scheduler.setTimeout(callback, delayMs);
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    cancel(timer) {
      if (options.scheduler) options.scheduler.clearTimeout(timer);
      else clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  };

  return {
    capable() {
      for (const _ of options.providers()) return true;
      return false;
    },

    available(next) {
      writer = next;
      for (const session of sessions.values()) {
        if (next) session.resume();
        else session.suspend();
      }
    },

    receive(message) {
      const publication = byKey.get(message.sessionKey);
      if ((message.type === 'journal_fill_request' || message.type === 'journal_older_request') && !publication?.requestable) {
        // The Relay waits for an answer to a request; a session this Controller does not follow gets its refusal at once.
        context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_request_refused', requestId: message.requestId, sessionKey: message.sessionKey,
          reason: publication ? 'not_ready' : 'not_followed' }, 'unknown');
        return;
      }
      publication?.receive(message);
    },

    attach(session) {
      if (closed || ![...options.providers()].includes(session.providerId)) return false;
      const sessionKey = `${session.providerId}:${session.nativeSessionId}`;
      // A manager woken after a handoff or a release of the native CLI is a new source for the same session: follow it, not the one that closed.
      for (const earlier of [sessions.get(session.agentId), byKey.get(sessionKey)]) {
        if (earlier?.followed === session.source) return true;
        earlier?.stop();
      }
      const publication: SessionPublication = new SessionPublication({
        agentId: session.agentId, providerId: session.providerId, sessionKey, source: session.source, context, order: options.rereadOrder?.(session.providerId) ?? 'live',
        onFinished: () => {
          if (sessions.get(session.agentId) === publication) sessions.delete(session.agentId);
          if (byKey.get(sessionKey) === publication) byKey.delete(sessionKey);
        },
      });
      sessions.set(session.agentId, publication);
      byKey.set(sessionKey, publication);
      if (writer) publication.resume();
      return true;
    },

    async release(agentId) {
      const publication = sessions.get(agentId);
      if (!publication) return false;
      await publication.drain(5000);
      const serving = publication.requestable;
      publication.stop();
      return serving;
    },

    granted() { return writer !== undefined; },

    async drain(timeoutMs) {
      await Promise.all([...sessions.values()].map(session => session.drain(timeoutMs)));
    },

    close() {
      closed = true;
      for (const session of [...sessions.values()]) session.stop();
    },
  };
}
