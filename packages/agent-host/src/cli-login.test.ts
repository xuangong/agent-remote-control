import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { commandChannel, relayCall } from './cli-client.js';
import { runLoginCommand } from './login-command.js';
import { credentialsPath, readCredentials, relayRequest, saveCredentials, type CliCredentials } from './relay-client.js';

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function stateDir() { const path = await mkdtemp(join(tmpdir(), 'arc-cli-login-')); cleanup.push(path); return path; }

const credentials: CliCredentials = { serverUrl: 'https://relay.example', basePath: '/u/alice-ns/', cookieName: '__Host-arc_session', token: 't'.repeat(43), expiresAt: Date.UTC(2026, 11, 1) };
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
function relay(answer: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const { status, body } = answer(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

it('keeps the command line session private and sends it as the website does', async () => {
  const dir = await stateDir();
  expect(await readCredentials(dir)).toBeUndefined();
  await saveCredentials(dir, credentials);
  if (process.platform !== 'win32') expect((await stat(credentialsPath(dir))).mode & 0o777).toBe(0o600);
  expect(await readCredentials(dir)).toEqual(credentials);
  if (process.platform !== 'win32') {
    await chmod(credentialsPath(dir), 0o644);
    await expect(readCredentials(dir)).rejects.toMatchObject({ code: 'insecure_credentials' });
  }
  await writeFile(credentialsPath(dir), JSON.stringify({ ...credentials, basePath: '/elsewhere/' }), { mode: 0o600 });
  await chmod(credentialsPath(dir), 0o600);
  expect(await readCredentials(dir)).toBeUndefined();

  const { calls, fetcher } = relay(call => call.url.endsWith('/auth/status') ? { status: 401 } : { status: 200, body: { hosts: [] } });
  expect(await relayRequest(credentials, 'GET', '/v1/remote/hosts', undefined, fetcher)).toEqual({ status: 200, data: { hosts: [] } });
  expect(calls[0]).toMatchObject({ url: 'https://relay.example/u/alice-ns/v1/remote/hosts', method: 'GET',
    headers: { cookie: `__Host-arc_session=${credentials.token}`, origin: 'https://relay.example' } });
  await expect(relayRequest(credentials, 'GET', '/auth/status', undefined, fetcher)).rejects.toMatchObject({ code: 'signed_out' });
  expect(calls[1]!.url).toBe('https://relay.example/auth/status');
  await expect(relayRequest({ ...credentials, serverUrl: 'http://relay.example' }, 'GET', '/v1/remote/hosts', undefined, fetcher)).rejects.toMatchObject({ code: 'invalid_server' });
});

it('signs the command line in once the browser allows its code, and out again', async () => {
  const dir = await stateDir();
  let polls = 0;
  const { calls, fetcher } = relay(call => {
    if (call.url.endsWith('/auth/cli/start')) return { status: 200, body: { deviceCode: 'device', userCode: 'BCDFGHJK', verificationUrl: 'https://relay.example/auth/cli?code=BCDFGHJK', intervalMs: 2000, expiresAt: Date.now() + 600_000 } };
    if (call.url.endsWith('/auth/cli/token')) return ++polls < 2 ? { status: 202, body: { status: 'pending' } }
      : { status: 200, body: { status: 'approved', token: credentials.token, basePath: credentials.basePath, cookieName: credentials.cookieName, expiresAt: credentials.expiresAt } };
    if (call.url.endsWith('/auth/status')) return { status: 200, body: { user: { id: 'alice' } } };
    return { status: 200, body: { ok: true } };
  });
  let output = '';
  const opened: string[] = [], slept: number[] = [];
  const context = { stateDir: dir, pairedServer: async () => 'https://relay.example/u/ignored/', write: (text: string) => { output += text; }, fetcher,
    open: (url: string) => { opened.push(url); }, sleep: async (ms: number) => { slept.push(ms); } };
  expect(await runLoginCommand('login', [], context)).toBe(0);
  expect(output).toContain('allow code BCDFGHJK');
  expect(opened).toEqual(['https://relay.example/auth/cli?code=BCDFGHJK']);
  expect(slept).toEqual([2000, 2000]);
  expect(calls[0]).toMatchObject({ url: 'https://relay.example/auth/cli/start', body: { label: expect.any(String) } });
  expect(calls.slice(1).map(call => call.body)).toEqual([{ deviceCode: 'device' }, { deviceCode: 'device' }]);
  expect(await readCredentials(dir)).toEqual(credentials);

  output = '';
  expect(await runLoginCommand('login', ['status'], context)).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ signedIn: true, serverUrl: 'https://relay.example', user: { id: 'alice' } });
  output = '';
  expect(await runLoginCommand('logout', [], context)).toBe(0);
  expect(calls.at(-1)).toMatchObject({ url: 'https://relay.example/auth/logout', method: 'POST', headers: { cookie: `__Host-arc_session=${credentials.token}` } });
  expect(await readCredentials(dir)).toBeUndefined();
  output = '';
  expect(await runLoginCommand('login', ['status'], context)).toBe(0);
  expect(JSON.parse(output)).toEqual({ signedIn: false });
});

