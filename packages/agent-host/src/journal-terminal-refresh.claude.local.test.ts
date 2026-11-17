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

it('releases a Claude session a raw terminal turn moved on, reads it again at the next listing, and the journal shows the turn without a send', async () => {
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
    // Nothing diverged: the session stays held.
    await relay.listing('claude');
    await new Promise<void>(resolve => { setTimeout(resolve, 1500); });
    expect(relay.released()).toBe(0);

    expect(await terminal(fixture, ['--resume', id, 'SECOND_PROMPT'])).toContain('TERMINAL_SECOND_REPLY');
    // The terminal is left alone until it has been quiet for a while.
    await new Promise<void>(resolve => { setTimeout(resolve, 32_000); });
    await relay.listing('claude');
    await until(() => relay.released() === 1, 'the session released because the transcript moved on', 30000);
    // Closing the runtime touches the transcript, so the reread waits for another quiet period.
    await until(async () => { await relay.listing('claude'); return (await texts()).includes('TERMINAL_SECOND_REPLY'); }, 'the terminal turn in the journal', 90000);
    expect(await texts()).toEqual(expect.arrayContaining(['First prompt', 'TERMINAL_FIRST_REPLY', 'SECOND_PROMPT', 'TERMINAL_SECOND_REPLY']));
  } finally { await fixture.close(); }
}, 240000);
