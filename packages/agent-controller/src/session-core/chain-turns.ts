/**
 * What started a bot's turn, and what the turn cost (bots design 7). The Controller sees every input a session takes: the person's
 * own words, or input the Relay framed for it. The latest one is the cause of the session's turn; a bot's tool calls carry it, so the
 * Relay finds the turn's chain, and the turn's usage is counted in that chain when the turn ends.
 */
import { createHash } from 'node:crypto';
import { nativeSessionRefKey, parseTaskInputs, type NativeSessionRef, type TurnCause } from '@orchardworks/agent-remote-protocol';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { accountUsage, type SessionUsage } from '../session-usage.js';

/** An ended turn: what started it, what it cost, and the last text the bot wrote in it. */
export interface TurnReport { cause: TurnCause; tokens: number; costUsd?: number; finalText?: string }

/** The cause of each session's latest input, by native session. */
export class TurnCauses {
  private readonly causes = new Map<string, TurnCause>();
  of(ref: NativeSessionRef): TurnCause | undefined { return this.causes.get(nativeSessionRefKey(ref)); }
  set(ref: NativeSessionRef, cause: TurnCause): void { this.causes.set(nativeSessionRefKey(ref), cause); }
}

/**
 * The cause an input gives its turn: framed input is the Relay's, anything else the person's, named by its message. A framed input
 * that is exactly one message from another bot, and not itself a reply, also names that message: the turn's final text answers it
 * (bots design 3.3). Standing instructions are not messages; anything else beside the message means the turn answers none.
 */
export function inputCause(item: { text: string; messageId?: string; clientMessageId?: string }): TurnCause {
  const inputs = parseTaskInputs(item.text.trim());
  if (inputs) {
    const messages = inputs.filter(input => input.kind !== 'standing'), only = messages.length === 1 ? messages[0] : undefined;
    return only?.kind === 'assistant' && !only.replyTo ? { kind: 'framed', answers: only.messageId } : { kind: 'framed' };
  }
  return { kind: 'person', messageId: item.messageId ?? item.clientMessageId ?? createHash('sha256').update(item.text).digest('hex').slice(0, 64) };
}

/** Passes a session's stream through, noting the cause of each input and reporting each ended turn with its usage. */
export function watchChainTurns(session: AgentSession, ref: NativeSessionRef, causes: TurnCauses, report: (turn: TurnReport) => void): AgentSession {
  const usage: SessionUsage = { tokens: 0 };
  let counted = { tokens: 0, costUsd: 0 };
  // The bot's last run of assistant text in the turn: a tool call or another message starts a new run.
  let final = '', writing = false, writingId: string | undefined;
  async function* observe(): AsyncGenerator<ProviderStreamItem> {
    const source = session.observe()[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result = await source.next();
        if (result.done) return;
        const item = result.value;
        if (item.type === 'observation' && item.delivery !== 'history') {
          const event = item.event;
          if (event.type === 'timeline' && event.item.type === 'user_message' && !event.item.withdrawn && event.item.text.trim()) { causes.set(ref, inputCause(event.item)); final = ''; writing = false; }
          if (event.type === 'timeline' && event.item.type === 'assistant_message') {
            if (!writing || event.item.messageId !== undefined && writingId !== undefined && event.item.messageId !== writingId) final = '';
            final += event.item.text; writing = true; writingId = event.item.messageId;
          } else if (event.type === 'timeline' && event.item.type !== 'reasoning' && event.item.type !== 'user_message') writing = false;
          if (event.type === 'usage_updated') accountUsage(usage, event.usage, false);
          if (event.type === 'turn_completed') {
            if (event.usage) accountUsage(usage, event.usage, true);
            const cause = causes.of(ref), tokens = usage.tokens - counted.tokens, cost = (usage.costUsd ?? 0) - counted.costUsd;
            counted = { tokens: usage.tokens, costUsd: usage.costUsd ?? 0 };
            const finalText = final.trim();
            final = ''; writing = false;
            if (cause) report({ cause, tokens, ...(cost > 0 ? { costUsd: cost } : {}), ...(finalText ? { finalText } : {}) });
          }
        }
        yield item;
      }
    } finally { await source.return?.(); }
  }
  return new Proxy(session, { get(target, key) {
    if (key === 'observe') return observe;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