it('reports a refused sign-in and wrong usage', async () => {
  const dir = await stateDir();
  const { fetcher } = relay(call => call.url.endsWith('/auth/cli/start')
    ? { status: 200, body: { deviceCode: 'device', userCode: 'BCDFGHJK', verificationUrl: 'https://relay.example/auth/cli?code=BCDFGHJK', expiresAt: Date.now() + 600_000 } }
    : { status: 403, body: { status: 'denied' } });
  let output = '';
  const context = { stateDir: dir, pairedServer: async () => undefined, write: (text: string) => { output += text; }, fetcher, open: () => {}, sleep: async () => {} };
  expect(await runLoginCommand('login', [], context)).toBe(2);
  expect(JSON.parse(output).error.code).toBe('invalid_request');
  output = '';
  expect(await runLoginCommand('login', ['--server', 'https://relay.example', '--no-browser'], context)).toBe(1);
  expect(JSON.parse(output.slice(output.indexOf('{')))).toMatchObject({ error: { code: 'login_refused' } });
  expect(await readCredentials(dir)).toBeUndefined();
});

it('reaches a session through the Relay when no Controller runs here, and names the Host it asks', async () => {
  const { calls, fetcher } = relay(call => call.url.includes('/hosts/host-b/') ? { status: 200, body: { result: { session: { address: 'host-b/codex/thread' } } } }
    : { status: 403, body: { code: 'session_forbidden', error: 'Session commands are available to the Host owner.' } });
  const channel = await commandChannel({}, async () => undefined, undefined, async () => credentials, fetcher);
  expect(channel.caller).toBe('owner');
  expect(await channel.call('session', { command: 'read', target: 'host-b/codex/thread' })).toEqual({ result: { session: { address: 'host-b/codex/thread' } } });
  expect(calls[0]).toMatchObject({ url: 'https://relay.example/u/alice-ns/v1/remote/hosts/host-b/session/call', method: 'POST', body: { request: { command: 'read', target: 'host-b/codex/thread' } } });
  expect(await channel.call('session', { command: 'list', host: 'host-c' })).toEqual({ error: { code: 'session_forbidden', message: 'Session commands are available to the Host owner.' } });
  expect(await channel.call('session', { command: 'list' })).toMatchObject({ error: { code: 'invalid_request' } });
  // A Controller forwarding a request names the Host itself.
  await relayCall(credentials, 'session', { command: 'create', providerId: 'codex', from: 'host-a/claude/old' }, fetcher, 'host-b');
  expect(calls.at(-1)!.url).toBe('https://relay.example/u/alice-ns/v1/remote/hosts/host-b/session/call');
  await expect(commandChannel({}, async () => undefined, undefined, async () => undefined, fetcher)).rejects.toMatchObject({ code: 'no_identity' });
});

it('sends any website request as the signed-in user', async () => {
  const { calls, fetcher } = relay(call => call.url.endsWith('/v1/remote/teams') ? { status: 200, body: { teams: [] } } : { status: 403, body: { code: 'forbidden_here', error: 'No.' } });
  const { runApiCommand } = await import('./api-command.js');
  let output = '';
  const write = (text: string) => { output += text; };
  expect(await runApiCommand(['GET', '/v1/remote/teams'], async () => credentials, write, fetcher)).toBe(0);
  expect(JSON.parse(output)).toEqual({ teams: [] });
  expect(calls[0]).toMatchObject({ url: 'https://relay.example/u/alice-ns/v1/remote/teams', method: 'GET' });
  output = '';
  expect(await runApiCommand(['POST', '/v1/remote/teams/action', '--body', '{"x":1}'], async () => credentials, write, fetcher)).toBe(1);
  expect(JSON.parse(output).error.code).toBe('forbidden_here');
  expect(calls[1]).toMatchObject({ method: 'POST', body: { x: 1 } });
  for (const args of [['PATCH', '/v1/x'], ['GET', 'v1/x'], ['GET', '/v1/../auth'], ['GET', '/v1/x', '--body', '{}'], ['POST', '/v1/x', '--body', '{']]) {
    output = '';
    expect(await runApiCommand(args, async () => credentials, write, fetcher)).toBe(2);
  }
  output = '';
  expect(await runApiCommand(['GET', '/v1/x'], async () => undefined, write, fetcher)).toBe(1);
  expect(JSON.parse(output).error.code).toBe('signed_out');
});
