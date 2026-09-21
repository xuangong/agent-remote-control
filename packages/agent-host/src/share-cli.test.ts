import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

async function run(input: string, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'arc-share-'));
  const socket = join(root, 'control.sock'); const token = 'private-management-token';
  const calls: Record<string, unknown>[] = [];
  const server = createServer({ allowHalfOpen: true }, client => {
    let raw = ''; client.on('data', data => { raw += data; });
    client.on('end', () => {
      const request = JSON.parse(raw); calls.push(request);
      if (request.token !== token) { client.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      if (legacy) { client.end(JSON.stringify({ error: 'Unknown local management action.' })); return; }
      client.end(JSON.stringify(request.action === 'share-context'
        ? { hostId: 'host', serverUrl: 'https://agents.example', providers: [{ providerId: 'codex', displayName: 'Codex' }] }
        : { status: 200, body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native', title: 'Session', state: 'idle' }) }));
    });
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    server.listen(socket); await once(server, 'listening');
    await writeFile(join(root, 'daemon.json'), JSON.stringify({ pid: process.pid, socket, token }));
    child = spawn(process.execPath, [process.env.AGENT_HOST_SHARE_TEST_CLI ?? 'dist/cli.js', 'share'], { env: { ...process.env, AGENT_HOST_STATE_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
    const done = once(child, 'close'); child.stdin!.end(input);
    const [code] = await done;
    return { code, output, calls, token };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill('SIGKILL'); await done; }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
it('runs the built CLI through its authenticated socket and accepts buffered interactive answers', async () => {
  const result = await run('1\nnative\n');
  expect(result.code).toBe(0); expect(result.output).toContain('https://agents.example/?host=host&provider=codex&session=native');
  expect(result.output).toContain('█'); expect(result.output).not.toContain(result.token);
  expect(result.calls.map(call => call.action)).toEqual(['share-context', 'share-catalog']);
});
it('ends on EOF without generating a link', async () => {
  const result = await run(''); expect(result.code).toBe(0); expect(result.output).toContain('cancelled');
  expect(result.calls).toHaveLength(1);
});
it('explains that an older running Controller needs an upgrade', async () => {
  const result = await run('', true); expect(result.code).toBe(1); expect(result.output).toContain('Update it and restart');
  expect(result.output).not.toContain(result.token);
});
