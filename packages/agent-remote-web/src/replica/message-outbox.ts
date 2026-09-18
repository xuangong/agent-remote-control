import type { AgentReplicaState, OutgoingMessage } from './types.js';

/** A native echo can arrive before acknowledgement or later through history recovery. */
export class MessageOutbox {

  create(state: AgentReplicaState, agentId: string, text: string, delivery?: OutgoingMessage['delivery'], operationId?: string): OutgoingMessage {
    return { id: `outgoing-${crypto.randomUUID()}`, operationId, agentId, text, delivery, status: 'sending',
      epoch: state.timeline.epoch, afterSeq: state.timeline.nextSeq - 1 };
  }

  reconcile(state: AgentReplicaState): AgentReplicaState {
    const outgoing = state.outgoingMessages;
    if (!outgoing?.length) return state;
    const consumed = new Map<string, number>();
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
        && entry.seqStart > (consumed.get(normalize(message.text)) ?? -1));
      if (echo) {
        consumed.set(normalize(message.text), echo.seqStart);
        changed = true;
      } else remaining.push(message);
    }
    // Retain the consumed cursor with each identical input so a page restart
    // cannot reuse an earlier echo for a different pending submission.
    const pending = remaining.map(message => {
      const seq = consumed.get(normalize(message.text));
      if (message.status === 'failed' || message.epoch !== state.timeline.epoch || seq === undefined || seq <= message.afterSeq) return message;
      return { ...message, afterSeq: seq };
    });
    return changed ? { ...state, outgoingMessages: pending } : state;
  }
}

function normalize(text: string): string { return text.replace(/\r\n/g, '\n').trim(); }
