import { isOutboxHostCall, isOutboxRequest, OUTBOX_LIMIT, type OutboxDelivery, type OutboxEntries, type OutboxEntry, type OutboxHostCall } from '@orchardworks/agent-remote-protocol';
import { MAX_OUTBOX, type HostedRelayState, type RelayState, type SavedOutboxEntry } from './state.js';

export class OutboxError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface SessionOutboxOptions {
  now?: () => number;
  /** Whether an account may leave messages for a Host: its own, whose Controller delivers from the outbox. */
  canQueue(subject: string, hostId: string): boolean;
  /** A message became waiting for a Host: tell its Controller if it is connected. */
  ready(hostId: string): void;
}

const entryOf = ({ subject: _subject, claimedAt: _claimedAt, ...entry }: SavedOutboxEntry): OutboxEntry => ({ ...entry });
const deliveryOf = (entry: SavedOutboxEntry): OutboxDelivery => ({ id: entry.id, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId, text: entry.text,
  createdAt: entry.createdAt, status: entry.status as OutboxDelivery['status'] });

/**
 * Messages the owner sent to sessions whose Host was offline. Each waits, visible on every device, until the Host's
 * Controller claims it, sends it and settles the outcome: accepted messages leave the outbox (the conversation has them
 * now), refused ones stay as failed with the reason, and a claim whose outcome was lost stays as unknown. A message can
 * be cancelled until it is claimed, and a failed or unknown one sent again.
 */
export function createSessionOutbox(state: RelayState, options: SessionOutboxOptions) {
  const now = options.now ?? Date.now;
  const saved = (snapshot: HostedRelayState = state.read()) => snapshot.outbox ?? [];
  function own(subject: string, id: string) {
    const entry = saved().find(item => item.id === id && item.subject === subject);
    if (!entry) throw new OutboxError(404, 'outbox_missing', 'This message is no longer in the outbox.');
    return entry;
  }
  return {
    list(subject: string): OutboxEntries {
      return { entries: saved().filter(entry => entry.subject === subject).map(entryOf) };
    },
    async create(subject: string, body: unknown): Promise<OutboxEntry> {
      if (!isOutboxRequest(body)) throw new OutboxError(400, 'invalid_outbox_message', 'A waiting message needs an ID, a session and at most 16 KB of text.');
      const known = saved().find(entry => entry.id === body.id);
      if (known) {
        if (known.subject === subject && known.hostId === body.hostId && known.providerId === body.providerId && known.nativeSessionId === body.nativeSessionId && known.text === body.text) return entryOf(known);
        throw new OutboxError(409, 'outbox_conflict', 'Another message already uses this ID.');
      }
      if (!options.canQueue(subject, body.hostId)) throw new OutboxError(403, 'outbox_unavailable', 'Messages can wait only for your own Hosts whose Controller delivers them. Update the Controller on this Host.');
      let created: SavedOutboxEntry | undefined;
      await state.mutate(draft => {
        const entries = draft.outbox ??= [];
        if (entries.filter(entry => entry.subject === subject).length >= OUTBOX_LIMIT || entries.length >= MAX_OUTBOX) throw new OutboxError(409, 'outbox_full', 'The outbox is full. Cancel a waiting message first.');
        created = { subject, id: body.id, hostId: body.hostId, providerId: body.providerId, nativeSessionId: body.nativeSessionId, text: body.text, createdAt: now(), status: 'waiting' };
        entries.push(created);
      });
      options.ready(body.hostId);
      return entryOf(created!);
    },
    async cancel(subject: string, id: string): Promise<void> {
      if (own(subject, id).status === 'delivering') throw new OutboxError(409, 'outbox_delivering', 'The Host is delivering this message now.');
      await state.mutate(draft => {
        const entry = draft.outbox?.find(item => item.id === id && item.subject === subject);
        if (!entry) throw new OutboxError(404, 'outbox_missing', 'This message is no longer in the outbox.');
        if (entry.status === 'delivering') throw new OutboxError(409, 'outbox_delivering', 'The Host is delivering this message now.');
        draft.outbox = draft.outbox!.filter(item => item !== entry);
      });
    },
    async retry(subject: string, id: string): Promise<OutboxEntry> {
      const entry = own(subject, id);
      if (entry.status === 'waiting') return entryOf(entry);
      if (entry.status === 'delivering') throw new OutboxError(409, 'outbox_delivering', 'The Host is delivering this message now.');
      let retried: SavedOutboxEntry | undefined;
      await state.mutate(draft => {
        const current = draft.outbox?.find(item => item.id === id && item.subject === subject);
        if (!current) throw new OutboxError(404, 'outbox_missing', 'This message is no longer in the outbox.');
        if (current.status === 'delivering') throw new OutboxError(409, 'outbox_delivering', 'The Host is delivering this message now.');
        current.status = 'waiting'; delete current.error; delete current.claimedAt;
        retried = { ...current };
      });
      options.ready(entry.hostId);
      return entryOf(retried!);
    },
    /** A Controller's call for the messages of its Host. */
    async hostCall(hostId: string, call: unknown): Promise<unknown> {
      if (!isOutboxHostCall(call)) throw new OutboxError(400, 'invalid_outbox_call', 'Invalid outbox call.');
      const request = call as OutboxHostCall;
      if (request.action === 'poll') return { entries: saved().filter(entry => entry.hostId === hostId && (entry.status === 'waiting' || entry.status === 'delivering')).map(deliveryOf) };
      const entry = saved().find(item => item.id === request.id && item.hostId === hostId);
      if (request.action === 'claim') {
        if (!entry) throw new OutboxError(404, 'outbox_missing', 'This message is no longer in the outbox.');
        if (entry.status !== 'waiting') throw new OutboxError(409, 'outbox_not_waiting', 'This message is not waiting.');
        let claimed: SavedOutboxEntry | undefined;
        await state.mutate(draft => {
          const current = draft.outbox?.find(item => item.id === request.id && item.hostId === hostId);
          if (!current) throw new OutboxError(404, 'outbox_missing', 'This message is no longer in the outbox.');
          if (current.status !== 'waiting') throw new OutboxError(409, 'outbox_not_waiting', 'This message is not waiting.');
          current.status = 'delivering'; current.claimedAt = now();
          claimed = { ...current };
        });
        return deliveryOf(claimed!);
      }
      // Settling again after a lost answer finds an accepted message gone.
      if (!entry) return { ok: true };
      if (entry.status !== 'delivering') throw new OutboxError(409, 'outbox_not_delivering', 'This message is not being delivered.');
      await state.mutate(draft => {
        const current = draft.outbox?.find(item => item.id === request.id && item.hostId === hostId);
        if (!current || current.status !== 'delivering') return;
        if (request.outcome === 'accepted') { draft.outbox = draft.outbox!.filter(item => item !== current); return; }
        current.status = request.outcome === 'rejected' ? 'failed' : 'unknown';
        current.error = request.error ?? (request.outcome === 'rejected' ? 'The session did not take the message.' : 'Check the conversation before sending it again.');
        delete current.claimedAt;
      });
      return { ok: true };
    },
  };
}
