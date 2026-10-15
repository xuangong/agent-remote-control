import { resolveAgentNativePrefixCapability, type AgentNativePrefixCapability } from '@orchardworks/agent-provider-sdk';
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
    adapter: new Proxy(adapter, { get(target, key) {
      if (key === 'createSession') return (...args: Parameters<DebuggerAdapter['createSession']>) => retain(adapter.createSession(...args));
      if (key === 'resumeSession') return (...args: Parameters<DebuggerAdapter['resumeSession']>) => retain(adapter.resumeSession(...args));
      if (key === 'nativePrefix') {
        const capability = resolveAgentNativePrefixCapability(target);
        if (!capability) return undefined;
        return {
          get createdSessionIdMaxLength() { return capability.createdSessionIdMaxLength; },
          validate: selection => capability.validate(selection),
          create: (...args) => retain(capability.create(...args)),
          verify: (selection, handle) => capability.verify(selection, handle),
        } satisfies AgentNativePrefixCapability;
      }
      const value = Reflect.get(target, key, target);
      if (key === 'forkForPromptEdit' && typeof value === 'function') return (...args: unknown[]) => retain(value.apply(target, args));
      return typeof value === 'function' ? value.bind(target) : value;
    } }),
    close: () => closing ??= (async () => {
      try {
        const results = await Promise.allSettled([...sessions].map(dispose => dispose()));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } finally { await adapter.dispose?.(); }
    })(),
  };
}
