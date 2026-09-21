// @vitest-environment node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient, type RemoteSessionStatus } from '@orchardworks/agent-remote-web/headless';

it('keeps a native Codex session usable when an independent Host pairs to a restarted backend', async () => {
  const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE;
  if (!executable) throw new Error('BORGEE_CODEX_TEST_EXECUTABLE is required.');
  const backendPort = await freePort();
  const controlPort = await freePort();
  const origin = 'http://127.0.0.1:6175';
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  const fixture = spawn(process.execPath, ['--import', 'tsx/esm', 'scripts/codex-host-fixture.ts'], {
    cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BORGEE_CODEX_TEST_EXECUTABLE: executable, AGENT_REMOTE_PORT: String(backendPort),
      AGENT_REMOTE_ORIGIN: origin, AGENT_REMOTE_TEST_CONTROL_PORT: String(controlPort) },
  });
  let output = '';
  fixture.stdout.on('data', (chunk) => { output += chunk; });
  fixture.stderr.on('data', (chunk) => { output += chunk; });
  const clients: RemoteSessionClient[] = [];
  try {
    const initial = await pollState(controlUrl, fixture, () => output);
    const created = await post(`${backendUrl}/v1/remote/hosts/${initial.hostId}/create`, {
      providerId: 'codex', operationId: '00000000-0000-4000-8000-000000000001', workspaceId: initial.workspace,
    });
    const first = await connect(backendUrl, origin, created.agentId, clients);
    expect((await first.client.sendMessage('Message before backend restart')).type).toBe('command_acknowledged');
    first.client.stop();

    const restarted = await post(`${controlUrl}/restart`, {});
    expect(restarted.hostId).not.toBe(initial.hostId);
    const recoveredCreation = await post(`${backendUrl}/v1/remote/hosts/${restarted.hostId}/create`, {
      providerId: 'codex', operationId: '00000000-0000-4000-8000-000000000001', workspaceId: initial.workspace,
    });
    expect(recoveredCreation).not.toEqual(created);
    expect(recoveredCreation.nativeSessionId).not.toBe(created.nativeSessionId);
    const attached = await post(`${backendUrl}/v1/remote/hosts/${restarted.hostId}/attach`, {
      providerId: 'codex', nativeSessionId: created.nativeSessionId,
    });
    expect(attached).toEqual(created);
    const recovered = await connect(backendUrl, origin, attached.agentId, clients);
    expect((await recovered.client.sendMessage('Message after backend restart')).type).toBe('command_acknowledged');
  } finally {
    for (const client of clients) client.stop();
    fixture.kill('SIGTERM');
    await Promise.race([once(fixture, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (fixture.exitCode === null) fixture.kill('SIGKILL');
  }
}, 40_000);

async function connect(baseUrl: string, origin: string, agentId: string, clients: RemoteSessionClient[]) {
  const transport = new HttpWebSocketTransport(baseUrl, { webSocketFactory: (url) => new WebSocket(url, { origin }) as never });
  const replica = new AgentReplica();
  const client = new RemoteSessionClient(agentId, transport, replica, { operationTimeoutMs: 5_000 });
  clients.push(client);
  let status: RemoteSessionStatus = 'idle';
  client.subscribeStatus((next) => { status = next; });
  client.start();
  await expect.poll(() => status, { timeout: 5_000 }).toBe('ready');
  return { client, replica };
}

async function post(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}

async function pollState(url: string, fixture: ReturnType<typeof spawn>, output: () => string): Promise<{ hostId: string; workspace: string }> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (fixture.exitCode !== null) throw new Error(`Fixture exited with ${fixture.exitCode}: ${output()}`);
    try { const response = await fetch(`${url}/state`); if (response.ok) return response.json() as Promise<{ hostId: string; workspace: string }>; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture did not become ready: ${output()}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
