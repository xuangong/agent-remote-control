import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OpenCodeCallbackBridge } from './callback-bridge.js';
// @ts-expect-error The plugin is a separately bundled native module.
import plugin from './bridge-plugin.mjs';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(timeout = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-callback-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'callback.json');
  const bridge = new OpenCodeCallbackBridge(path, 'http://127.0.0.1:4096', timeout);
  await bridge.start(); cleanup.push(() => bridge.close());
  const config = JSON.parse(await readFile(path, 'utf8'));
  const request = async (path: string, body?: unknown, token = config.token) => fetch(config.baseUrl + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000) });
  return { bridge, directory, path, config, request };
}
const tool = (execute: (args: unknown) => Promise<string>) => ({ name: 'read_source_session', description: 'Read the fixed source', inputSchema: {
  type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
}, execute });

it('authenticates real HTTP callbacks, binds native context and validates the actual arguments', async () => {
  const f = await fixture(); const calls: unknown[] = [];
  f.bridge.bind('native-ask', [tool(async args => { calls.push(args); return 'fixed-source'; })]);
  const native = await plugin({ directory: f.directory, serverUrl: new URL('http://127.0.0.1:4096') }, { configPath: f.path });
  expect(f.bridge.isAvailable(f.directory)).toBe(true);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect((await f.request('/sessions/native-ask/discover', undefined, 'wrong')).status).toBe(401);
  expect((await f.request('/sessions/unbound/discover')).status).toBe(403);
  expect(await native.tool.arc_host_invoke.execute({ name: 'read_source_session', arguments: { limit: 1 } }, { sessionID: 'native-ask' })).toBe('fixed-source');
  for (const arguments_ of [{ source: 'other' }, { sessionID: 'native-ask' }, { limit: 11 }, { limit: '1' }]) {
    await expect(native.tool.arc_host_invoke.execute({ name: 'read_source_session', arguments: arguments_ }, { sessionID: 'native-ask' })).rejects.toThrow();
  }
  await expect(native.tool.arc_host_invoke.execute({ name: 'read_source_session', arguments: { sessionID: 'native-ask' } }, { sessionID: 'unbound' })).rejects.toThrow();
  expect(calls).toEqual([{ limit: 1 }]);
}, 10000);

it('revokes bindings and preserves a replacement when stale session disposal runs', async () => {
  const f = await fixture(); const old = f.bridge.bind('native', [tool(async () => 'old')]);
  const latest = f.bridge.bind('native', [tool(async () => 'new')]); old();
  expect(await (await f.request('/sessions/native/invoke', { name: 'read_source_session', arguments: {} })).json()).toEqual({ output: 'new' });
  latest(); expect((await f.request('/sessions/native/discover')).status).toBe(403);
}, 10000);

it('caps request, output and execution time without exposing callback exceptions', async () => {
  const f = await fixture(100);
  f.bridge.bind('native', [tool(async () => { throw new Error('private-token-or-path'); })]);
  const rejected = await f.request('/sessions/native/invoke', { name: 'read_source_session', arguments: {} });
  expect(await rejected.text()).not.toContain('private-token-or-path');
  f.bridge.bind('native', [tool(async () => 'x'.repeat(140000))]);
  expect((await f.request('/sessions/native/invoke', { name: 'read_source_session', arguments: {} })).status).toBe(413);
  expect((await f.request('/sessions/native/invoke', { name: 'x'.repeat(70000), arguments: {} })).status).toBe(400);
  f.bridge.bind('native', [tool(async () => new Promise(() => undefined))]);
  const started = Date.now();
  const outcome = await f.request('/sessions/native/invoke', { name: 'read_source_session', arguments: {} }).then(r => r.status, () => 504);
  expect(outcome).toBe(504); expect(Date.now() - started).toBeLessThan(1800);
}, 10000);

it('rereads private rendezvous after Controller restart and rejects a second active owner', async () => {
  const f = await fixture(); const native = await plugin({ directory: f.directory, serverUrl: new URL('http://127.0.0.1:4096') }, { configPath: f.path });
  const conflicting = new OpenCodeCallbackBridge(f.path, 'http://127.0.0.1:4096');
  await expect(conflicting.start()).rejects.toThrow(/owner/);
  expect(JSON.parse(await readFile(f.path, 'utf8')).token).toBe(f.config.token);
  await f.bridge.close();
  const restarted = new OpenCodeCallbackBridge(f.path, 'http://127.0.0.1:4096'); cleanup.push(() => restarted.close()); await restarted.start();
  restarted.bind('resumed', [tool(async () => 'restored')]);
  expect(await native.tool.arc_host_invoke.execute({ name: 'read_source_session', arguments: {} }, { sessionID: 'resumed' })).toBe('restored');
}, 10000);

it('does not report a plugin from another server or expose an unbound session manifest', async () => {
  const f = await fixture();
  const wrong = await plugin({ directory: f.directory, serverUrl: new URL('http://127.0.0.1:4097') }, { configPath: f.path });
  expect(f.bridge.isAvailable(f.directory)).toBe(false);
  await expect(wrong.tool.arc_host_discover.execute({}, { sessionID: 'any' })).rejects.toThrow(/does not match/);
  expect((await f.request('/ready', { version: 1, directory: f.directory, serverUrl: 'http://127.0.0.1:4097' })).status).toBe(409);
}, 10000);

it('closing during asynchronous startup leaves no listener, file or usable bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-callback-race-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'callback.json'); const bridge = new OpenCodeCallbackBridge(path, 'http://127.0.0.1:4096');
  const startup = bridge.start(); const closing = bridge.close();
  await startup.catch(() => undefined); await closing;
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => bridge.bind('id', [])).toThrow(/closed/); await expect(bridge.start()).rejects.toThrow(/closed/);
}, 10000);
