import type { UserMessagePart } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, OutgoingMessage } from './types.js';

/** A native echo can arrive before acknowledgement or later through history recovery. */
export class MessageOutbox {

  create(state: AgentReplicaState, agentId: string, text: string, delivery?: OutgoingMessage['delivery'], operationId?: string, rich?: Pick<OutgoingMessage, 'content' | 'imageDigests'>): OutgoingMessage {
    return { id: `outgoing-${crypto.randomUUID()}`, operationId, agentId, text, ...(rich ? structuredClone(rich) : {}), delivery, status: 'sending',
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
      const key = outgoingKey(message);
      const echo = key === undefined ? undefined : state.timeline.entries.find(entry => entry.seqStart > message.afterSeq
        && entry.item.type === 'user_message' && echoKey(entry.item.text, entry.item.content) === key
        && entry.seqStart > (consumed.get(key!) ?? -1));
      if (echo) {
        consumed.set(key!, echo.seqStart);
        changed = true;
      } else remaining.push(message);
    }
    // Retain the consumed cursor with each identical input so a page restart
    // cannot reuse an earlier echo for a different pending submission.
    const pending = remaining.map(message => {
      const seq = consumed.get(outgoingKey(message) ?? '');
      if (message.status === 'failed' || message.epoch !== state.timeline.epoch || seq === undefined || seq <= message.afterSeq) return message;
      return { ...message, afterSeq: seq };
    });
    return changed ? { ...state, outgoingMessages: pending } : state;
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
