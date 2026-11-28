/**
 * What started a bot's turn, and what the turn cost (bots design 7). The Controller sees every input a session takes: the person's
 * own words, or input the Relay framed for it. The latest one is the cause of the session's turn; a bot's tool calls carry it, so the
 * Relay finds the turn's chain, and the turn's usage is counted in that chain when the turn ends.
 */
import { createHash } from 'node:crypto';
import { CHAIN_APPROVAL_POLICY, nativeSessionRefKey, parseTaskInputs, type AgentInteractionRequest, type AgentInteractionResponse, type NativeSessionRef, type TurnCause } from '@orchardworks/agent-remote-protocol';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { accountUsage, type SessionUsage } from '../session-usage.js';

/** An ended turn: what started it, how it ended (finished unless it failed or was canceled), what it cost, and the last text the session wrote in it. */
export interface TurnReport { cause: TurnCause; tokens: number; costUsd?: number; finalText?: string; outcome?: 'finished' | 'failed' | 'interrupted' }

/** The cause of each session's latest input, by native session. */
export class TurnCauses {
  private readonly causes = new Map<string, TurnCause>();
  of(ref: NativeSessionRef): TurnCause | undefined { return this.causes.get(nativeSessionRefKey(ref)); }
  set(ref: NativeSessionRef, cause: TurnCause): void { this.causes.set(nativeSessionRefKey(ref), cause); }
}

/**
 * The person's standing approvals of a chain, as this session's Controller applies them (bots plan 9d). The person decides: they chose
 * "for this chain in this folder" on one request, and `allow` applies that same decision to the next request of any kind in the
 * same folder from the same chain. Nothing else is ever answered here.
 */
export interface ChainApprovals {
  /** The session is a bot's, so the choice is offered on its native tool approvals. */
  offered(): boolean;
  /** Whether a standing approval of the turn's chain covers tool use in this folder; counts the use. */
  covers(cwd: string): Promise<boolean>;
  /** Records the person's choice for the turn's chain. */
  grant(cwd: string): Promise<void>;
  /** Answers the pending request with the person's recorded decision: allow once. */
  allow(requestId: string): Promise<void>;
}
const fail = (message: string): never => { throw new Error(message); };
type ToolApproval = Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
const ALLOW_ONCE: AgentInteractionResponse = { kind: 'tool_approval', decision: 'allow', scope: 'once' };
const chainChoice = (request: ToolApproval): ToolApproval => ({ ...request, allowScopes: request.allowScopes.includes('policy') ? request.allowScopes : [...request.allowScopes, 'policy'],
  policies: [...request.policies ?? [], { policyId: CHAIN_APPROVAL_POLICY, description: 'Allow every tool use in this folder for every bot of this chain, until the chain ends.' }] });
/** A request the chain choice can be made on: allow once is a decision it offers. */
const chainable = (request: AgentInteractionRequest): request is ToolApproval => request.kind === 'tool_approval' && request.allowedDecisions.includes('allow')
  && request.allowScopes.includes('once') && !request.policies?.some(policy => policy.policyId === CHAIN_APPROVAL_POLICY);

/**
 * The cause an input gives its turn: framed input is the Relay's, anything else the person's, named by its message. A framed input
 * that is exactly one message from another bot, and not the final answer of a turn, also names that message: the turn's final text answers it
 * (bots design 3.3). Standing instructions are not messages; anything else beside the message means the turn answers none. Input that
 * is only what the person asked from another conversation (an answer session's) makes the turn's final text the answer to them.
 */
export function inputCause(item: { text: string; messageId?: string; clientMessageId?: string }): TurnCause {
  const inputs = parseTaskInputs(item.text.trim());
  if (inputs) {
    const messages = inputs.filter(input => input.kind !== 'standing' && input.kind !== 'work_log'), only = messages.length === 1 ? messages[0] : undefined;
    if (messages.length > 0 && messages.every(input => input.kind === 'ask')) return { kind: 'framed', asked: true };
    return only?.kind === 'assistant' && !only.final ? { kind: 'framed', answers: only.messageId } : { kind: 'framed' };
  }
  return { kind: 'person', messageId: item.messageId ?? item.clientMessageId ?? createHash('sha256').update(item.text).digest('hex').slice(0, 64) };
}

