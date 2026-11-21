import type { CopilotClient } from '@github/copilot-sdk';
import { followSession, type ProviderNativeFake } from '@orchardworks/agent-provider-sdk/conformance';

import { CopilotAgentProvider } from '../provider.js';

/**
 * The Copilot adapter driven by a scripted client of `@github/copilot-sdk` 1.0.11 in place of the CLI, for the provider conformance kit
 * (`@orchardworks/agent-provider-sdk/conformance`). The client resumes a session whose history is its `getEvents()`, and answers a send
 * with the session events the CLI emits for a turn (`dist/generated/session-events.d.ts`).
 */
const SESSION = '4c1f6a2e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';
const handle = { providerId: 'copilot', sessionId: SESSION, opaque: JSON.stringify({ cwd: process.cwd() }) };
/** An event type no Copilot CLI the adapter knows has emitted, as a CLI update could add one. */
const UNKNOWN_TYPE = 'session.hologram_updated';

interface NativeEvent { id: string; timestamp: string; parentId: null; type: string; data: Record<string, unknown> }
/** The events one play of the CLI emits, numbered from one, so two plays of the same turn name their events alike. */
function events() {
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown> = {}): NativeEvent => ({ id: `event-${++sequence}`, timestamp: new Date(1_795_000_000_000 + sequence * 1000).toISOString(), parentId: null, type, data });
  /** The events of one turn of the CLI: the person's message, a reply, and the turn's end. */
  const turn = (text: string, reply: string, messageId: string) => [event('user.message', { content: text }), event('assistant.turn_start', { turnId: '0' }),
    event('assistant.message', { messageId, content: reply }), event('assistant.turn_end', { turnId: '0' }), event('assistant.idle', {})];
  return { event, turn };
}

/** A Copilot CLI session as the client sees it: its history, the handler of its live events, and what a send makes the CLI do. */
function nativeSession(history: NativeEvent[], onSend: (emit: (value: NativeEvent) => void) => void) {
  let handler: ((value: NativeEvent) => void) | undefined;
  const emit = (value: NativeEvent) => { handler?.(value); };
  const unavailable = async () => { throw new Error('Not played by the native fake.'); };
  return {
    on(listener: (value: NativeEvent) => void) { handler = listener; return () => { handler = undefined; }; },
    getEvents: async () => [...history],
    send: async () => { setImmediate(() => onSend(emit)); return 'message'; },
    abort: async () => {}, disconnect: async () => {},
    rpc: {
      metadata: { isProcessing: async () => ({ processing: false }), contextInfo: async () => ({ contextInfo: null }) },
      usage: { getMetrics: unavailable },
      model: { getCurrent: async () => ({ modelId: 'model-a' }), list: async () => ({ list: [{ id: 'model-a', name: 'Model A' }] }), switchTo: async () => ({}) },
      skills: { ensureLoaded: async () => {}, list: async () => ({ skills: [] }) },
      tasks: { list: async () => ({ tasks: [] }) },
      eventLog: { read: async () => ({ events: [], cursor: 'end', hasMore: false }) },
    },
  };
}

function nativeCopilot(history: NativeEvent[], options: { inUse?: boolean; onSend?: (emit: (value: NativeEvent) => void) => void } = {}) {
  const diagnostics: string[] = [];
  const resume = async () => nativeSession(history, options.onSend ?? (() => {}));
  const client = {
    rpc: { sessions: { checkInUse: async () => ({ inUse: options.inUse ? [SESSION] : [] }), close: async () => ({}) }, skills: { getDiscoveryPaths: async () => ({ paths: [] }) } },
    start: async () => {}, stop: async () => [], forceStop: async () => {},
    createSession: resume, resumeSession: resume, getSessionMetadata: async () => undefined, listSessions: async () => [],
  };
  const provider = new CopilotAgentProvider({ executable: '/native-fake/copilot', client: client as unknown as CopilotClient, onDiagnostic: line => diagnostics.push(line) });
  return { provider, diagnostics };
}

export function copilotNativeFake(): ProviderNativeFake {
  return {
    async turn({ unknown }) {
      let unknownSent = 0;
      const { event, turn } = events();
      const history = [...turn('Hello', 'Hi', 'message-1')];
      const live = turn('Next', 'Reply to Next', 'message-2');
      const strange = [event(UNKNOWN_TYPE, { detail: 'from a newer CLI' }), event(UNKNOWN_TYPE, { detail: 'from a newer CLI' })];
      if (unknown) history.splice(2, 0, strange[0]!);
      const native = nativeCopilot(history, { onSend: emit => {
        emit(live[0]!); emit(live[1]!);
        if (unknown) { unknownSent += 1; emit(strange[1]!); }
        for (const value of live.slice(2)) emit(value);
        history.push(...live);
      } });
      const session = await native.provider.resumeSession(handle);
      if (unknown) unknownSent += 1;
      const seen = followSession(session);
      try {
        await seen.boundary();
        await session.sendMessage('Next');
        await seen.until(() => seen.liveEvents().some(value => value.type === 'turn_completed'), 'the end of the live turn');
      } finally { await session.dispose(); await seen.done; }
      const again = await native.provider.resumeSession(handle);
      if (unknown) unknownSent += 1;
      const reread = followSession(again);
      try { await reread.boundary(); } finally { await again.dispose(); await reread.done; await native.provider.dispose(); }
      return { live: seen.journal(), reread: reread.history(), diagnostics: native.diagnostics, unknownSent };
    },

    async usageLimit() {
      // `session.error` with `errorType` `rate_limit`, and the seconds until the reset in the `auto_mode_switch.requested` that follows.
      const { event } = events();
      const native = nativeCopilot([], { onSend: emit => {
        emit(event('user.message', { content: 'Over the limit' }));
        emit(event('assistant.turn_start', { turnId: '0' }));
        emit(event('session.error', { errorType: 'rate_limit', errorCode: 'user_weekly_rate_limited', message: 'You reached the weekly rate limit.' }));
        emit({ ...event('auto_mode_switch.requested', { requestId: 'switch-1', errorCode: 'user_weekly_rate_limited', retryAfterSeconds: 3600 }), timestamp: '2026-11-22T10:00:00.000Z' });
      } });
      const session = await native.provider.resumeSession(handle);
      const seen = followSession(session);
      try {
        await seen.boundary();
        await session.sendMessage('Over the limit');
        await seen.until(() => seen.events().some(value => value.type === 'runtime_updated' && value.runtimeInfo.usageLimit?.resetsAt !== undefined), 'the reset of the limit');
        return { events: seen.events(), runtime: await session.runtimeInfo(), resetsAt: Date.parse('2026-11-22T11:00:00.000Z') };
      } finally { await session.dispose(); await seen.done; await native.provider.dispose(); }
    },

    async writerElsewhere() {
      // The SDK says at resume whether another client has the session (`sessions.checkInUse`).
      const native = nativeCopilot([], { inUse: true });
      try { return await native.provider.resumeSession(handle).then(async session => { await session.dispose(); return undefined; }, (error: unknown) => error); }
      finally { await native.provider.dispose(); }
    },
  };
}
