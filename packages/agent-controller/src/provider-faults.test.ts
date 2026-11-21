import { codexBehaviour } from '@orchardworks/agent-provider-codex';
import { afterEach, describe, expect, it } from 'vitest';
import { simulatedCli } from './test-utils/simulated-cli.js';
import { closeHosts, startRelayHost } from './test-utils/relay-host-harness.js';
import { untilReal as until } from './test-utils/journal-scripted-session.js';

/**
 * The Controller beside a provider CLI that misbehaves as real CLIs do, played by the CLI simulator (`simulated-cli.ts`) from what the Codex
 * adapter declares about its shared daemon: a page's open of the session is answered through the hosted Relay as the page sees it. The
 * Relay's deadline for a Controller request is short here, so a hang ends fast.
 */
afterEach(async () => { await closeHosts(); });

const DEADLINE_MS = 250;
async function start(turnMs = 100) {
  const cli = simulatedCli({ behaviour: codexBehaviour('shared'), sessions: { 'thread-1': ['Hello', 'World'] }, turnMs });
  const relay = await startRelayHost({ registrations: [cli.registration()], rpcTimeoutMs: DEADLINE_MS, idleGraceMs: 60 });
  // An opened session is published and let go after its idle grace, as a page's open of an idle session is.
  const settled = () => until(() => relay.released() >= 1, 'the idle release');
  return { cli, relay: { ...relay, settled }, open: () => relay.tryAttach('simulated', 'thread-1') };
}

describe('a provider CLI that refuses or stalls a resume', () => {
  it("surfaces Codex's single writer as the session being in use, in fixed business words, and opens once the writer leaves", async () => {
    const { cli, relay, open } = await start();
    const separate = cli.externalWriter('thread-1', { text: 'From another process', separate: true });
    expect(await open()).toMatchObject({ status: 409, body: { code: 'session_in_use', error: 'This session is in use by another native client. Close that client, then reopen the session.' } });
    expect(await separate).toBe('written');
    expect((await open()).status).toBe(200);
    await relay.settled();
  });
  it('waits for a slow resume within the deadline', async () => {
    const { cli, relay, open } = await start();
    cli.faults.slowResume(50);
    expect((await open()).status).toBe(200);
    await relay.settled();
  });
  it("answers a resume that hangs at the Relay's deadline, with a refusal the page may retry", async () => {
    const { cli, open } = await start();
    cli.faults.hangResume();
    const refused = await open();
    expect(refused.status).toBeGreaterThanOrEqual(500);
    // The hung resume holds the Controller's binding until it answers: nothing on the Controller's side gives it up (requirements review,
    // gap 4; `resume-deadline.test.ts` pins it as an expected failure).
    cli.faults.heal();
  });
  it('names a usage limit in fixed words, but not when it resets: nothing passes resetsAt on (requirements review, gap 3)', async () => {
    const { cli, open } = await start();
    cli.faults.usageLimit({ resetsAt: Date.now() + 60_000 });
    const refused = await open();
    expect(refused.body).toEqual({ code: 'native_usage_limited', error: 'The native CLI reached its usage limit. Reopen the session once the limit resets.', requestId: expect.any(String) });
  });
});

describe('a provider CLI that sends an item kind this adapter does not know', () => {
  it('keeps the rows it knows and the stream going', async () => {
    const { cli, relay, open } = await start();
    cli.faults.unknownEvent('hologram');
    expect((await open()).status).toBe(200);
    await until(async () => ((await relay.journal('simulated', 'thread-1'))?.state().items.length ?? 0) >= 2, 'the known rows');
    expect((await relay.journal('simulated', 'thread-1'))!.state().items.map(entry => entry.itemKey)).toEqual(['thread-1:0', 'thread-1:1']);
    await relay.settled();
  });
});
