/**
 * The e2e stack: one Node Relay (SQLite journals in a temporary directory), one Controller with a scripted provider, and the built
 * Workbench, on free ports.
 *
 * Contract. `startStack(options)` resolves when the Relay serves the Workbench and the Controller is registered. `origin` is the page's
 * address; a fresh headless browser context is signed in as the local user by the Relay. `stopController` / `startController` stop and
 * start the Controller alone (its provider keeps its sessions); `restartRelay` stops the Relay and starts it again on the same port and
 * state, and the Controller reconnects by itself. `close` stops everything and removes the state. Nothing reads the user's home, their
 * Controller or any credential; each stack has its own state directory and invitation.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentHost, type AgentHost } from '@orchardworks/agent-remote-controller';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import type { ControllerRelease } from '@orchardworks/agent-remote-protocol';
import { createDevboxServer } from '@orchardworks/agent-relay-node/devbox';
import { scriptedProvider, type ScriptedProviderOptions } from './scripted-provider.js';

const WORKBENCH_DIST = resolve(import.meta.dirname, '../../agent-remote-lab/dist');

export interface StackOptions extends Omit<ScriptedProviderOptions, 'succession'> {
  /** Where the built Workbench is; the default is the checkout's. */
  webDist?: string;
  installationId?: string;
  /** Serve the sessions of the scripted providers from the Relay's journal, as a Host with smart reading turned on is served. On by default. */
  smartReading?: boolean;
  /** More providers of the same Controller, for a flow that hands a session from one provider to another. */
  otherProviders?: ScriptedProviderOptions[];
  /**
   * Gives the Controller its succession state and every scripted provider the evidence a successor needs, so the page can hand a session
   * to a new one. `beforeCreate` runs before a successor session is created (a flow holds the handoff half done there).
   */
  succession?: { beforeCreate?(): Promise<void> };
  /**
   * A Controller that runs `runningVersion` and an update to `release`, with no GitHub and no download: the Relay discovers `release` as
   * the latest, the Controller's updater records the install and asks to restart, and `finishUpdate()` plays the launcher by starting
   * the Controller again as the new version.
   */
  controllerUpdate?: { runningVersion: string; release: ControllerRelease };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolvePort(port)); });
  });
}

