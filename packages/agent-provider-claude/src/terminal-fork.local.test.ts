import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from '../dist/provider.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

/** A terminal turn on a session a resident SDK process holds: does the resident process's next send see it? */
function terminal(fixture: Awaited<ReturnType<typeof nativeFixture>>, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(fixture.options.env)) { if (value === undefined) delete env[key]; else env[key] = value; }
  return new Promise((resolve, reject) => {
    const child = spawn(fixture.options.executable, ['-p', ...args], { cwd: fixture.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`terminal ended with ${code}: ${output.slice(0, 300)}`)));
  });
}

it('a resident session continues from its own last message: the model does not see a turn a terminal wrote meanwhile (why the Controller releases it)', async () => {
  const fixture = await nativeFixture((_body, response) => nativeReply(response, [{ type: 'text', text: 'REPLY' }]));
  const provider = new ClaudeAgentProvider({ ...fixture.options });
  try {
    const session = await provider.createSession({ cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929', permissionMode: 'bypassPermissions' });
    const done = () => fixture.bodies.length;
    const events: any[] = [];
    void (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
    await session.sendMessage('First prompt');
    await expect.poll(() => events.filter(e => e.type === 'turn_completed').length, { timeout: 30000 }).toBe(1);
    const id = (await session.runtimeInfo()).persistence!.sessionId;
    await terminal(fixture, ['--resume', id, 'TERMINAL_WORD_ZEBRA']);
    const before = done();
    await session.sendMessage('Now repeat the word');
    await expect.poll(() => events.filter(e => e.type === 'turn_completed').length, { timeout: 30000 }).toBe(2);
    const last = JSON.stringify(fixture.bodies.at(-1).messages);
    const seesTerminal = last.includes('ZEBRA');
    expect(fixture.bodies.length - before).toBeGreaterThan(0);
    expect(seesTerminal).toBe(false);
    await session.dispose();
  } finally { await provider.dispose(); await fixture.close(); }
}, 120000);
