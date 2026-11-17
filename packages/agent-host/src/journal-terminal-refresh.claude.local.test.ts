import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../../agent-provider-claude/dist/catalog.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { SessionCreationStore } from './session-creation-store.js';
import { closeHosts, startRelayHost } from './test-utils/relay-host-harness.js';
import { untilReal as until } from './test-utils/journal-scripted-session.js';

/**
 * A terminal CLI runs a turn of a session the Controller published and released, and exits. The real `claude` binary runs against a
 * scripted model in a temporary home, as the Controller's own adapter does; nothing signs in. The Controller's next real directory
 * listing, read from that home, carries the native update time, attaches the session, and the Relay's journal shows the turn.
 */
afterEach(closeHosts);

/** The terminal: the same binary, the same home, one print-mode turn, and it exits. */
function terminal(fixture: Awaited<ReturnType<typeof nativeFixture>>, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(fixture.options.env)) { if (value === undefined) delete env[key]; else env[key] = value; }
  return new Promise((resolve, reject) => {
    const child = spawn(fixture.options.executable, ['-p', ...args], { cwd: fixture.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`The terminal turn ended with ${code}: ${output.slice(0, 400)}`)));
  });
}

it('does not refresh a Claude session the Controller still holds when a raw terminal runs a turn: Claude sessions are never idle-released, so the journal stays as it was', async () => {
  const fixture = await nativeFixture((body, response) => nativeReply(response, [{ type: 'text', text: JSON.stringify(body.messages).includes('SECOND_PROMPT') ? 'TERMINAL_SECOND_REPLY' : 'TERMINAL_FIRST_REPLY' }]));
  try {
    const provider = new ClaudeAgentProvider({ ...fixture.options, catalog: createClaudeCatalog(fixture.options.env, 15000) });
    const directory = createClaudeSessionDirectory(provider, [], undefined, undefined, new SessionCreationStore(join(fixture.home, 'creations'), 'claude'));
    const relay = await startRelayHost({ registrations: [{ adapter: provider, directory }], idleGraceMs: 100 });
    const id = randomUUID();
    expect(await terminal(fixture, ['--session-id', id, 'First prompt'])).toContain('TERMINAL_FIRST_REPLY');
    await relay.attach('claude', id);
    const texts = async () => (await relay.journal('claude', id))?.state().items.flatMap(entry => (entry.body?.item as { text?: string } | undefined)?.text ?? []) ?? [];
    await until(async () => (await texts()).includes('TERMINAL_FIRST_REPLY'), 'the first turn in the journal', 30000);
    // The idle release that the refresh relies on does not exist for Claude: the directory offers no `canReleaseSession`.
    await new Promise<void>(resolve => { setTimeout(resolve, 1500); });
    expect(relay.released()).toBe(0);

    expect(await terminal(fixture, ['--resume', id, 'SECOND_PROMPT'])).toContain('TERMINAL_SECOND_REPLY');
    await relay.listing('claude');
    await new Promise<void>(resolve => { setTimeout(resolve, 3000); });
    expect(await texts()).not.toContain('TERMINAL_SECOND_REPLY');
    expect(relay.released()).toBe(0);
    expect(relay.windows()).toEqual(['new']);
  } finally { await fixture.close(); }
}, 180000);
