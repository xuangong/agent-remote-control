import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createAgentHost, createCodexSessionDirectory } from '@agent-remote-control/agent-remote-controller';
import { createCodexProviderFixture } from '../src/server/codex.js';

const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE;
if (!executable) throw new Error('BORGEE_CODEX_TEST_EXECUTABLE is required.');
const port = Number(process.env.AGENT_REMOTE_PORT ?? 5910);
const origin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
const serverUrl = `http://127.0.0.1:${port}`;
const controlPort = Number(process.env.AGENT_REMOTE_TEST_CONTROL_PORT ?? 0);
const startBackend = () => spawn(process.execPath, ['--import', 'tsx/esm', 'src/server/local.ts'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, AGENT_REMOTE_PORT: String(port), AGENT_REMOTE_ORIGIN: origin },
});
let backend = startBackend();
await waitForBackend(serverUrl);
const invitation = await pair();
const fixture = await createCodexProviderFixture({ executable });
const directory = createCodexSessionDirectory(fixture.directoryProvider, [
  { id: fixture.workspace, name: 'Deterministic Codex workspace', path: fixture.workspace },
]);
const host = createAgentHost({
  registrations: [{ adapter: fixture.provider, directory }], installationId: 'e2e-codex-host',
  name: 'Deterministic Codex Host', uplink: { url: `${serverUrl.replace('http:', 'ws:')}/ws/remote-host`, remoteKey: invitation.key },
});
await host.ready;
let hostId = (await host.ready).hostId;
process.stdout.write(`Deterministic Codex Agent Host connected to ${serverUrl}\n`);

const control = controlPort ? createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/state') return json(response, 200, { hostId, workspace: fixture.workspace });
    if (request.method === 'POST' && request.url === '/restart') {
      backend.kill('SIGTERM');
      await once(backend, 'exit');
      backend = startBackend();
      await waitForBackend(serverUrl);
      const next = await pair();
      hostId = (await host.replaceUplink({ url: `${serverUrl.replace('http:', 'ws:')}/ws/remote-host`, remoteKey: next.key })).hostId;
      return json(response, 200, { hostId, workspace: fixture.workspace });
    }
    json(response, 404, { error: 'not found' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}) : undefined;
if (control) { control.listen(controlPort, '127.0.0.1'); await once(control, 'listening'); }

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await host.close();
  await fixture.close();
  if (control) await new Promise<void>((resolve) => control.close(() => resolve()));
  backend.kill('SIGTERM');
  await Promise.race([once(backend, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function pair(): Promise<{ key: string }> {
  const response = await fetch(`${serverUrl}/v1/remote/pairings`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
  });
  if (!response.ok) throw new Error(`Pairing failed: ${response.status}`);
  return response.json() as Promise<{ key: string }>;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
process.once('SIGINT', () => { void close().finally(() => process.exit()); });
process.once('SIGTERM', () => { void close().finally(() => process.exit()); });
await new Promise<void>(() => undefined);

async function waitForBackend(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error(`Backend exited with ${backend.exitCode}.`);
    try { if ((await fetch(`${url}/v1/providers?protocolVersion=1.4.0`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend did not become ready.');
}
