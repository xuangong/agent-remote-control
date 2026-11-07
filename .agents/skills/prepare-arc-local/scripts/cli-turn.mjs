// Runs one real model turn on this checkout's local instance through its Controller command line, without a browser.
// Usage, from the checkout root:
//   node .agents/skills/prepare-arc-local/scripts/cli-turn.mjs [claude|codex] [prompt]   new session
//   node .agents/skills/prepare-arc-local/scripts/cli-turn.mjs --session ADDRESS prompt  next turn of a session
// Without a prompt it asks for LOCAL-OK and checks the reply. It prints the session address and the reply.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_PROMPT = 'Reply with the words LOCAL and OK joined by a hyphen, and nothing else.';
const command = join(process.cwd(), 'scripts/local/command.mjs');
// The management socket answers these calls, so polling them never signs in.
const controller = (...args) => {
  try { return JSON.parse(execFileSync(process.execPath, [command, 'controller', ...args], { encoding: 'utf8', timeout: 180_000 })); }
  catch (error) {
    let code;
    try { code = JSON.parse(error.stdout).error?.code; } catch { code = undefined; }
    throw Object.assign(new Error(`controller ${args.slice(0, 2).join(' ')} failed: ${error.stdout || error.stderr || error.message}`), { code });
  }
};

const args = process.argv.slice(2);
let address;
let prompt;
if (args[0] === '--session') {
  [, address, prompt] = args;
  if (!address || !prompt) throw new Error('Give the session address and the prompt.');
  const before = controller('session', 'read', address, '--limit', '1').entries?.[0]?.id;
  controller('session', 'send', address, prompt);
  await waitForReply(before);
} else {
  const provider = args[0] ?? 'claude';
  prompt = args[1] ?? DEFAULT_PROMPT;
  address = controller('session', 'create', '--provider', provider, '--message', prompt).session.address;
  await waitForReply(undefined);
}

/** Waits up to two minutes for a new assistant entry once the session stops running; a session waiting for an answer stops too. */
async function waitForReply(previous) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    // A new session has no native history until its first turn is written.
    const read = await Promise.resolve().then(() => controller('session', 'read', address, '--limit', '1'))
      .catch(error => { if (error.code === 'history_unavailable' && Date.now() < deadline) return {}; throw error; });
    const [newest] = read.entries ?? [];
    const state = read.session?.state;
    if (state === 'waiting' || state === 'failed') {
      throw new Error(`The session ${address} is ${state === 'waiting' ? 'waiting for an answer (session inspect shows the request)' : 'failed'}.`);
    }
    if (newest && newest.id !== previous && newest.role === 'assistant' && state !== 'running') {
      console.log(JSON.stringify({ address, state, reply: newest.text }));
      if (prompt === DEFAULT_PROMPT && !newest.text.includes('LOCAL-OK')) throw new Error('The reply does not contain LOCAL-OK.');
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`No reply within two minutes in ${address} (state ${state}, newest entry ${newest?.role ?? 'none'}). Read pnpm local controller diagnostics --source controller --limit 60.`);
    }
    await delay(2000);
  }
}
