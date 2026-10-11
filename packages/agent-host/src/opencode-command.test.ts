import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { runOpenCodeCommand } from './opencode-command.js';
import { ensureOpenCodeServerConfig, openCodeServerLocation } from './opencode-server-state.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arc-opencode-command-')); roots.push(root);
  const executable = join(root, 'native.mjs'); const output = join(root, 'output.json');
  await writeFile(executable, `import {writeFileSync} from 'node:fs';writeFileSync(process.env.NATIVE_OUTPUT, JSON.stringify({args:process.argv.slice(2),password:process.env.OPENCODE_PASSWORD,legacyPassword:process.env.OPENCODE_SERVER_PASSWORD,key:process.env.AGENT_HOST_REMOTE_KEY}));process.exit(Number(process.env.NATIVE_EXIT ?? 0));`);
  await writeFile(join(root, 'connection.json'), JSON.stringify({ serverUrl: 'https://relay.invalid', remoteKey: 'private-key', environment: {
    AGENT_HOST_OPENCODE: executable, AGENT_HOST_OPENCODE_URL: 'http://127.0.0.1:4899', AGENT_HOST_OPENCODE_USERNAME: 'opencode', AGENT_HOST_OPENCODE_PASSWORD: 'local-secret',
  } }));
  return { root, async run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const code = await runOpenCodeCommand(args, root, { NATIVE_OUTPUT: output, AGENT_HOST_REMOTE_KEY: 'relay-secret', ...env });
    return { code, ...JSON.parse(await readFile(output, 'utf8')) };
  } };
}
it('attaches an explicit native session to the saved server using environment credentials', async () => {
  const f = await fixture();
  expect(await f.run(['resume', 'session name'])).toEqual({ code: 0, args: ['--server', 'http://127.0.0.1:4899', '--session', 'session name'], password: 'local-secret' });
}, 10000);
it('attaches new and last sessions without native server ownership or takeover', async () => {
  const f = await fixture();
  expect((await f.run([])).args).toEqual(['--server', 'http://127.0.0.1:4899', process.cwd()]);
  expect((await f.run(['resume', '--last'])).args).toEqual(['--server', 'http://127.0.0.1:4899', '--continue']);
  await expect(f.run(['resume', 'session', '--take-over'])).rejects.toThrow(/shared|takeover/i);
}, 10000);
it('keeps native commands and explicit alternate attachments free of saved server credentials', async () => {
  const f = await fixture();
  expect(await f.run(['--server', 'http://127.0.0.1:4999'])).toEqual({ code: 0, args: ['--server', 'http://127.0.0.1:4999'] });
  expect(await f.run(['--version'], { NATIVE_EXIT: '23' })).toEqual({ code: 23, args: ['--version'] });
}, 10000);

it('loads generated managed server credentials for resume without leaking them to alternate native commands', async () => {
  const f = await fixture();
  const env = { AGENT_HOST_OPENCODE_URL: 'http://127.0.0.1:4899' };
  const location = openCodeServerLocation(f.root, env);
  await ensureOpenCodeServerConfig(location.directory, location.url, { ...env, AGENT_HOST_OPENCODE_USERNAME: 'opencode', AGENT_HOST_OPENCODE_PASSWORD: 'local-secret' });
  const saved = JSON.parse(await readFile(join(f.root, 'connection.json'), 'utf8'));
  delete saved.environment.AGENT_HOST_OPENCODE_USERNAME;
  delete saved.environment.AGENT_HOST_OPENCODE_PASSWORD;
  await writeFile(join(f.root, 'connection.json'), JSON.stringify(saved));
  expect(await f.run(['resume', 'session'])).toMatchObject({ password: 'local-secret' });
  expect(await f.run(['--version'])).toEqual({ code: 0, args: ['--version'] });
}, 10000);

it('handles lifecycle command validation without forwarding it to the native CLI', async () => {
  const f = await fixture();
  await expect(runOpenCodeCommand(['server', 'destroy'], f.root, {})).rejects.toThrow('start|stop|restart|status');
  const port = createServer();
  await new Promise<void>(resolve => port.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(port.address() as { port: number }).port}`;
  await new Promise<void>((resolve, reject) => port.close(error => error ? reject(error) : resolve()));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    // An external endpoint with no server is a read-only status check.
    expect(await runOpenCodeCommand(['server', 'status'], f.root, { AGENT_HOST_OPENCODE_URL: endpoint })).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ running: false, ownership: 'none', autoStart: false });
  } finally { output.mockRestore(); }
}, 10000);