export async function startStack(options: StackOptions = {}) {
  const state = await mkdtemp(join(tmpdir(), 'arc-e2e-stack-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const workspace = await realpath(await mkdtemp(join(state, 'workspace-')));
  const successor = options.succession ? { workspace, ...(options.succession.beforeCreate ? { beforeCreate: options.succession.beforeCreate } : {}) } : undefined;
  const provider = scriptedProvider({ ...options, succession: successor });
  const otherProviders = (options.otherProviders ?? []).map(other => scriptedProvider({ ...other, succession: successor }));
  const webDist = options.webDist ?? WORKBENCH_DIST;
  const update = options.controllerUpdate;
  const controllerReleases = update ? { latest: async () => update.release, version: async () => update.release } : undefined;
  const relayOptions = { origin, stateDir: join(state, 'relay'), webDist, journals: true, ...(controllerReleases ? { controllerReleases } : {}) };
  let relay = await createDevboxServer(relayOptions);
  await relay.listen(port, '127.0.0.1');
  let connection = await relay.getConnection();
  let controller: AgentHost | undefined;
  const installationId = options.installationId ?? 'e2e-controller';

  let runningVersion = update?.runningVersion;
  const updates = { installed: [] as string[], restarts: [] as string[] };
  let hostId = '';
  /** The device credential the Relay issued at the first connection; a Controller that starts again presents it, as an installed one does. */
  let credential: string | undefined;
  const startController = async () => {
    if (controller) throw new Error('The Controller is already running.');
    // The state directory is what gives the Controller its outbox (receipts of the messages it took), so a message sent while it is away waits at the Relay.
    const identity = runningVersion ? { version: runningVersion, revision: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), remoteUpdate: true } : undefined;
    controller = createAgentHost({ ...(identity ? { controller: { identity, stateDir: join(state, 'controller'),
      restart: async (version: string) => { updates.restarts.push(version); }, release: async () => update!.release,
      install: async (release: ControllerRelease) => { updates.installed.push(release.version); } } } : {}), ...(options.succession ? { succession: { controllerId: installationId, stateDirectory: join(state, 'succession'), enrollment: true as const },
      executionPolicy: { defaultWorkspace: workspace, allowedWorkspaceRoots: [workspace], lockPermissions: false } } : {}), preview: { stateDirectory: join(state, 'controller') }, registrations: [provider.registration, ...otherProviders.map(other => other.registration)], installationId, name: 'E2E Host', uplink: { url: `ws://127.0.0.1:${port}/ws/remote-host`, remoteKey: credential ?? connection.remoteKey, onCredential: async issued => { credential = issued; } } });
    hostId = (await controller.ready).hostId;
  };
  const stopController = async () => { const running = controller; controller = undefined; await running?.close(); };
  await startController();

  /** Acts as the local user for one call: signs in, runs it with the cookie and the user's base path, and signs out. */
  const asOwner = async <T>(call: (request: (method: string, path: string, body?: unknown) => Promise<Response>) => Promise<T>): Promise<T> => {
    const status = await fetch(origin + '/auth/status', { signal: AbortSignal.timeout(10_000) });
    const { basePath } = await status.json() as { basePath: string };
    const headers = { cookie: status.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin, 'content-type': 'application/json' };
    try { return await call((method, path, body) => fetch(origin + basePath + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) })); }
    finally { await (await fetch(origin + '/auth/logout', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(10_000) })).body?.cancel(); }
  };
  if (options.smartReading !== false) {
    await asOwner(async request => {
      for (const each of [provider, ...otherProviders]) {
        const response = await request('PUT', `v1/remote/hosts/${hostId}/smart-reading`, { providerId: each.providerId, enabled: true });
        if (!response.ok) throw new Error(`Smart reading could not be turned on for ${each.providerId} (${response.status}).`);
      }
    });
  }

  return {
    origin, provider, otherProviders, state,
    /** The address of a scripted session's page; the Controller must be registered. */
    sessionUrl: (nativeSessionId: string, providerId: string = provider.providerId) => origin + controllerPath({ hostId, providerId, nativeSessionId }),
    get hostId() { return hostId; },
    get hostName() { return 'E2E Host'; },
    startController, stopController,
    /** What the Controller's updater did: the versions it installed and the versions it asked the launcher to restart into. */
    updates,
    /** Plays the launcher after an update: the Controller starts again as the release it installed. */
    async finishUpdate() {
      await stopController();
      // The launcher records the result of the restart in the status file the updater keeps.
      const statusFile = join(state, 'controller', 'controller-updates', 'status.json');
      const status = JSON.parse(await readFile(statusFile, 'utf8')) as Record<string, unknown>;
      await writeFile(statusFile, JSON.stringify({ ...status, phase: 'succeeded', updatedAt: Date.now() }));
      runningVersion = update!.release.version; await startController();
    },
    /**
     * A second Controller paired with a key the page generated: a Host of its own, with its own scripted provider. `close` stops it.
     * Its device credential is kept by the Controller object, as an installed one keeps its own.
     */
    async pairController(pairing: { key: string; name: string; installationId: string } & ScriptedProviderOptions) {
      const paired = scriptedProvider(pairing);
      const host = createAgentHost({ registrations: [paired.registration], installationId: pairing.installationId, name: pairing.name, uplink: { url: `ws://127.0.0.1:${port}/ws/remote-host`, remoteKey: pairing.key, onCredential: async () => {} } });
      const { hostId: pairedHostId } = await host.ready;
      return {
        provider: paired, hostId: pairedHostId,
        sessionUrl: (nativeSessionId: string) => origin + controllerPath({ hostId: pairedHostId, providerId: paired.providerId, nativeSessionId }),
        async close() { await host.close(); await paired.registration.directory.close?.(); },
      };
    },
    async restartRelay() { await relay.close(); relay = await createDevboxServer(relayOptions); await relay.listen(port, '127.0.0.1'); },
    async close() { await stopController(); await relay.close(); await Promise.all([provider, ...otherProviders].map(each => each.registration.directory.close?.())); await rm(state, { recursive: true, force: true }); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
