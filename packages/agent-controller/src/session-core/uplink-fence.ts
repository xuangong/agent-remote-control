/**
 * Uplink fence: which of the Controller's uplink connections may still change its state.
 *
 * Contract.
 * - Each `begin` starts a connection and supersedes the one before it. A token is current only while it is the latest and the fence is open.
 * - `closed` ends every connection at once and never reopens.
 * - `whenCurrent(token, action)` runs the action only for a current token and returns whether it ran, so a connection that was replaced or
 *   closed cannot change the Controller's state, grant the journal, wake the outbox or persist a credential.
 * - `persistCredential(token, save, credential)` writes credentials one at a time, in the order they arrive. A write is refused with
 *   `Host credential persistence was superseded.` when its connection is no longer current by the time its turn comes, so an old save never overwrites a
 *   newer key; a failed write does not stop the ones queued behind it.
 *
 * Mutable state: the generation counter, the closed flag and the write queue. No timers, no ports.
 */
export interface UplinkToken { readonly generation: number }

export interface UplinkFence {
  begin(): UplinkToken;
  isCurrent(token: UplinkToken): boolean;
  whenCurrent(token: UplinkToken, action: () => void): boolean;
  close(): void;
  readonly closed: boolean;
  persistCredential(token: UplinkToken, save: (credential: string) => Promise<void>, credential: string): Promise<void>;
}

export function createUplinkFence(): UplinkFence {
  let generation = 0;
  let closed = false;
  let writes: Promise<void> = Promise.resolve();
  const fence: UplinkFence = {
    begin: () => ({ generation: ++generation }),
    isCurrent: token => token.generation === generation && !closed,
    whenCurrent(token, action) {
      if (!fence.isCurrent(token)) return false;
      action();
      return true;
    },
    close() { closed = true; generation += 1; },
    get closed() { return closed; },
    persistCredential(token, save, credential) {
      const pending = writes.catch(() => undefined).then(async () => {
        if (!fence.isCurrent(token)) throw new Error('Host credential persistence was superseded.');
        await save(credential);
      });
      writes = pending;
      return pending;
    },
  };
  return fence;
}
