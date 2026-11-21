import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';

/**
 * Native exit: a CLI that exits under a session leaves its runtime unusable, so the runtime is released and the next operation, a send or an
 * open, attaches the session again from native history, within the resume deadline the adapter declares. Nothing the session was sent is
 * sent again: an input the CLI took is in its history, and one it did not take settles by the rules of a send (an interrupted send is
 * settled by a reread, never replayed). Keyed on the SDK's failure taxonomy and its stream contract, never on a provider id.
 *
 * Contract.
 * - X1 A `turn_failed` of code `native_exited` reaches the session's readers, with the CLI's reason, and then the runtime is released.
 * - X2 A stream that ends, or fails, before the Controller disposed the session is an exit too: the CLI that served it is gone.
 * - X3 The release happens once per attachment, and never for a stream the Controller ended by disposing the session or by stopping to read.
 */
export function watchExit(session: AgentSession, options: { exited(): void }): AgentSession {
  let disposed = false;
  let released = false;
  const release = () => {
    if (disposed || released) return;
    released = true;
    try { options.exited(); } catch { /* A release that fails cannot fail the session's stream. */ }
  };
  async function* observe(): AsyncGenerator<ProviderStreamItem> {
    const source = session.observe()[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<ProviderStreamItem>;
        try { next = await source.next(); }
        catch (error) { release(); throw error; }
        if (next.done) { release(); return; }
        yield next.value;
        if (next.value.type === 'observation' && next.value.event.type === 'turn_failed' && next.value.event.code === 'native_exited') release();
      }
    } finally { await source.return?.(); }
  }
  async function dispose(): Promise<void> {
    disposed = true;
    await session.dispose();
  }
  return new Proxy(session, { get(target, key) {
    if (key === 'observe') return observe;
    if (key === 'dispose') return dispose;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
