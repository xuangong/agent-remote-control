import { followSession, type ProviderNativeFake } from '@orchardworks/agent-provider-sdk/conformance';

import { openCodeServer } from './server-fixture.js';

/**
 * The OpenCode adapter driven by an OpenCode server in this process (`server-fixture.ts`, the v2 API of OpenCode 2.0.25), for the rule of
 * the provider conformance kit that every adapter follows (`runUnknownEventRule`): a turn the server runs while its event stream also
 * carries an event of a type the adapter does not know. OpenCode is not journal-capable, so it takes no other part of the kit.
 */
const SESSION = 'ses_existing';
const handle = { providerId: 'opencode', sessionId: SESSION, opaque: JSON.stringify({ cwd: process.cwd() }) };
/** An event type no OpenCode server the adapter knows has sent, as a server update could add one. */
const UNKNOWN_TYPE = 'session.hologram.updated';

export function openCodeNativeFake(): ProviderNativeFake {
  return {
    async turn({ unknown }) {
      const diagnostics: string[] = [];
      let unknownSent = 0;
      const server = await openCodeServer({ onDiagnostic: line => diagnostics.push(line) });
      try {
        const session = await server.provider.resumeSession(handle);
        const seen = followSession(session);
        try {
          await seen.boundary();
          await session.sendMessage('Next');
          if (unknown) { unknownSent += 1; server.event(UNKNOWN_TYPE, { sessionID: SESSION }); }
          // The server replies, and says so with the end of its execution.
          const now = Date.now();
          server.messages.get(SESSION)!.push(
            { type: 'assistant', id: 'msg_next_reply', agent: 'build', model: { providerID: 'test', id: 'model' }, content: [{ type: 'text', text: 'Reply to Next' }], time: { created: now + 1, completed: now + 2 } },
            { type: 'idle', id: 'msg_next_idle', time: { created: now + 3 }, outcome: 'succeeded' });
          server.sessions.get(SESSION)!.outcome = 'succeeded';
          delete server.active[SESSION];
          server.event('session.execution.succeeded', { sessionID: SESSION });
          await seen.until(() => seen.liveEvents().some(event => event.type === 'turn_completed'), 'the end of the live turn', 4000);
        } finally { await session.dispose(); await seen.done; }
        const again = await server.provider.resumeSession(handle);
        const reread = followSession(again);
        try { await reread.boundary(); } finally { await again.dispose(); await reread.done; }
        return { live: seen.journal(), reread: reread.history(), diagnostics, unknownSent };
      } finally { await server.close(); }
    },
  };
}
