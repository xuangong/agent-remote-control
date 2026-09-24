import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import type { DebuggerAdapter } from './server.js';

/** Retains sessions during Relay startup, before the Relay can register their managers. */
export function ownAdapter(adapter: DebuggerAdapter) {
  const sessions = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  async function retain(pending: Promise<AgentSession>): Promise<AgentSession> {
    const session = await pending;
    let disposed: Promise<void> | undefined;
    const dispose = () => disposed ??= Promise.resolve().then(() => session.dispose()).finally(() => sessions.delete(dispose));
    if (closing) { await dispose(); throw new Error('ARDB server stopped during provider startup.'); }
    sessions.add(dispose);
    return new Proxy(session, { get(target, key) {
      if (key === 'dispose') return dispose;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  return {
    adapter: {
      descriptor: adapter.descriptor,
      createSession: config => retain(adapter.createSession(config)),
      resumeSession: (handle, extensions) => retain(adapter.resumeSession(handle, extensions)),
    } satisfies DebuggerAdapter,
    close: () => closing ??= (async () => {
      try {
        const results = await Promise.allSettled([...sessions].map(dispose => dispose()));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } finally { await adapter.dispose?.(); }
    })(),
  };
}
