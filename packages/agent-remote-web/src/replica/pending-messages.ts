import { withoutSessionReferenceNote, type ProjectedTimelineEntry, type UserMessagePart } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, OutgoingMessage } from './types.js';
import { transition } from './send-state.js';
import { timelineEntryKey } from './timeline-entry-key.js';

/** A native echo can arrive before acknowledgement or later through history recovery. */
export class PendingMessages {
  private readonly digests = new WeakMap<object, { text: string; pending: boolean; value?: string }>();
  constructor(private readonly onDigest: () => void = () => {}) {}

  create(state: AgentReplicaState, agentId: string, text: string, delivery?: OutgoingMessage['delivery'], operationId?: string, rich?: Pick<OutgoingMessage, 'content' | 'imageDigests'>): OutgoingMessage {
    return { id: `outgoing-${crypto.randomUUID()}`, operationId, agentId, text, ...(rich ? structuredClone(rich) : {}), delivery, status: 'sending',
      afterKey: anchorNow(state) };
  }

  /** The anchor a message keeps when it is sent again: its own while that row is held, the newest row otherwise. */
  anchorFor(state: AgentReplicaState, message: OutgoingMessage): string | undefined {
    return message.afterKey !== undefined && anchorPosition(state, message.afterKey) !== undefined ? message.afterKey : anchorNow(state);
  }

  reconcile(state: AgentReplicaState): AgentReplicaState {
    const outgoing = state.outgoingMessages;
    if (!outgoing?.length) return state;
    // The rows of a replacement that has not been read yet are not the rows an echo will be found in.
    if (state.timeline.pendingEpoch !== undefined) return state;
    // Hash only candidate echoes. A completed digest rechecks the current replica,
    // so an asynchronous result cannot settle an obsolete epoch or submission.
    if (!this.prepareDigests(state)) return state;
    const entries = state.timeline.entries;
    const keys = entries.map(entry => timelineEntryKey(state.timeline.epoch, entry));
    const consumed = new Set<string>();
    let changed = false;
    const remaining: OutgoingMessage[] = [];
    for (const message of outgoing) {
      if (message.agentId !== state.agent?.id || message.status === 'failed') { remaining.push(message); continue; }
      const after = message.afterKey === undefined ? undefined : anchorPosition(state, message.afterKey, keys);
      if (after === undefined) {
        // The row the message was sent after is gone (a replacement rewrote it), or it was sent before the conversation was read
        // (or written before row keys): its echo cannot be told from older history.
        const step = transition(message.status, { type: 'history_changed' });
        if (state.timeline.initialized && step.state !== message.status && step.state !== 'delivered') {
          remaining.push({ ...message, status: step.state, error: step.error ?? undefined });
          changed = true;
        } else remaining.push(message);
        continue;
      }
      // A complete echo is assigned once, including mixed prepared and plain text.
      const at = entries.findIndex((entry, index) => index > after
        && !consumed.has(keys[index]!) && !message.consumedEchoKeys?.includes(keys[index]!)
        && this.matches(message, entry));
      if (at >= 0 && transition(message.status, { type: 'echoed' }).state === 'delivered') {
        consumed.add(keys[at]!);
        changed = true;
      } else remaining.push(message);
    }
    // A late ACK can reveal that a different caller text prepared the same echo.
    // Retain consumed occurrences even before that evidence arrives or after reload.
    const pending = remaining.map(message => {
      if (message.agentId !== state.agent?.id || message.status === 'failed' || message.afterKey === undefined || !consumed.size) return message;
      const start = anchorPosition(state, message.afterKey, keys);
      if (start === undefined) return message;
      let afterAt = start;
      entries.forEach((entry, index) => { if (consumed.has(keys[index]!) && this.matches(message, entry)) afterAt = Math.max(afterAt, index); });
      const afterKey = afterAt < 0 ? message.afterKey : anchorOfEntry(state, entries[afterAt]!);
      const consumedEchoKeys = [...new Set([...(message.consumedEchoKeys ?? []), ...consumed])].filter(key => keys.indexOf(key) > afterAt);
      return { ...message, afterKey, consumedEchoKeys };
    });
    return changed ? { ...state, outgoingMessages: pending } : state;
  }

  private matches(message: OutgoingMessage, entry: ProjectedTimelineEntry): boolean {
    if (entry.item.type !== 'user_message') return false;
    if (message.submittedTextSha256 !== undefined) {
      return !message.content?.some(part => part.type !== 'text') && !entry.item.content?.some(part => part.type !== 'text')
        && this.digests.get(entry.item)?.value === message.submittedTextSha256;
    }
    const key = outgoingKey(message);
    return key !== undefined && echoKey(entry.item.text, entry.item.content) === key;
  }

