import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmjs.org', npm_config_fetch_retries: '0', npm_config_fetch_timeout: '20000' };
const command = (program, args, cwd, timeout = 60000) => {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${program}: ${result.error}`);
  assert.equal(result.status, 0, `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

test('installed public ARDB contains its local service and recovers exact prefixes over real transports', { timeout: 390000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ardb-package-')));
  const artifacts = join(directory, 'tarballs'), prefix = join(directory, 'installed');
  await mkdir(artifacts); await mkdir(prefix);
  try {
    const names = ['agent-platform', 'agent-provider-sdk', 'agent-remote-protocol', 'codex-daemon-client', 'agent-provider-codex', 'agent-remote-relay', 'agent-remote-web', 'agent-remote-debugger'];
    const dependencies = {};
    for (const name of names) {
      const path = join(repository, 'packages', name), manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      assert.equal(manifest.private, false, name);
      const output = command('pnpm', ['pack', '--pack-destination', artifacts, '--json'], path);
      const tarball = JSON.parse(output).filename;
      dependencies[manifest.name] = `file:${resolve(path, tarball)}`;
    }
    await writeFile(join(prefix, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { ...dependencies, typescript: '5.9.3', '@types/node': '24.13.3', '@types/ws': '^8.18.1', '@types/react': '^18.3.0', '@types/react-dom': '^18.3.0' } }));
    command('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], prefix, 300000);
    const installed = join(prefix, 'node_modules/@orchardworks/agent-remote-debugger');
    for (const name of Object.keys(dependencies)) {
      const location = join(prefix, 'node_modules', name);
      assert.equal((await lstat(location)).isSymbolicLink(), false, name);
      assert.ok((await realpath(location)).startsWith(prefix + '/'));
    }
    for (const name of ['agent-remote-controller', 'agent-remote-hosted', 'agent-remote-tunnel', 'agent-provider-claude', 'agent-provider-opencode', 'agent-provider-copilot', 'agent-remote-lab']) {
      await assert.rejects(lstat(join(prefix, 'node_modules/@orchardworks', name)), { code: 'ENOENT' });
    }
    const local = await readFile(join(installed, 'dist/local-session-succession.js'), 'utf8');
    assert.ok(!local.includes('@orchardworks/agent-remote-controller'));
    assert.ok(!local.includes(repository));
    const graph = JSON.parse(await readFile(join(installed, 'dist/local-session-succession.meta.json'), 'utf8'));
    assert.ok(graph.inputs.includes('local-session-runtime.js'));
    assert.ok(graph.inputs.includes('local-succession-replay.js'));
    assert.ok(graph.declarations.includes('local-succession-replay.d.ts'));
    assert.ok(graph.imports.every(name => name.startsWith('node:') || ['@orchardworks/agent-provider-sdk', '@orchardworks/agent-remote-protocol', '@orchardworks/agent-remote-relay'].includes(name)));
    for (const name of graph.declarations) {
      const declaration = await readFile(join(installed, 'dist/internal/local-succession', name), 'utf8');
      assert.ok(!declaration.includes('@orchardworks/agent-remote-controller')); assert.ok(!declaration.includes('sourceMappingURL'));
    }
    assert.match(command(join(prefix, 'node_modules/.bin/ardb'), ['--help'], prefix, 10000), /Usage: ardb/);
    await writeFile(join(prefix, 'consumer.ts'), `import { createDebuggerServer, type DebuggerServerOptions } from '@orchardworks/agent-remote-debugger/dist/server.js';
import { LocalSessionSuccession, type LocalSuccessionProvider } from '@orchardworks/agent-remote-debugger/dist/local-session-succession.js';
declare const adapter: LocalSuccessionProvider; const options: DebuggerServerOptions = { adapter, successionStateDirectory: './state' };
void createDebuggerServer; void options; void LocalSessionSuccession;
`);
    command(join(prefix, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--module', 'Node16', '--moduleResolution', 'Node16', '--target', 'ES2022', '--skipLibCheck', 'false', 'consumer.ts'], prefix, 30000);
    await cp(join(repository, 'packages/agent-remote-debugger/src/fixtures/prefix-adapter.mjs'), join(prefix, 'prefix-adapter.mjs'));
    await writeFile(join(prefix, 'smoke.mjs'), smoke);
    command(process.execPath, ['--test', 'smoke.mjs'], prefix, 40000);
    console.log(`Installed ${names.length} public tarballs outside the repository; CLI, declarations, HTTP/WS commit, history, restart and unknown recovery passed.`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const smoke = String.raw`
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDebuggerServer } from '@orchardworks/agent-remote-debugger/dist/server.js';
import { createDebuggerRuntime } from '@orchardworks/agent-remote-debugger/dist/runtime.js';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web/headless';
import { createPrefixAdapter } from './prefix-adapter.mjs';
const post = (server, action, body) => fetch(server.url + '/__ardb/succession/' + action, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
async function prepare(server, id) {
 const response = await post(server, 'describe', { agentId: server.agentId, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } }); assert.equal(response.status, 200);
 const { role } = await response.json();
 return post(server, 'prepare', { operationId: id, roleId: role.id, expectedRevision: role.revision, from: role.current, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message-1' } });
}
test('installed direct runtime commits, reads original history, restores B and never retries unknown creation', { timeout: 25000 }, async () => {
 const root = await mkdtemp(join(process.cwd(), 'native-')); let server, old, current;
 const adapter = createPrefixAdapter(root), options = { adapter, config: { cwd: root, sessionId: 'A' }, successionStateDirectory: join(root, 'state'), resourceDirectory: join(root, 'resources') };
 try {
  server = await createDebuggerServer(options); const original = server.agentId;
  old = await createDebuggerRuntime(original, { relayUrl: server.url, origin: server.url }); await old.ready(3000);
  assert.equal((await (await prepare(server, 'edit')).json()).record.phase, 'ready');
  assert.equal((await post(server, 'commit', { operationId: 'edit', expectedRevision: 1 })).status, 200);
  const committed = await (await fetch(server.url + '/__ardb/session')).json(); assert.equal(committed.nativeSessionId, 'candidate-1');
  const replay = new HttpWebSocketTransport(server.url, { sessionSuccessions: true });
  const page = await replay.fetchSessionSuccessions({ limit: 1 }); assert.equal(page.successions.length, 1);
  const roleId = page.successions[0].projection.role.id;
  const receipt = page.successions[0].projection.receipt;
  const originalRequest = { operationId: receipt.operationId, roleId, expectedRevision: receipt.expectedRevision, from: receipt.from, preparation: receipt.preparation };
  assert.deepEqual((await (await post(server, 'prepare', originalRequest)).json()).record, receipt);
  assert.equal(page.successions[0].to.hostId, 'local'); assert.equal(page.successions[0].projection.role.revision, 2);
  assert.deepEqual(await replay.fetchSessionSuccessionOperation(roleId, 'edit'), page.successions[0]);
  assert.equal((await replay.fetchSessionSuccessionCurrent(roleId)).locator.nativeSessionId, 'candidate-1');
  assert.equal((await fetch(server.url + '/v1/session-successions?limit=65')).status, 400);
  await assert.rejects(old.client.sendMessage('obsolete'));
  assert.match(JSON.stringify(old.replica.getState().timeline), /discarded tail/);
  current = await createDebuggerRuntime(committed.agentId, { relayUrl: server.url, origin: server.url }); await current.ready(3000); await current.client.sendMessage('replacement');
  old.close(); current.close(); await server.close();
  server = await createDebuggerServer(options); assert.deepEqual(server.session, committed); assert.equal((await adapter.state()).forks, 1); assert.equal((await adapter.state()).creates, 1);
  const restoredReplay = new HttpWebSocketTransport(server.url, { sessionSuccessions: true });
  assert.deepEqual(await restoredReplay.fetchSessionSuccessionOperation(roleId, 'edit'), page.successions[0]);
  assert.deepEqual((await (await post(server, 'prepare', originalRequest)).json()).record, receipt);
  assert.equal((await adapter.state()).forks, 1);
  const history = await (await fetch(server.url + '/__ardb/history?nativeSessionId=A')).json();
  old = await createDebuggerRuntime(history.agentId, { relayUrl: server.url, origin: server.url }); await old.ready(3000); await assert.rejects(old.client.sendMessage('historical'));
  await adapter.unknown(); assert.equal((await (await prepare(server, 'unknown')).json()).record.phase, 'unknown'); old.close(); await server.close();
  server = await createDebuggerServer(options); assert.equal((await (await prepare(server, 'unknown')).json()).record.phase, 'unknown');
  assert.equal((await post(server, 'reconcile', { operationId: 'unknown', expectedRevision: 2 })).status, 409); assert.equal((await adapter.state()).forks, 2); assert.equal(server.session.nativeSessionId, 'candidate-1');
 } finally { old?.close(); current?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
});
`;
