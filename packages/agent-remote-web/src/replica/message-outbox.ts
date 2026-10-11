import type { ProjectedTimelineEntry, UserMessagePart } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, OutgoingMessage } from './types.js';

/** A native echo can arrive before acknowledgement or later through history recovery. */
export class MessageOutbox {
  private readonly digests = new WeakMap<object, { text: string; pending: boolean; value?: string }>();
  constructor(private readonly onDigest: () => void = () => {}) {}

  create(state: AgentReplicaState, agentId: string, text: string, delivery?: OutgoingMessage['delivery'], operationId?: string, rich?: Pick<OutgoingMessage, 'content' | 'imageDigests'>): OutgoingMessage {
    return { id: `outgoing-${crypto.randomUUID()}`, operationId, agentId, text, ...(rich ? structuredClone(rich) : {}), delivery, status: 'sending',
      epoch: state.timeline.epoch, afterSeq: state.timeline.nextSeq - 1 };
  }

  reconcile(state: AgentReplicaState): AgentReplicaState {
    const outgoing = state.outgoingMessages;
    if (!outgoing?.length) return state;
    // Hash only candidate echoes. A completed digest rechecks the current replica,
    // so an asynchronous result cannot settle an obsolete epoch or submission.
    if (!this.prepareDigests(state)) return state;
    const consumed = new Set<number>();
    let changed = false;
    const remaining: OutgoingMessage[] = [];
    for (const message of outgoing) {
      if (message.agentId !== state.agent?.id || message.status === 'failed') { remaining.push(message); continue; }
      if (message.epoch !== state.timeline.epoch) {
        if (state.timeline.initialized && message.status !== 'unconfirmed') {
          remaining.push({ ...message, status: 'unconfirmed', error: 'Conversation history changed before delivery could be confirmed.' });
          changed = true;
        } else remaining.push(message);
        continue;
      }
      // A complete echo is assigned once, including mixed prepared and plain text.
      const echo = state.timeline.entries.find(entry => entry.seqStart > message.afterSeq
        && !consumed.has(entry.seqStart) && !message.consumedEchoSeqs?.includes(entry.seqStart)
        && this.matches(message, entry));
      if (echo) {
        consumed.add(echo.seqStart);
        changed = true;
      } else remaining.push(message);
    }
    // A late ACK can reveal that a different caller text prepared the same echo.
    // Retain consumed occurrences even before that evidence arrives or after reload.
    const pending = remaining.map(message => {
      if (message.agentId !== state.agent?.id || message.status === 'failed' || message.epoch !== state.timeline.epoch || !consumed.size) return message;
      const afterSeq = state.timeline.entries.reduce((seq, entry) => consumed.has(entry.seqStart) && this.matches(message, entry)
        ? Math.max(seq, entry.seqStart) : seq, message.afterSeq);
      const consumedEchoSeqs = [...new Set([...(message.consumedEchoSeqs ?? []), ...consumed])].filter(seq => seq > afterSeq);
      return { ...message, afterSeq, consumedEchoSeqs };
    });
    return changed ? { ...state, outgoingMessages: pending } : state;
  }

  private matches(message: OutgoingMessage, entry: ProjectedTimelineEntry): boolean {
    if (entry.item.type !== 'user_message') return false;
    if (message.submittedTextSha256 !== undefined) {
      return !message.content?.some(part => part.type === 'image') && !entry.item.content?.some(part => part.type === 'image')
        && this.digests.get(entry.item)?.value === message.submittedTextSha256;
    }
    const key = outgoingKey(message);
    return key !== undefined && echoKey(entry.item.text, entry.item.content) === key;
  }

  private prepareDigests(state: AgentReplicaState): boolean {
    const candidates = state.outgoingMessages?.filter(message => message.submittedTextSha256 !== undefined
      && message.agentId === state.agent?.id && message.epoch === state.timeline.epoch && message.status !== 'failed'
      && !message.content?.some(part => part.type === 'image')) ?? [];
    if (!candidates.length) return true;
    let ready = true;
    for (const { item, seqStart } of state.timeline.entries) {
      if (item.type !== 'user_message' || item.content?.some(part => part.type === 'image')
        || !candidates.some(message => seqStart > message.afterSeq && !message.consumedEchoSeqs?.includes(seqStart))) continue;
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

function normalize(text: string): string { return text.replace(/\r\n/g, '\n').trim(); }

function outgoingKey(message: OutgoingMessage): string | undefined {
  if (!message.content?.some(part => part.type === 'image')) return `text:${normalize(message.text)}`;
  return orderedKey(message.content.map(part => part.type === 'text' ? part : { type: 'image', sha256: message.imageDigests?.[part.attachmentId] }));
}
function echoKey(text: string, content?: readonly UserMessagePart[]): string | undefined {
  if (!content?.some(part => part.type === 'image')) return `text:${normalize(text)}`;
  return orderedKey(content);
}
function orderedKey(parts: readonly ({ type: 'text'; text: string } | { type: 'image'; sha256?: string })[]): string | undefined {
  const key: Array<[string, string]> = [];
  for (const part of parts) {
    if (part.type === 'image') {
      if (!part.sha256) return undefined;
      key.push(['image', part.sha256]);
    } else {
      const text = part.text.replace(/\r\n/g, '\n');
      if (!text) continue;
      if (key.at(-1)?.[0] === 'text') key[key.length - 1]![1] += text;
      else key.push(['text', text]);
    }
  }
  return `content:${JSON.stringify(key)}`;
}
