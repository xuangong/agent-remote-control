import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Json } from './native.js';
import { spawnPi } from './process.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const script = (body: string) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-proc-')); roots.push(root);
  const path = join(root, 'cli.mjs'); writeFileSync(path, body); chmodSync(path, 0o755);
  return { path, root };
};
const wait = (test: () => boolean) => new Promise<void>((resolve, reject) => { const end = Date.now() + 5000; const tick = () => test() ? resolve() : Date.now() > end ? reject(new Error('timed out')) : setTimeout(tick, 5); tick(); });

describe('the pi process port', () => {
  it('reads one JSON record per LF, keeping U+2028 inside a string, and writes one per line', async () => {
    const { path, root } = script(`process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data', d => { b += d; let i; while ((i = b.indexOf('\\n')) >= 0) { const c = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); process.stdout.write(JSON.stringify({ echo: c.text, arg: process.argv[2], cwd: process.cwd(), env: process.env.ARC_X }) + '\\n'); } });`);
    const channel = spawnPi(path)({ args: ['--flag'], cwd: root, env: { ...process.env, ARC_X: 'yes' } });
    const received: Json[] = [];
    channel.onMessage(message => received.push(message));
    channel.send({ text: 'a b' });
    await wait(() => received.length === 1);
    expect(received[0]).toMatchObject({ echo: 'a b', arg: '--flag', env: 'yes' });
    expect(String(received[0]!.cwd)).toContain('pi-proc-');
    await channel.stop();
  });

  it('reports how the process ended, with the tail of its stderr, and refuses to write after that', async () => {
    const { path, root } = script(`process.stderr.write('bad config'); process.exit(3);`);
    const channel = spawnPi(path)({ args: [], cwd: root, env: {} });
    const exit = await new Promise<{ code: number | null; stderr: string }>(resolve => channel.onExit(resolve));
    expect(exit).toMatchObject({ code: 3, stderr: 'bad config' });
    expect(() => channel.send({ type: 'x' })).toThrow(/ended/);
    await channel.stop();
    let late = false; channel.onExit(() => { late = true; });
    expect(late).toBe(true);
  });

  it('ends a process that ignores its input, first politely and then by force', async () => {
    const { path, root } = script(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('{}');`);
    const channel = spawnPi(path, { killAfterMs: 100 })({ args: [], cwd: root, env: {} });
    const started = new Promise<void>(resolve => channel.onMessage(() => resolve()));
    await started;
    const stopped = Date.now();
    await channel.stop();
    expect(Date.now() - stopped).toBeGreaterThanOrEqual(90);
  });

  it('reports a program that cannot be started as an exit', async () => {
    const channel = spawnPi('/nonexistent/pi')({ args: [], cwd: tmpdir(), env: {} });
    const exit = await new Promise<{ code: number | null; stderr: string }>(resolve => channel.onExit(resolve));
    expect(exit.code).toBeNull();
    expect(exit.stderr).toMatch(/ENOENT/);
  });
});
