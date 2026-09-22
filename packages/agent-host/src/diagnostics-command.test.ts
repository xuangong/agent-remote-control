import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runDiagnosticsCommand } from './diagnostics-command.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'diagnostics-command-')); roots.push(root); return root; }
async function run(root: string, args: string[]) { let output = ''; await runDiagnosticsCommand(args, root, text => { output += text; }); return JSON.parse(output); }
const relay = { id: 'e1', timestamp: '2026-09-20T01:00:00.000Z', source: 'relay', hostId: 'h1', relayInstanceId: 'r1', event: 'host_disconnected' };
it('finds log paths without requiring connection configuration or running services', async () => {
  const root = await setup();
  expect(await run(root, ['--paths'])).toEqual({ controller: join(root, 'agent-host.log'), server: join(root, 'relay-diagnostics.log') });
});
it('reads archived records by source and event time without merging sources', async () => {
  const root = await setup();
  await writeFile(join(root, 'relay-diagnostics.log.1'), JSON.stringify(relay) + '\n');
  await writeFile(join(root, 'relay-diagnostics.log'), JSON.stringify({ ...relay, id: 'e2', timestamp: '2026-09-21T01:00:00.000Z' }) + '\n');
  await writeFile(join(root, 'agent-host.log'), JSON.stringify({ timestamp: '2026-09-21T02:00:00.000Z', event: 'uplink_registered' }) + '\n');
  expect(await run(root, ['--source', 'server', '--since', '2026-09-21T00:00:00Z', '--limit', '1'])).toEqual({ server: [{ ...relay, id: 'e2', timestamp: '2026-09-21T01:00:00.000Z' }] });
  const all = await run(root, ['--source', 'all']);
  expect(all.server.map((entry: { id: string }) => entry.id)).toEqual(['e1', 'e2']);
  expect(all.controller).toEqual([{ timestamp: '2026-09-21T02:00:00.000Z', event: 'uplink_registered' }]);
});
it('skips partial archives and unvalidated server log records', async () => {
  const root = await setup();
  await writeFile(join(root, 'relay-diagnostics.log'), 'partial\n' + JSON.stringify({ ...relay, token: 'secret' }) + '\n' + JSON.stringify(relay) + '\n');
  expect(await run(root, ['--source', 'server'])).toEqual({ server: [relay] });
});
it.each([['--limit', '0'], ['--limit', '1001'], ['--limit', '1x'], ['--since', 'yesterday'], ['--source', 'relay'], ['--unknown']])('rejects invalid options %j', async (...args) => {
  await expect(run(await setup(), args)).rejects.toThrow();
});
