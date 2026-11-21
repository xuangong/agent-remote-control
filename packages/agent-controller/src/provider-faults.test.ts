import { afterEach, describe, expect, it } from 'vitest';
import { faultyProvider } from './test-utils/faulty-provider.js';
import { closeHosts, startRelayHost } from './test-utils/relay-host-harness.js';
import { untilReal as until } from './test-utils/journal-scripted-session.js';

/**
 * The Controller beside a provider CLI that misbehaves as real CLIs do (`faulty-provider.ts`): a page's open of the session is answered
 * through the hosted Relay as the page sees it. The Relay's deadline for a Controller request is short here, so a hang ends fast.
 */
afterEach(async () => { await closeHosts(); });

const DEADLINE_MS = 250;
async function start(fault: Parameters<typeof faultyProvider>[0]) {
  const provider = faultyProvider(fault);
  const relay = await startRelayHost({ registrations: [provider.registration], rpcTimeoutMs: DEADLINE_MS, idleGraceMs: 60 });
  // An opened session is published and let go after its idle grace, as a page's open of an idle session is.
  const settled = () => until(() => relay.released() >= 1, 'the idle release');
  return { provider, relay: { ...relay, settled }, open: () => relay.tryAttach('faulty', 'thread-1') };
}

describe('a provider CLI that refuses or stalls a resume', () => {
  it("surfaces Codex's single writer as the session being in use, in fixed business words, and opens once the writer leaves", async () => {
    const { provider, relay, open } = await start({ kind: 'writer-busy' });
    expect(await open()).toMatchObject({ status: 409, body: { code: 'session_in_use', error: 'This session is in use by another native client. Close that client, then reopen the session.' } });
    provider.heal();
    expect((await open()).status).toBe(200);
    await relay.settled();
  });
  it('waits for a slow resume within the deadline', async () => {
    const { relay, open } = await start({ kind: 'slow', resumeMs: 50 });
    expect((await open()).status).toBe(200);
    await relay.settled();
  });
  it("answers a resume that hangs at the Relay's deadline, with a refusal the page may retry", async () => {
    const { provider, open } = await start({ kind: 'hang' });
    const refused = await open();
    expect(refused.status).toBeGreaterThanOrEqual(500);
    // The hung resume holds the Controller's binding until it answers: nothing on the Controller's side gives it up (gap, section 10).
    provider.heal();
  });
  it('says nothing of the time to wait after a usage limit: the SDK has no error for it (gap, section 10)', async () => {
    const { open } = await start({ kind: 'rate-limited', retryAfterMs: 60_000 });
    const refused = await open();
    expect(refused.body.code).toBe('session_attach_failed');
    expect(refused.body.error).not.toMatch(/60 s|try again/i);
  });
});

describe('a provider CLI that sends an item kind this adapter does not know', () => {
  it('keeps the rows it knows and the stream going', async () => {
    const { relay, open } = await start({ kind: 'unknown-event' });
    expect((await open()).status).toBe(200);
    await until(async () => ((await relay.journal('faulty', 'thread-1'))?.state().items.length ?? 0) >= 2, 'the known rows');
    expect((await relay.journal('faulty', 'thread-1'))!.state().items.map(entry => entry.itemKey)).toEqual(['m1', 'm2']);
    await relay.settled();
  });
});
