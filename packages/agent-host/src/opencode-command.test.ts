import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runOpenCodeCommand } from './opencode-command.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arc-opencode-command-')); roots.push(root);
  const executable = join(root, 'native.mjs'); const output = join(root, 'output.json');
  await writeFile(executable, `import {writeFileSync} from 'node:fs';writeFileSync(process.env.NATIVE_OUTPUT, JSON.stringify({args:process.argv.slice(2),password:process.env.OPENCODE_SERVER_PASSWORD,username:process.env.OPENCODE_SERVER_USERNAME,key:process.env.AGENT_HOST_REMOTE_KEY}));process.exit(Number(process.env.NATIVE_EXIT ?? 0));`);
  await writeFile(join(root, 'connection.json'), JSON.stringify({ serverUrl: 'https://relay.invalid', remoteKey: 'private-key', environment: {
    AGENT_HOST_OPENCODE: executable, AGENT_HOST_OPENCODE_URL: 'http://127.0.0.1:4899', AGENT_HOST_OPENCODE_USERNAME: 'local', AGENT_HOST_OPENCODE_PASSWORD: 'local-secret',
  } }));
  return { root, async run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const code = await runOpenCodeCommand(args, root, { NATIVE_OUTPUT: output, AGENT_HOST_REMOTE_KEY: 'relay-secret', ...env });
    return { code, ...JSON.parse(await readFile(output, 'utf8')) };
  } };
}
it('attaches an explicit native session to the saved server using environment credentials', async () => {
  const f = await fixture();
  expect(await f.run(['resume', 'session name'])).toEqual({ code: 0, args: ['attach', 'http://127.0.0.1:4899', '--session', 'session name'], username: 'local', password: 'local-secret' });
}, 10000);
it('attaches new and last sessions without native server ownership or takeover', async () => {
  const f = await fixture();
  expect((await f.run([])).args).toEqual(['attach', 'http://127.0.0.1:4899', '--dir', process.cwd()]);
  expect((await f.run(['resume', '--last'])).args).toEqual(['attach', 'http://127.0.0.1:4899', '--continue']);
  await expect(f.run(['resume', 'session', '--take-over'])).rejects.toThrow(/shared|takeover/i);
}, 10000);
it('keeps native commands and explicit alternate attachments free of saved server credentials', async () => {
  const f = await fixture();
  expect(await f.run(['attach', 'http://127.0.0.1:4999'])).toEqual({ code: 0, args: ['attach', 'http://127.0.0.1:4999'] });
  expect(await f.run(['--version'], { NATIVE_EXIT: '23' })).toEqual({ code: 23, args: ['--version'] });
}, 10000);
