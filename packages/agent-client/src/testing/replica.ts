import { PROTOCOL_VERSION, type AgentStreamMessage, type HistoryPage, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { AgentReplica } from '../replica/store.js';
import { buildEntry, buildSessionToStore } from './builders.js';

/** A tail page of a session at `epoch`: `entries` are the newest rows and the window ends after the last of them. */
export function buildTailPage(entries: readonly ProjectedTimelineEntry[], options: { epoch?: string; hasOlder?: boolean; agentId?: string } = {}): HistoryPage {
  const { epoch = 'e1', hasOlder = false, agentId = 'agent-1' } = options;
  const first = entries[0]?.seqStart, last = entries.at(-1)?.seqEnd;
  return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'page', agentId, direction: 'tail', error: null, hasNewer: false, epoch, reset: false, staleCursor: false, gap: false,
    window: { minSeq: first ?? 1, maxSeq: last ?? 0, nextSeq: (last ?? 0) + 1 },
    startCursor: first === undefined ? null : { epoch, seq: first }, endCursor: last === undefined ? null : { epoch, seq: last },
    hasOlder, entries: [...entries] } };
}

/** The page frames that make `rows` messages the newest window of an epoch, with the keys `m1`, `m2`, ... */
export const buildTailRows = (rows: number, text?: string): ProjectedTimelineEntry[] => Array.from({ length: rows }, (_, at) => buildEntry(at + 1, text));

/** A replica that has read nothing but the device's record: `rows` messages restored at `epoch`, marked restored, never authoritative. */
export function buildRestoredReplica(options: { rows?: number; text?: string; epoch?: string } = {}): AgentReplica {
  const { rows = 3, text, epoch = 'e1' } = options;
  const replica = new AgentReplica();
  const session = buildSessionToStore(rows, { text, epoch });
  replica.restoreFromDevice({ snapshot: session.snapshot, epoch: session.epoch, nextSeq: session.nextSeq, hasOlder: session.hasOlder, entries: session.entries });
  return replica;
}

/** A replica that has read `rows` messages from the Relay, as after its first tail page. */
export function buildReplica(options: { rows?: number; text?: string; epoch?: string } = {}): AgentReplica {
  const { rows = 3, text, epoch = 'e1' } = options;
  return replicaAfter([buildTailPage(buildTailRows(rows, text), { epoch })]);
}

/** The replica after absorbing `frames` in order: tail and history pages, and live stream messages. */
export function replicaAfter(frames: ReadonlyArray<HistoryPage | AgentStreamMessage>, replica = new AgentReplica()): AgentReplica {
  for (const frame of frames) {
    if (frame.type === 'timeline_page') replica.applyHistory(frame);
    else replica.applyStream(frame);
  }
  return replica;
}
