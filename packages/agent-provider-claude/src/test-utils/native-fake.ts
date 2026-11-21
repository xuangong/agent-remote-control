import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import { followSession, type ProviderNativeFake } from '@orchardworks/agent-provider-sdk/conformance';

import type { ClaudeTimelineMessage } from '../catalog.js';
import { ClaudeAgentSession } from '../session.js';

/**
 * The Claude Code adapter driven by a scripted Agent SDK query in place of the CLI, for the provider conformance kit
 * (`@orchardworks/agent-provider-sdk/conformance`). The query yields the messages of Agent SDK 0.3.247 (`SDKMessage`); history is the
 * transcript's records as the catalog reads them (`SessionMessage`, with the turn each belongs to). A session opens the adapter's own
 * session over them; reading the transcript from disk is the catalog's part, tested with it.
 */
const SESSION = 'native';
/** A message type and a record subtype no Claude Code release the adapter knows has written, as a CLI update could add them. */
const UNKNOWN_MESSAGE = { type: 'hologram', session_id: SESSION, uuid: 'hologram-live' };
const unknownRecord = (uuid: string): ClaudeTimelineMessage => ({ type: 'system', subtype: 'hologram', uuid, session_id: SESSION, message: null, parent_tool_use_id: null, parent_agent_id: null } as ClaudeTimelineMessage);

/** A record of the transcript, with the turn the catalog says it belongs to: the uuid of the turn's user message. */
const user = (uuid: string, text: string): ClaudeTimelineMessage =>
  ({ type: 'user', uuid, session_id: SESSION, message: { role: 'user', content: text }, parent_tool_use_id: null, parent_agent_id: null, turnId: uuid });
const assistant = (uuid: string, messageId: string, text: string) =>
  ({ type: 'assistant' as const, uuid, session_id: SESSION, message: { id: messageId, role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text }] }, parent_tool_use_id: null, parent_agent_id: null });
const inTurn = (record: ReturnType<typeof assistant>, turnId: string): ClaudeTimelineMessage => ({ ...record, turnId });
const result = (uuid: string, turnId: string, failed = false) =>
  ({ type: 'result', subtype: 'success', is_error: failed, session_id: SESSION, uuid, user_message_uuid: turnId, usage: {} });

/** An Agent SDK query the fake plays: what it yields, and the input the session writes to it. */
function scriptedQuery() {
  const pending: unknown[] = [];
  let release: (() => void) | undefined;
  let closed = false;
  let input!: AsyncIterator<SDKUserMessage>;
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (pending.length) yield pending.shift();
        else await new Promise<void>(resolve => { release = resolve; });
      }
    },
    async initializationResult() { return {}; },
    async interrupt() { return { still_queued: [], cancelled: [] }; },
    async setPermissionMode() {},
    close() { closed = true; release?.(); },
  };
  return {
    push(message: unknown) { pending.push(message); release?.(); },
    nextInput: () => input.next(),
    factory(args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) { input = args.prompt[Symbol.asyncIterator](); return query as never; },
  };
}

async function open(history: ClaudeTimelineMessage[], diagnostics: string[]) {
  const native = scriptedQuery();
  const session = await ClaudeAgentSession.open({ sessionId: SESSION }, { query: native.factory, onDiagnostic: line => diagnostics.push(line) }, history);
  return { native, session, seen: followSession(session as AgentSession) };
}

export function claudeNativeFake(): ProviderNativeFake {
  return {
    async turn({ inputId, unknown }) {
      const diagnostics: string[] = [];
      let unknownSent = 0;
      const transcript = [user('user-1', 'Hello'), ...(unknown ? [unknownRecord('hologram-1')] : []), inTurn(assistant('assistant-1', 'msg-1', 'Hi'), 'user-1')];
      const first = await open(transcript, diagnostics);
      if (unknown) unknownSent += 1;
      try {
        await first.seen.boundary();
        await first.session.sendMessage('Next', { inputId });
        const input = (await first.native.nextInput()).value as SDKUserMessage;
        if (unknown) { unknownSent += 1; first.native.push(UNKNOWN_MESSAGE); }
        first.native.push(assistant('assistant-2', 'msg-2', 'Reply to Next'));
        first.native.push(result('result-2', input.uuid!));
        await first.seen.until(() => first.seen.events().some(event => event.type === 'turn_completed'), 'the end of the live turn');
      } finally { await first.session.dispose(); await first.seen.done; }
      // Claude Code keeps the uuid a message was sent with as its record's (FL1); the catalog gives each record the turn it belongs to.
      transcript.push(user(inputId, 'Next'), inTurn(assistant('assistant-2', 'msg-2', 'Reply to Next'), inputId));
      const again = await open(transcript, diagnostics);
      if (unknown) unknownSent += 1;
      try { await again.seen.boundary(); } finally { await again.session.dispose(); await again.seen.done; }
      return { live: first.seen.journal(), reread: again.seen.history(), diagnostics, unknownSent };
    },

    async usageLimit() {
      // `rate_limit_event` (Agent SDK 0.3.247 `SDKRateLimitEvent`): status `rejected` until `resetsAt`, in seconds.
      const resetsAtS = 1_800_000_000;
      const { native, session, seen } = await open([], []);
      try {
        await seen.boundary();
        await session.sendMessage('Over the limit');
        const input = (await native.nextInput()).value as SDKUserMessage;
        native.push({ type: 'rate_limit_event', session_id: SESSION, uuid: 'limit', rate_limit_info: { status: 'rejected', resetsAt: resetsAtS, rateLimitType: 'five_hour' } });
        native.push(result('limited', input.uuid!, true));
        await seen.until(() => seen.events().some(event => event.type === 'turn_failed'), 'the failed turn');
        return { events: seen.events(), runtime: await session.runtimeInfo(), resetsAt: resetsAtS * 1000 };
      } finally { await session.dispose(); await seen.done; }
    },
  };
}
