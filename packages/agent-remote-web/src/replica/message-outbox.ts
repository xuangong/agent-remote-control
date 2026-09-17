import type { AgentReplicaState, OutgoingMessage } from './types.js';

/** A native echo can arrive before acknowledgement or later through history recovery. */
export class MessageOutbox {
  private nextId = 0;
  private readonly consumed = new Set<string>();

  create(state: AgentReplicaState, agentId: string, text: string, delivery?: OutgoingMessage['delivery']): OutgoingMessage {
    return { id: `outgoing-${++this.nextId}`, agentId, text, delivery, status: 'sending',
      epoch: state.timeline.epoch, afterSeq: state.timeline.nextSeq - 1 };
  }

  reconcile(state: AgentReplicaState): AgentReplicaState {
    const outgoing = state.outgoingMessages;
    if (!outgoing?.length) { this.consumed.clear(); return state; }
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
      // Providers do not echo the Relay request ID. Match only new user entries,
      // consuming each occurrence once so repeated identical sends stay distinct.
      const echo = state.timeline.entries.find(entry => entry.seqStart > message.afterSeq
        && entry.item.type === 'user_message' && normalize(entry.item.text) === normalize(message.text)
        && !this.consumed.has(JSON.stringify([state.timeline.epoch, entry.providerId, entry.seqStart])));
      if (echo) {
        this.consumed.add(JSON.stringify([state.timeline.epoch, echo.providerId, echo.seqStart]));
        changed = true;
      } else remaining.push(message);
    }
    if (!remaining.length) this.consumed.clear();
    return changed ? { ...state, outgoingMessages: remaining } : state;
  }
}

function normalize(text: string): string { return text.replace(/\r\n/g, '\n').trim(); }
