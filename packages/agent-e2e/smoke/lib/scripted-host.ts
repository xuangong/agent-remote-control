import { createAgentHost } from '@orchardworks/agent-remote-controller';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import { actAsLocalUser } from '../../stack/owner.js';
import { scriptedProvider, type ScriptedProviderOptions } from '../../stack/scripted-provider.js';
import type { Instance } from '../../faults/instance-process.mjs';

/**
 * A second Host of the instance's Relay, in this process, with a scripted provider: sessions whose history and live rows the scenario
 * writes, so a scenario that needs hundreds of sessions or megabytes of tool output costs no model turn. It pairs with a key of the
 * instance's local user and has its own device credential, so it never touches the instance's own Controller or its sessions.
 */
export interface ScriptedHost {
  hostId: string;
  provider: ReturnType<typeof scriptedProvider>;
  /** The address of a scripted session's page on the instance's origin. */
  sessionUrl(nativeSessionId: string): string;
  /** Stops the Controller; its provider keeps the sessions and `start` brings it back with the same credential. */
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** How long a Host may take to register: against a local Relay it takes tens of milliseconds, and its uplink retries a refused or lost connection without end. */
const REGISTER_WITHIN_MS = 20_000;

export async function startScriptedHost(instance: Pick<Instance, 'origin'>, options: ScriptedProviderOptions & { name: string; installationId: string; /** The origin the Host's uplink connects to instead of the instance's own (a proxy that records it). */ uplinkVia?: string; /** The bound on registering; the Host is closed and the run fails with what its uplink did. */ registerWithinMs?: number }): Promise<ScriptedHost> {
  const port = new URL(options.uplinkVia ?? instance.origin).port;
  const registerWithinMs = options.registerWithinMs ?? REGISTER_WITHIN_MS;
  const uplinkEvents: string[] = [];
  const provider = scriptedProvider(options);
  const key = await actAsLocalUser(instance.origin, async request => {
    const response = await request('POST', 'v1/remote/pairings', { purpose: 'host-only' });
    if (!response.ok) throw new Error(`The instance refused a pairing key (${response.status}).`);
    return ((await response.json()) as { key: string }).key;
  });
  let credential: string | undefined;
  let host: ReturnType<typeof createAgentHost> | undefined;
  let hostId = '';
  const start = async () => {
    if (host) throw new Error('The scripted Controller is already running.');
    const url = `ws://127.0.0.1:${port}/ws/remote-host`;
    host = createAgentHost({ registrations: [provider.registration], installationId: options.installationId, name: options.name,
      onDiagnostic: diagnostic => { uplinkEvents.push([diagnostic.event, diagnostic.reason, diagnostic.httpStatus && `HTTP ${diagnostic.httpStatus}`, diagnostic.closeCode && `close ${diagnostic.closeCode}`].filter(Boolean).join(' ')); if (uplinkEvents.length > 8) uplinkEvents.shift(); },
      uplink: { url, remoteKey: credential ?? key, onCredential: async issued => { credential = issued; } } });
    // The uplink retries a connection that fails with backoff and never gives up, so `ready` alone could wait for ever.
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`The scripted Host "${options.name}" did not register within ${registerWithinMs} ms through ${url}; its uplink did: ${uplinkEvents.join(', ') || 'nothing'}.`)), registerWithinMs); });
    try { hostId = (await Promise.race([host.ready, expired])).hostId; } finally { clearTimeout(timer); }
  };
  const stop = async () => { const running = host; host = undefined; await running?.close(); };
  try { await start(); }
  catch (error) { await stop(); await provider.registration.directory.close?.(); throw error; }
  try {
    await actAsLocalUser(instance.origin, async request => {
      const response = await request('PUT', `v1/remote/hosts/${hostId}/smart-reading`, { providerId: provider.providerId, enabled: true });
      // 409: the instance runs without journals (start it with ARC_LOCAL_JOURNALS=1).
      if (!response.ok) throw new Error(`Smart reading could not be turned on for the scripted Host (${response.status}).`);
    });
  } catch (error) {
    // A Host left running keeps its uplink open, and the smoke process would never exit after reporting the error.
    await stop(); await provider.registration.directory.close?.();
    throw error;
  }
  return {
    get hostId() { return hostId; }, provider, start, stop,
    sessionUrl: nativeSessionId => instance.origin + controllerPath({ hostId, providerId: provider.providerId, nativeSessionId }),
    async close() { await stop(); await provider.registration.directory.close?.(); },
  };
}
