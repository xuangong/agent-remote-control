import { followSession, type ProviderNativeFake } from '@orchardworks/agent-provider-sdk/conformance';

import { CodexAppServerProvider } from '../provider.js';
import { createScriptedAppServer } from './scripted-app-server.js';

/**
 * The Codex adapter driven by a scripted app-server in place of the CLI, for the provider conformance kit
 * (`@orchardworks/agent-provider-sdk/conformance`). The scripted server speaks the app-server protocol of codex-cli 0.171.0:
 * `thread/resume`, `thread/read` with its turns, `turn/start`, and the item and turn notifications.
 */

const THREAD = 'thread-1';
const handle = { providerId: 'codex', sessionId: THREAD, opaque: JSON.stringify({ cwd: '/workspace' }) };
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
/** When a history item started and finished, as Codex records it. */
const done = (atMs: number) => ({ startedAtMs: atMs, completedAtMs: atMs });
/** An item type and a notification method no Codex release the adapter knows has sent, as a CLI update could add them. */
const UNKNOWN_ITEM = { type: 'hologram', id: 'hologram-1', payload: 'from a newer CLI' };
const UNKNOWN_METHOD = 'thread/hologram/updated';

/** A `thread/read` answer: the thread, with its turns when they are asked for. */
const thread = (turns: unknown[], params: unknown) => ({ thread: { id: THREAD, cwd: '/workspace', status: { type: 'idle' },
  ...((params as { includeTurns?: unknown }).includeTurns === true ? { turns } : {}) } });

/** A Codex CLI played by scripted app-servers: each process the adapter starts is a new one, over the same native state. */
function nativeCodex(turns: unknown[], handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const diagnostics: string[] = [];
  let latest: ReturnType<typeof createScriptedAppServer> | undefined;
  const spawn = () => (latest = createScriptedAppServer({
    'thread/resume': () => ({ thread: { id: THREAD }, model: 'test-model', cwd: '/workspace' }),
    'thread/read': params => thread(turns, params),
    ...handlers as Record<string, (params: unknown) => unknown>,
  })).child;
  const provider = new CodexAppServerProvider({ spawn, onDiagnostic: line => diagnostics.push(line) });
  /** A notification of the CLI to the process that runs the session now. */
  const notify = (method: string, params: object) => { latest?.child.stdout.write(`${JSON.stringify({ method, params: { threadId: THREAD, ...params } })}\n`); };
  return { provider, notify, diagnostics };
}

export function codexNativeFake(): ProviderNativeFake {
  return {
    async turn({ inputId, unknown }) {
      const turns: unknown[] = [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2,
        items: [{ type: 'userMessage', id: 'user-1', content: text('Hello'), ...done(1000) }, ...(unknown ? [{ ...UNKNOWN_ITEM, ...done(1500) }] : []), { type: 'agentMessage', id: 'agent-1', text: 'Hi', ...done(2000) }] }];
      let unknownSent = 0;
      const live = { id: 'turn-2', status: 'completed', startedAt: 3, completedAt: 4,
        items: [{ type: 'userMessage', id: 'user-2', clientId: inputId, content: text('Next'), ...done(3000) }, { type: 'agentMessage', id: 'agent-2', text: 'Reply to Next', ...done(4000) }] };
      const native = nativeCodex(turns, {
        // Each read of the history sends the unknown item it holds again.
        'thread/read': params => { if (unknown && params.includeTurns === true) unknownSent += 1; return thread(turns, params); },
        'turn/start': () => {
          // The CLI answers the request, then runs the turn: its notifications follow the answer.
          setImmediate(() => {
            native.notify('turn/started', { turn: { id: 'turn-2', status: 'inProgress' } });
            native.notify('item/started', { turnId: 'turn-2', item: live.items[0] });
            native.notify('item/completed', { turnId: 'turn-2', item: live.items[0] });
            if (unknown) { unknownSent += 1; native.notify(UNKNOWN_METHOD, { turnId: 'turn-2' }); }
            native.notify('item/completed', { turnId: 'turn-2', item: live.items[1] });
            turns.push(live);
            native.notify('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
          });
          return { turn: { id: 'turn-2', status: 'inProgress', items: [] } };
        },
      });
      const session = await native.provider.resumeSession(handle);
      const seen = followSession(session);
      try {
        await seen.boundary();
        await session.sendMessage('Next', { inputId });
        await seen.until(() => seen.events().some(event => event.type === 'turn_completed'), 'the end of the live turn');
      } finally { await session.dispose(); await seen.done; }
      const again = await native.provider.resumeSession(handle);
      const reread = followSession(again);
      try { await reread.boundary(); } finally { await again.dispose(); await reread.done; }
      return { live: seen.journal(), reread: reread.history(), diagnostics: native.diagnostics, unknownSent };
    },

    async usageLimit() {
      // The account's windows, sent with every turn, and a turn the used-up window stops (app-server protocol of codex-cli 0.171.0).
      const resetsAtS = 1_795_300_000;
      const native = nativeCodex([]);
      const session = await native.provider.resumeSession(handle);
      const seen = followSession(session);
      try {
        await seen.boundary();
        native.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetsAtS }, secondary: null } });
        native.notify('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
        native.notify('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
        await seen.until(() => seen.events().some(event => event.type === 'turn_failed'), 'the failed turn');
        return { events: seen.events(), runtime: await session.runtimeInfo(), resetsAt: resetsAtS * 1000 };
      } finally { await session.dispose(); await seen.done; }
    },

    async writerElsewhere() {
      // Codex refuses a process outside the shared daemon while another holds the thread's writer lock, in these words (O46).
      const native = nativeCodex([], { 'thread/resume': () => { throw Object.assign(new Error(`thread ${THREAD} already has an active writer`), { code: -32600 }); } });
      return native.provider.resumeSession(handle).then(async session => { await session.dispose(); return undefined; }, (error: unknown) => error);
    },
  };
}
