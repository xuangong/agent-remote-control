import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, realpath, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {afterEach, expect, it} from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arc-copilot-cli-')); roots.push(root);
  const executable = join(root, 'native copilot.mjs');
  await writeFile(executable, String.raw`
if (process.argv.includes('--stdio')) {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) break;
      const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())[1]);
      if (buffer.length < end + 4 + size) break;
      const request = JSON.parse(buffer.subarray(end+4,end+4+size)); buffer = buffer.subarray(end+4+size);
      const result = request.method === 'connect' ? {protocolVersion:3} : request.method === 'sessions.checkInUse' ? {inUse:process.env.NATIVE_TEST_IN_USE ? request.params.sessionIds : []} : {};
      const response = JSON.stringify({jsonrpc:'2.0',id:request.id,result});
      process.stdout.write('Content-Length: '+Buffer.byteLength(response)+'\r\n\r\n'+response);
      if (request.method === 'runtime.shutdown') setTimeout(()=>process.exit(0),10);
    }
  });
} else {console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.COPILOT_HOME,key:process.env.AGENT_HOST_REMOTE_KEY,relay:process.env.RELAY_SECRET}));process.exit(Number(process.env.NATIVE_TEST_EXIT??0));}
`);
  await writeFile(join(root, 'connection.json'), JSON.stringify({serverUrl: 'https://relay.invalid', remoteKey: 'private-key', environment: {
    AGENT_HOST_COPILOT: executable, AGENT_HOST_COPILOT_HOME: join(root, 'copilot home'), AGENT_HOST_WORKSPACE: '/saved/workspace',
  }}));
  const cli = resolve('dist/cli.js');
  const run = (args: string[], env: NodeJS.ProcessEnv = {}, cwd = process.cwd()) => execute(process.execPath, [cli, 'copilot', ...args], {
    cwd, timeout: 5000, env: {PATH: process.env.PATH, HOME: process.env.HOME, AGENT_HOST_STATE_DIR: root,
      AGENT_HOST_REMOTE_KEY: 'private-key', RELAY_SECRET: 'private-secret', ...env},
  });
  return {root, executable, run};
}

it('resumes through the saved Copilot executable and profile without exposing Relay credentials', async () => {
  const f = await fixture();
  const result = JSON.parse((await f.run(['resume', '01a0ba06-321d-7600-9141-a1ad0779fc9f'])).stdout);
  expect(result).toEqual({args: ['--resume=01a0ba06-321d-7600-9141-a1ad0779fc9f'], cwd: process.cwd(), home: join(f.root, 'copilot home')});
});

it.each([
  [['resume'], ['--resume']],
  [['resume', '--last'], ['--continue']],
  [['resume', 'session name', '--model', 'model'], ['--resume=session name', '--model', 'model']],
  [['--resume=existing', '--plain-diff'], ['--resume=existing', '--plain-diff']],
  [['login'], ['login']], [['--help'], ['--help']],
  [['resume', 'literal $(touch nope)', '--', 'literal; text'], ['--resume=literal $(touch nope)', '--', 'literal; text']],
])('preserves native arguments while translating the resume shorthand: %j', async (args, expected) => {
  const f = await fixture();
  expect(JSON.parse((await f.run(args)).stdout).args).toEqual(expected);
});

it('starts a new session in the invoking shell directory and preserves explicit directory flags', async () => {
  const f = await fixture(); const cwd = join(f.root, 'project one'); await mkdir(cwd);
  expect(JSON.parse((await f.run([], {}, cwd)).stdout)).toMatchObject({cwd: await realpath(cwd), args: []});
  expect(JSON.parse((await f.run(['-C', '/explicit project'])).stdout).args).toEqual(['-C', '/explicit project']);
});

it('honors explicit configuration and runs locally without pairing', async () => {
  const f = await fixture();
  const env = {AGENT_HOST_COPILOT: f.executable, AGENT_HOST_COPILOT_HOME: join(f.root, 'override')};
  expect(JSON.parse((await f.run(['resume', 'existing'], env)).stdout).home).toBe(env.AGENT_HOST_COPILOT_HOME);
  await rm(join(f.root, 'connection.json'));
  expect(JSON.parse((await f.run(['--version'], env)).stdout).args).toEqual(['--version']);
});

it('resolves bare JavaScript entries from PATH and preserves failure exit codes', async () => {
  const f = await fixture();
  expect(JSON.parse((await f.run(['--help'], {AGENT_HOST_COPILOT: 'native copilot.mjs', PATH: f.root})).stdout).args).toEqual(['--help']);
  await expect(f.run([], {NATIVE_TEST_EXIT: '23'})).rejects.toMatchObject({code: 23});
  await expect(f.run([], {AGENT_HOST_COPILOT: 'missing.mjs', PATH: f.root})).rejects.toMatchObject({stderr: expect.stringContaining('not found on PATH')});
});

it('refuses an unmanaged native writer even for explicit takeover', async () => {
  const f=await fixture();
  await expect(f.run(['resume','existing','--take-over'],{NATIVE_TEST_IN_USE:'1'})).rejects.toMatchObject({stderr:expect.stringContaining('unmanaged native client')});
});

it('reports an unrequested native failure as unexpected and preserves its exit code', async () => {
  const f=await fixture();
  await expect(f.run(['resume','existing'],{NATIVE_TEST_EXIT:'23'})).rejects.toMatchObject({code:23,stderr:expect.stringContaining('"outcome":"unexpected"')});
});
