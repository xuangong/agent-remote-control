import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCodexCommand } from './codex-command.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arc-codex-command-')); roots.push(root);
  const capture = join(root, 'native.json'); const executable = join(root, 'codex');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,key:process.env.CODEX_GATEWAY_API_KEY,relayKey:process.env.AGENT_HOST_REMOTE_KEY,locale:process.env.LC_ALL}));\n`, { mode: 0o700 });
  const environment = { AGENT_HOST_CODEX: executable, TEST_CAPTURE: capture };
  return { root, environment, captured: async () => JSON.parse(await readFile(capture, 'utf8')) };
}
it('runs explicit private Codex commands without injecting a shared socket', async () => {
  const f = await fixture();
  expect(await runCodexCommand(['resume', '--last'], f.root, { ...f.environment, AGENT_HOST_CODEX_CONNECTION: 'private' })).toBe(0);
  expect((await f.captured()).args).toEqual(['resume', '--last']);
  expect(await runCodexCommand(['--remote', 'unix:///intentional.sock'], f.root, { ...f.environment, AGENT_HOST_CODEX_CONNECTION: 'private' })).toBe(0);
  expect((await f.captured()).args).toEqual(['--remote', 'unix:///intentional.sock']);
}, 10000);
it('loads the managed Gateway key and private home from the saved opt-in for native commands', async () => {
  const f = await fixture(); const home = join(f.root, 'gateway-codex'); await mkdir(home);
  await writeFile(join(home, 'gateway-credentials.json'), JSON.stringify({ apiKey: 'sk_private_gateway_key', keyId: 'host-key',
    baseUrl: 'https://gateway.example/v1', model: 'codex-test', hostId: 'host', serverUrl: 'https://relay.example', configHash: 'fixture' }));
  await writeFile(join(f.root, 'connection.json'), JSON.stringify({ serverUrl: 'https://relay.example', remoteKey: 'device-secret',
    environment: { AGENT_HOST_BOOTSTRAP_CODEX: '1', AGENT_HOST_CODEX: f.environment.AGENT_HOST_CODEX } }));
  expect(await runCodexCommand(['exec', 'hello'], f.root, { TEST_CAPTURE: f.environment.TEST_CAPTURE })).toBe(0);
  expect(await f.captured()).toEqual({ args: ['exec', 'hello'], home, key: 'sk_private_gateway_key', locale: 'C' });
}, 10000);