  private prepareDigests(state: AgentReplicaState): boolean {
    const keys = state.timeline.entries.map(entry => timelineEntryKey(state.timeline.epoch, entry));
    const candidates = (state.outgoingMessages?.filter(message => message.submittedTextSha256 !== undefined
      && message.agentId === state.agent?.id && message.afterKey !== undefined && message.status !== 'failed'
      && !message.content?.some(part => part.type !== 'text')) ?? []).map(message => ({ message, after: anchorPosition(state, message.afterKey!, keys) }))
      .filter((candidate): candidate is { message: OutgoingMessage; after: number } => candidate.after !== undefined);
    if (!candidates.length) return true;
    let ready = true;
    for (const [index, { item }] of state.timeline.entries.entries()) {
      if (item.type !== 'user_message' || item.content?.some(part => part.type !== 'text')
        || !candidates.some(({ message, after }) => index > after && !message.consumedEchoKeys?.includes(keys[index]!))) continue;
      let digest = this.digests.get(item);
      if (!digest || digest.text !== item.text) {
        digest = { text: item.text, pending: true };
        this.digests.set(item, digest);
        const retained = digest;
        void Promise.resolve().then(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(retained.text)))
          .then(value => { retained.value = Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''); }, () => {})
          .then(() => { retained.pending = false; this.onDigest(); });
      }
      if (digest.pending) ready = false;
    }
    return ready;
  }
}

/**
 * The anchor of a message sent now: the key of the newest row, `epoch-start:<epoch>` for a conversation read with no rows, undefined
 * before it was read.
 */
export function anchorNow(state: AgentReplicaState): string | undefined {
  if (!state.timeline.initialized) return undefined;
  const last = state.timeline.entries.at(-1);
  return last ? anchorOfEntry(state, last) : `${EPOCH_START}${state.timeline.epoch ?? ''}`;
}

/** A stream without item keys names a position, not a row: a row can be folded into an earlier one, and its key would then vanish. */
function anchorOfEntry(state: AgentReplicaState, entry: AgentReplicaState['timeline']['entries'][number]): string {
  return entry.itemKey === undefined ? `${SEQUENCE}${state.timeline.epoch ?? ''}:${entry.seqEnd}` : timelineEntryKey(state.timeline.epoch, entry);
}

const EPOCH_START = 'epoch-start:';
const SEQUENCE = 'epoch-seq:';

/**
 * Where the row of an anchor stands among the rows: its index, -1 for the start of the epoch the anchor names, undefined when the
 * replica no longer holds the row or the epoch (a replacement rewrote it). A position anchor (a stream without item keys) stands
 * after the last row that ends at or before its sequence.
 */
export function anchorPosition(state: AgentReplicaState, afterKey: string, keys = state.timeline.entries.map(entry => timelineEntryKey(state.timeline.epoch, entry))): number | undefined {
  if (afterKey.startsWith(EPOCH_START)) return afterKey === `${EPOCH_START}${state.timeline.epoch ?? ''}` ? -1 : undefined;
  if (afterKey.startsWith(SEQUENCE)) {
    const at = afterKey.lastIndexOf(':');
    if (afterKey.slice(SEQUENCE.length, at) !== (state.timeline.epoch ?? '')) return undefined;
    const seq = Number(afterKey.slice(at + 1));
    let position = -1;
    state.timeline.entries.forEach((entry, index) => { if (entry.seqEnd <= seq) position = index; });
    return position;
  }
  const index = keys.indexOf(afterKey);
  return index < 0 ? undefined : index;
}

// A Host adds a reference note to the input it delivers; the echo is matched as its sender wrote it.
function normalize(text: string): string { return withoutSessionReferenceNote(text.replace(/\r\n/g, '\n')).trim(); }

function outgoingKey(message: OutgoingMessage): string | undefined {
  if (!message.content?.some(part => part.type !== 'text')) return `text:${normalize(message.text)}`;
  return orderedKey(message.content.map(part => part.type === 'text' ? part : part.type === 'resource' ? { type: 'resource', locator: `input-resource:${part.resourceId}` } : { type: 'image', sha256: message.imageDigests?.[part.attachmentId] }));
}
function echoKey(text: string, content?: readonly UserMessagePart[]): string | undefined {
  if (!content?.some(part => part.type !== 'text')) return `text:${normalize(text)}`;
  return orderedKey(content);
}
function orderedKey(parts: readonly ({ type: 'text'; text: string } | { type: 'image'; sha256?: string } | { type: 'resource'; locator: string })[]): string | undefined {
  const key: Array<[string, string]> = [];
  for (const part of parts) {
    if (part.type === 'resource') { key.push(['resource', part.locator]); } else if (part.type === 'image') {
      if (!part.sha256) return undefined;
      key.push(['image', part.sha256]);
    } else {
      const text = part.text.replace(/\r\n/g, '\n');
      if (!text) continue;
      if (key.at(-1)?.[0] === 'text') key[key.length - 1]![1] += text;
      else key.push(['text', text]);
    }
  }
  return `content:${JSON.stringify(key.map(([type, value]) => type === 'text' ? [type, withoutSessionReferenceNote(value)] : [type, value]))}`;
}