/** What the person wrote into the session: their words and the id of the message. */
export interface PersonInput { messageId: string; text: string }

/** Passes a session's stream through, noting the cause of each input, reporting each ended turn with its usage, and each input the person typed. */
export function watchChainTurns(session: AgentSession, ref: NativeSessionRef, causes: TurnCauses, report: (turn: TurnReport) => void, written: (input: PersonInput) => void = () => {}, approvals?: ChainApprovals): AgentSession {
  const usage: SessionUsage = { tokens: 0 };
  let counted = { tokens: 0, costUsd: 0 };
  // The bot's last run of assistant text in the turn: a tool call or another message starts a new run.
  let final = '', writing = false, writingId: string | undefined, directory: string | undefined;
  // The requests a chain choice was added to, as the adapter reported them: the choice itself is never sent to the adapter.
  const offered = new Map<string, ToolApproval>();
  const folder = async (): Promise<string | undefined> => directory ??= (await session.runtimeInfo().catch(() => undefined))?.cwd;
  async function* observe(): AsyncGenerator<ProviderStreamItem> {
    const source = session.observe()[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result = await source.next();
        if (result.done) return;
        let item = result.value, autoAnswer: (() => void) | undefined;
        if (item.type === 'observation' && item.delivery !== 'history') {
          const event = item.event;
          if (event.type === 'runtime_updated' && event.runtimeInfo.cwd) directory = event.runtimeInfo.cwd;
          if ((event.type === 'interaction_resolved' || event.type === 'interaction_invalidated')) offered.delete(event.requestId);
          if (event.type === 'interaction_requested' && approvals?.offered() && chainable(event.request)) {
            const request = event.request, cwd = await folder();
            if (cwd) {
              offered.set(request.requestId, request);
              item = { ...item, event: { ...event, request: chainChoice(request) } };
              // After the request is delivered to the session's state, a standing approval of the chain answers it like the person would.
              autoAnswer = () => { void approvals.covers(cwd).then(covered => covered ? approvals.allow(request.requestId) : undefined).catch(() => undefined); };
            }
          }
          if (event.type === 'timeline' && event.item.type === 'user_message' && !event.item.withdrawn && event.item.text.trim()) {
            const cause = inputCause(event.item);
            causes.set(ref, cause); final = ''; writing = false;
            if (cause.kind === 'person') written({ messageId: cause.messageId, text: event.item.text.trim() });
          }
          if (event.type === 'timeline' && event.item.type === 'assistant_message') {
            if (!writing || event.item.messageId !== undefined && writingId !== undefined && event.item.messageId !== writingId) final = '';
            final += event.item.text; writing = true; writingId = event.item.messageId;
          } else if (event.type === 'timeline' && event.item.type !== 'reasoning' && event.item.type !== 'user_message') writing = false;
          if (event.type === 'usage_updated') accountUsage(usage, event.usage, false);
          if (event.type === 'turn_failed' || event.type === 'turn_canceled') {
            const cause = causes.of(ref), text = (event.type === 'turn_failed' ? final.trim() || event.error : final.trim() || event.reason).trim();
            final = ''; writing = false;
            if (cause) report({ cause, tokens: 0, outcome: event.type === 'turn_failed' ? 'failed' : 'interrupted', ...(text ? { finalText: text } : {}) });
          }
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
        autoAnswer?.();
      }
    } finally { await source.return?.(); }
  }
  return new Proxy(session, { get(target, key) {
    if (key === 'observe') return observe;
    if (key === 'respondToInteraction') return async (requestId: string, response: AgentInteractionResponse) => {
      const original = offered.get(requestId);
      // The person's choice for the chain: recorded, and the adapter hears the ordinary allow once.
      if (original && response.kind === 'tool_approval' && response.decision === 'allow' && response.scope === 'policy' && response.policyId === CHAIN_APPROVAL_POLICY) {
        const cwd = await folder() ?? fail('This session\'s working directory is unknown.');
        await approvals!.grant(cwd);
        response = ALLOW_ONCE;
      }
      return target.respondToInteraction(requestId, response);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
