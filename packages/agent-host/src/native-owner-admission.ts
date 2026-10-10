import type { OperationCache, NativeEffectHandle } from '@orchardworks/agent-remote-relay';
import { nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { NativeSessionOwnerError, type NativeHandoffGrant, type NativeOwnerIdentity } from './native-session-owner.js';
import type { SessionSuccessionBoundary } from './session-succession-boundary.js';

/** The lease may mutate ownership only after this function returns a fresh synchronous grant. */
export function admitNativeOwnerTransfer(cache: OperationCache, boundary: SessionSuccessionBoundary,
  targets: readonly NativeSessionRef[], current: NativeOwnerIdentity, next: NativeOwnerIdentity, deadlineMs = 15000): NativeHandoffGrant {
  let grant: NativeHandoffGrant | undefined;
  let resolve!: (value: string) => void, reject!: (error: unknown) => void;
  const transfer = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  void transfer.catch(() => undefined);
  const result = cache.execute({ operationId: next.generation, scope: 'host:native-owner', kind: 'native_owner_transfer',
    target: JSON.stringify([current, targets.map(nativeSessionRefKey)]), parameters: next }, {
    mutationTargets: targets.map(nativeSessionRefKey), maximumResultBytes: 256,
    admit(entry) {
      const release = boundary.admit(targets, entry.key);
      const effects: NativeEffectHandle[] = [];
      try { for (const target of targets) effects.push(entry.startNativeEffect(nativeSessionRefKey(target))); }
      catch (error) { for (const effect of effects) effect.settled(); release(); throw error; }
      // No idle check: an ordinary takeover is allowed to interrupt active native work.
      let timer: ReturnType<typeof setTimeout> | undefined;
      grant = {
        completed(outcome) { clearTimeout(timer); for (const effect of effects) effect.settled(); resolve(outcome); },
        failed() { clearTimeout(timer); for (const effect of effects) effect.unresolved(); reject(new Error('Native owner transfer outcome is unresolved.')); },
      };
      timer = setTimeout(() => grant!.failed(), deadlineMs); timer.unref?.();
      return release;
    },
    dispatch: () => transfer,
  });
  // Async execute rejection and replay cannot masquerade as synchronous admission.
  void result.catch(() => undefined);
  if (!grant) { reject(new Error('Native owner admission was refused.')); throw new NativeSessionOwnerError('succession_admission_closed', 'Native ownership admission is unavailable.'); }
  return grant;
}
