import { describe, expect, it } from 'vitest';
import type { SessionSuccessionCurrent, SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { classifyFailure, committedRefreshOf, HttpWebSocketTransport, initialRefreshState, latestReplayByRole, reduceRefresh, resolveLocator,
  sessionSuccessionHistory, type RefreshState, type RoleEvidence } from '@orchardworks/agent-client';
import { buildSuccessionChain, buildSuccessionCurrent } from '@orchardworks/agent-client/testing';

/**
 * S3, the client end of succession. The real transport reads what the Relay serves over HTTP (an in-memory `fetch`): pages of committed replays, the role's current
 * locator, one operation. The succession model decides from what the transport returns. Nothing here opens a socket.
 */
const chain = buildSuccessionChain(['A', 'B', 'C']);
const current = buildSuccessionCurrent(chain);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A Relay that serves `pages` for the replay list, `currentRole` for lookups, and `failure` instead when set. */
function relay(options: { pages?: SessionSuccessionReplay[][]; currentRole?: SessionSuccessionCurrent; failure?: () => Promise<Response>; replays?: SessionSuccessionReplay[] } = {}) {
  const pages = options.pages ?? [chain];
  const requests: string[] = [];
  const fetchImplementation = (async (url: string | URL | Request) => {
    const address = new URL(String(url));
    requests.push(`${address.pathname}${address.search}`);
    if (options.failure) return options.failure();
    if (address.pathname.endsWith('/current')) return json(options.currentRole ?? current);
    if (address.pathname.endsWith('/operation')) {
      const found = (options.replays ?? chain).find(replay => replay.projection.receipt.operationId === address.searchParams.get('operationId'));
      return found ? json(found) : json({ error: 'missing' }, 404);
    }
    const at = Number(address.searchParams.get('cursor') ?? 0);
    return json({ version: 1, successions: pages[at], nextCursor: at + 1 < pages.length ? String(at + 1) : null });
  }) as typeof fetch;
  const transport = new HttpWebSocketTransport('https://relay.example/u/a/', { fetch: fetchImplementation });
  return { transport, requests };
}
async function readAll(transport: HttpWebSocketTransport) {
  const replays: SessionSuccessionReplay[] = [];
  let cursor: string | undefined;
  do {
    const page = await transport.fetchSessionSuccessions({ limit: 64, ...(cursor ? { cursor } : {}) });
    replays.push(...page.successions); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return replays;
}
const at = (nativeSessionId: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId, title: nativeSessionId });
const failureOf = async (run: () => Promise<unknown>, online: boolean | undefined = true) => {
  try { await run(); } catch (error) { return classifyFailure(error, online); }
  throw new Error('The request did not fail.');
};
const failed = (failure: ReturnType<typeof classifyFailure>, state: RefreshState) => reduceRefresh(state, { type: 'discovery_failed', failure, notified: false, replayRead: false,
  hasConfirmedEvidence: true, hasDesired: true, hasRoles: true, invalidView: false });

describe('succession over the session wire', () => {
  it('reads every page of replays and applies the newest of each role', async () => {
    const second = buildSuccessionChain(['X', 'Y'], { roleId: 'second' });
    const { transport, requests } = relay({ pages: [chain.slice(0, 1), [...chain.slice(1), ...second]] });
    const replays = await readAll(transport);
    expect(requests).toHaveLength(2);
    expect([...latestReplayByRole('scope', replays).values()].map(replay => replay.to.nativeSessionId)).toEqual(['C', 'Y']);
  });
  it('accepts a history chain once the Relay confirms the role it ends in', async () => {
    const { transport } = relay();
    const replays = await readAll(transport);
    const role = await transport.fetchSessionSuccessionCurrent('primary');
    const navigation = sessionSuccessionHistory({ scope: 'scope', replays, current: role, selected: at('C') });
    expect(navigation?.ancestors.map(entry => entry.nativeSessionId)).toEqual(['A']);
    expect(navigation?.predecessor?.nativeSessionId).toBe('B');
  });
  it('offers no history when a page of the chain is missing', async () => {
    const { transport } = relay({ pages: [chain.slice(1)] });
    const replays = await readAll(transport);
    expect(sessionSuccessionHistory({ scope: 'scope', replays, current: await transport.fetchSessionSuccessionCurrent('primary'), selected: at('C') })).toBeUndefined();
  });
  it('resolves a predecessor to the current session using the evidence read from the Relay', async () => {
    const { transport } = relay();
    const evidence: RoleEvidence = { replays: await readAll(transport), current: await transport.fetchSessionSuccessionCurrent('primary') };
    expect(resolveLocator({ ready: true, evidenceStale: false, selection: at('A'), viewIsHistory: false, nativePrefixOnly: false, evidence: [evidence], replays: evidence.replays }))
      .toMatchObject({ status: 'resolved', target: { nativeSessionId: 'C' } });
  });
  it('confirms a committed operation looked up by id, and not one the Relay does not know', async () => {
    const { transport } = relay();
    const replay = await transport.fetchSessionSuccessionOperation('primary', chain[0]!.projection.receipt.operationId);
    expect(replay.to.nativeSessionId).toBe('B');
    const evidence = new Map([['k', { replays: chain, current }]]);
    const roles = [{ key: 'k', appliedRevision: 3, committedRevision: 3 }];
    expect(committedRefreshOf({ operationId: replay.projection.receipt.operationId, evidence, roles }).status).toBe('confirmed');
    await expect(transport.fetchSessionSuccessionOperation('primary', 'unknown')).rejects.toMatchObject({ code: 'http_404' });
  });
});

describe('succession refresh over a failing Relay', () => {
  const confirmed = reduceRefresh(initialRefreshState, { type: 'discovery_succeeded' }).state;
  it('keeps the confirmed evidence, marked stale, when the Relay cannot be reached', async () => {
    const { transport } = relay({ failure: async () => { throw new TypeError('fetch failed'); } });
    const failure = await failureOf(() => transport.fetchSessionSuccessions({ limit: 64 }));
    expect(failure.kind).toBe('unreachable');
    const result = failed(failure, confirmed);
    expect(result.state.evidenceStale).toBe(true);
    expect(result.effects).toContainEqual({ type: 'schedule_stale_retry', delayMs: 1000 });
  });
  it('treats an offline browser as unreachable whatever the transport says', async () => {
    const { transport } = relay({ failure: async () => json({ error: 'busy' }, 503) });
    expect((await failureOf(() => transport.fetchSessionSuccessions({ limit: 64 }), false)).kind).toBe('unreachable');
  });
  it('does not fall back to old locators when the Relay answers with an error or times out', async () => {
    const answered = relay({ failure: async () => json({ error: 'busy' }, 503) });
    const failure = await failureOf(() => answered.transport.fetchSessionSuccessions({ limit: 64 }));
    expect(failure.kind).toBe('other');
    expect(failed(failure, confirmed).state.evidenceStale).toBe(false);
    const slow = relay({ failure: () => new Promise<Response>(() => {}) });
    const timeout = await failureOf(() => slow.transport.fetchSessionSuccessions({ limit: 64 }, { signal: AbortSignal.timeout(5) }));
    expect(timeout.kind).toBe('timeout');
    expect(failed(timeout, confirmed).state.evidenceStale).toBe(false);
  });
  it('reads a missing succession route as a Relay without succession, and a hidden one as an error', async () => {
    const missing = relay({ failure: async () => json({ error: 'missing' }, 404) });
    const failure = await failureOf(() => missing.transport.fetchSessionSuccessions({ limit: 64 }));
    expect(failure.code).toBe('http_404');
    expect(reduceRefresh(initialRefreshState, { type: 'discovery_failed', failure, notified: false, replayRead: false, hasConfirmedEvidence: false, hasDesired: false, hasRoles: false, invalidView: false }).state.unsupported).toBe(true);
  });
  it('rejects a forged page instead of reading evidence from it', async () => {
    const forged = relay({ failure: async () => json({ version: 1, successions: chain, nextCursor: null, forged: true }) });
    await expect(forged.transport.fetchSessionSuccessions({ limit: 64 })).rejects.toThrow('invalid');
  });
});
