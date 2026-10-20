/** Native CLI versions the native suites last ran against. Newer installations work but are unverified. */
export const verifiedNativeVersions: Readonly<Record<string, string>> = { claude: '2.1.296', codex: '0.162.0' };

const windowMs = 60 * 60_000;
const nativeExitWindowMs = 10 * 60_000;
const maxEvents = 4096;

export interface ControllerHealthWarning { code: string; severity: 'warning' | 'notice'; message: string; count?: number }
export interface ControllerHealthSnapshot {
  generatedAt: number;
  startedAt: number;
  windowMinutes: number;
  requestFailures: Array<{ operation: string; status: number; code?: string; count: number; lastAt: number }>;
  nativeExits: Array<{ providerId: string; outcome: string; count: number; lastAt: number }>;
  uplinkDrops: { count: number; lastAt?: number };
  natives: Array<{ providerId: string; version: string; verified: string; newer: boolean }>;
  launcher: { managed: boolean; version?: string };
  warnings: ControllerHealthWarning[];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/).map(Number), b = right.split(/[.-]/).map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

/**
 * Keeps one hour of Controller failure signals so repeated failures show up where the owner looks,
 * instead of only in the local diagnostic log. Holds counts and codes only, never request content.
 */
export function createControllerHealth(options: { natives(): Array<{ providerId: string; version?: string }>; launcher: { managed: boolean; version?: string }; now?: () => number }) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  type Entry = { at: number; kind: 'request'; operation: string; status: number; code?: string }
    | { at: number; kind: 'native_exit'; providerId: string; outcome: string }
    | { at: number; kind: 'uplink_drop' };
  let events: Entry[] = [];
  const record = (entry: Entry) => {
    events.push(entry);
    if (events.length > maxEvents) events = events.slice(-maxEvents);
  };
  const recent = (since: number) => events.filter(entry => entry.at >= since);
  return {
    request(operation: string, status: number, code?: string) {
      if (status >= 400) record({ at: now(), kind: 'request', operation, status, ...(code ? { code } : {}) });
    },
    nativeExit(providerId: string, outcome: string) { record({ at: now(), kind: 'native_exit', providerId, outcome }); },
    uplinkDrop() { record({ at: now(), kind: 'uplink_drop' }); },
    snapshot(): ControllerHealthSnapshot {
      const at = now(), hour = recent(at - windowMs);
      const group = <T extends Entry, K>(items: T[], key: (item: T) => string, value: (item: T) => K) => {
        const groups = new Map<string, K & { count: number; lastAt: number }>();
        for (const item of items) {
          const id = key(item), current = groups.get(id);
          groups.set(id, current ? { ...current, count: current.count + 1, lastAt: item.at } : { ...value(item), count: 1, lastAt: item.at });
        }
        return [...groups.values()].sort((left, right) => right.count - left.count);
      };
      const requests = hour.filter((entry): entry is Extract<Entry, { kind: 'request' }> => entry.kind === 'request');
      const exits = hour.filter((entry): entry is Extract<Entry, { kind: 'native_exit' }> => entry.kind === 'native_exit');
      const drops = hour.filter(entry => entry.kind === 'uplink_drop');
      const requestFailures = group(requests, entry => JSON.stringify([entry.operation, entry.status, entry.code ?? null]),
        entry => ({ operation: entry.operation, status: entry.status, ...(entry.code ? { code: entry.code } : {}) }));
      const nativeExits = group(exits, entry => JSON.stringify([entry.providerId, entry.outcome]), entry => ({ providerId: entry.providerId, outcome: entry.outcome }));
      const natives = options.natives().flatMap(native => {
        const verified = verifiedNativeVersions[native.providerId];
        return native.version && verified ? [{ providerId: native.providerId, version: native.version, verified, newer: compareVersions(native.version, verified) > 0 }] : [];
      });
      const warnings: ControllerHealthWarning[] = [];
      for (const failure of requestFailures) {
        if (failure.operation !== 'session_attach' || failure.count < 60) continue;
        warnings.push({ code: 'repeated_attach_failure', severity: 'warning', count: failure.count,
          message: failure.code === 'native_session_owned'
            ? `Browsers asked to reopen a session owned by a native CLI ${failure.count} times in the last hour. Take control from the session, close the CLI, or reload pages left open before an update.`
            : `Opening a session failed ${failure.count} times in the last hour (${failure.code ?? `HTTP ${failure.status}`}). Check the Controller log.` });
      }
      for (const exit of group(exits.filter(entry => entry.outcome === 'unexpected' && entry.at >= at - nativeExitWindowMs), entry => entry.providerId, entry => ({ providerId: entry.providerId }))) {
        if (exit.count >= 5) warnings.push({ code: 'native_start_loop', severity: 'warning', count: exit.count,
          message: `${exit.providerId} exited unexpectedly ${exit.count} times in the last 10 minutes. Check that it starts in a terminal on this computer and the Controller log.` });
      }
      if (drops.length >= 6) warnings.push({ code: 'uplink_unstable', severity: 'warning', count: drops.length,
        message: `The connection to the Relay dropped ${drops.length} times in the last hour. Sessions reconnect automatically; frequent drops point to the network or the Relay.` });
      if (options.launcher.managed && !options.launcher.version) warnings.push({ code: 'legacy_launcher', severity: 'notice',
        message: 'The service launcher predates launcher updates. After a Controller update it is replaced on disk, and the new launcher runs from the next service restart, for example after signing in again or restarting the computer.' });
      for (const native of natives) if (native.newer) warnings.push({ code: 'unverified_native_version', severity: 'notice',
        message: `${native.providerId} ${native.version} is newer than ${native.verified}, the latest version verified with this Controller.` });
      return { generatedAt: at, startedAt, windowMinutes: windowMs / 60_000, requestFailures, nativeExits,
        uplinkDrops: { count: drops.length, ...(drops.length ? { lastAt: drops.at(-1)!.at } : {}) }, natives, launcher: options.launcher, warnings };
    },
  };
}
export type ControllerHealth = ReturnType<typeof createControllerHealth>;
