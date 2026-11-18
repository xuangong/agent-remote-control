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
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentHost, type AgentHost } from '@orchardworks/agent-remote-controller';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import { createDevboxServer } from '@orchardworks/agent-relay-node/devbox';
import { scriptedProvider, type ScriptedProviderOptions } from './scripted-provider.js';

const WORKBENCH_DIST = resolve(import.meta.dirname, '../../agent-remote-lab/dist');

export interface StackOptions extends ScriptedProviderOptions {
  /** Where the built Workbench is; the default is the checkout's. */
  webDist?: string;
  installationId?: string;
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
  const provider = scriptedProvider(options);
  const webDist = options.webDist ?? WORKBENCH_DIST;
  let relay = await createDevboxServer({ origin, stateDir: join(state, 'relay'), webDist, journals: true });
  await relay.listen(port, '127.0.0.1');
  let connection = await relay.getConnection();
  let controller: AgentHost | undefined;
  const installationId = options.installationId ?? 'e2e-controller';

  let hostId = '';
  /** The device credential the Relay issued at the first connection; a Controller that starts again presents it, as an installed one does. */
  let credential: string | undefined;
  const startController = async () => {
    if (controller) throw new Error('The Controller is already running.');
    controller = createAgentHost({ registrations: [provider.registration], installationId, name: 'E2E Host', uplink: { url: `ws://127.0.0.1:${port}/ws/remote-host`, remoteKey: credential ?? connection.remoteKey, onCredential: async issued => { credential = issued; } } });
    hostId = (await controller.ready).hostId;
  };
  const stopController = async () => { const running = controller; controller = undefined; await running?.close(); };
  await startController();

  return {
    origin, provider, state,
    /** The address of a scripted session's page; the Controller must be registered. */
    sessionUrl: (nativeSessionId: string) => origin + controllerPath({ hostId, providerId: 'scripted', nativeSessionId }),
    get hostName() { return 'E2E Host'; },
    startController, stopController,
    async restartRelay() { await relay.close(); relay = await createDevboxServer({ origin, stateDir: join(state, 'relay'), webDist, journals: true }); await relay.listen(port, '127.0.0.1'); },
    async close() { await stopController(); await relay.close(); await provider.registration.directory.close?.(); await rm(state, { recursive: true, force: true }); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
