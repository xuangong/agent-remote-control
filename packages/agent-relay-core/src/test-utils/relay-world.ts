/**
 * The two outside parties a hosted Relay talks to, as injected ports for rule tests, and a harness that wires them in over
 * a controllable clock:
 *
 * - the account authority (sign-in, introspection and grant renewal), answering as a function from a request to a response;
 * - the release host that publishes Controller releases and their upgrade bridges.
 *
 * Time is Vitest's fake clock, so a lease, a grace period or a refresh deadline passes with `advance`, not with waiting.
 * Nothing listens on a port.
 */
import { createHash, createHmac } from 'node:crypto';
import type { RelayDiagnostic, RelayDiagnosticStore } from '@orchardworks/agent-remote-protocol/model';
import { afterEach, vi } from 'vitest';

import { createHostedRelay } from '../gateway.js';
import { createControllerReleases } from '../controller-releases.js';
import { createTimerRelayScheduler, type RelayScheduler } from '../scheduler.js';
import { issuer, origin, secret, startRelayHarness, type RelayHarness } from './relay-harness.js';

const signed = (type: string, claims: Record<string, unknown>) => {
  const input = [{ alg: 'HS256', typ: type }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
};

/** The account authority. It checks the Relay's signed proof, then answers with the state a test set: a lease, an outage or a denial. */
export function createAccountAuthority() {
  let status = 200, leaseMs = 120_000, authenticatedAt = Date.now(), ownerFailures = 0, renewalDelayMs = 0, activeRenewals = 0;
  const state = { calls: 0, peakRenewals: 0, operations: [] as string[] };
  const fetcher = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.href.startsWith(issuer + '/api/agent-remote/')) return new Response('Unexpected request', { status: 400 });
    state.calls++;
    const operation = url.pathname.split('/').at(-1)!;
    state.operations.push(operation);
    if (operation === 'renew' && renewalDelayMs > 0) {
      state.peakRenewals = Math.max(state.peakRenewals, ++activeRenewals);
      await new Promise(resolve => setTimeout(resolve, renewalDelayMs));
      activeRenewals--;
    }
    const body = String(init?.body ?? '');
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').slice(7);
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? 'e30', 'base64url').toString());
    const valid = signed('arc-relay-service+jwt', claims) === token && claims.iss === origin && claims.aud === issuer
      && claims.bodyHash === createHash('sha256').update(body).digest('base64url');
    if (!valid) return new Response('Invalid proof', { status: 401 });
    if (operation === 'user-status' && ownerFailures > 0) { ownerFailures--; return new Response('Temporary authority failure', { status: 503 }); }
    if (status !== 200) return new Response('Unavailable', { status });
    const value = JSON.parse(body);
    return Response.json({ active: true, subject: value.subject ?? value.continuation, authenticatedAt, expiresAt: Date.now() + 3_600_000, validUntil: Date.now() + leaseMs });
  };
  return {
    fetch: fetcher,
    /** From now on every answer has this HTTP status; 200 confirms access for `leaseMs`. */
    answer(httpStatus: number, lease = 120_000) { status = httpStatus; leaseMs = lease; },
    failOwnerChecks(count: number) { ownerFailures = count; },
    /** Every renewal takes this long to answer, and the peak of renewals in flight is counted from now. */
    delayRenewals(ms: number) { renewalDelayMs = ms; state.peakRenewals = 0; state.operations.length = 0; },
    setAuthenticatedAt(value: number) { authenticatedAt = value; },
    get calls() { return state.calls; },
    get peakRenewals() { return state.peakRenewals; },
    get operations() { return [...state.operations]; },
  };
}
export type AccountAuthority = ReturnType<typeof createAccountAuthority>;

type ReleaseManifest = Record<string, unknown> & { version: string; asset: string };

/** The release host: the GitHub release catalog and downloads of Controller releases. A manifest object is read live, so a test changes it in place to publish a new release. */
export function createReleaseHost(releases: { release?: ReleaseManifest; bridge?: ReleaseManifest; bridges?: ReleaseManifest[] }) {
  const fetcher = async (input: unknown): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!['api.github.com', 'github.com'].includes(url.hostname)) return new Response('Unexpected request', { status: 400 });
    const candidates = [releases.release, ...(releases.bridge ? [releases.bridge] : []), ...(releases.bridges ?? [])].filter((value): value is ReleaseManifest => !!value);
    const entry = (manifest: ReleaseManifest) => ({ tag_name: `controller-v${manifest.version}`, draft: false, prerelease: false, published_at: '2026-09-22', assets: [{ name: 'controller-release.json' }, { name: manifest.asset }] });
    const requested = /controller-v([^/]+)/.exec(url.pathname)?.[1];
    if (!requested) return Response.json(candidates.map(entry));
    const manifest = candidates.find(item => item.version === requested);
    if (!manifest) return new Response('Not found', { status: 404 });
    return Response.json(url.pathname.endsWith('controller-release.json') ? manifest : entry(manifest));
  };
  return { controllerReleases: createControllerReleases(fetcher as typeof fetch) };
}

/** The Relay's diagnostic records outlive a restart of the Relay, as they do in storage. */
function memoryDiagnosticStore(): RelayDiagnosticStore {
  let saved: RelayDiagnostic[] = [];
  return { get initial() { return saved; }, async save(entries) { saved = entries; } };
}

/** Wraps the timer scheduler so a test can also run the pending refresh at once, as a Durable Object alarm would. */
function observableScheduler() {
  const timers = createTimerRelayScheduler();
  let pending: (() => Promise<void>) | undefined;
  const scheduler: RelayScheduler = { schedule(deadline, refresh) { pending = refresh; return timers.schedule(deadline, refresh); }, cancel() { pending = undefined; return timers.cancel(); } };
  return { scheduler, runPending: async () => { await pending?.(); } };
}

type WorldOptions = { authority?: AccountAuthority; releases?: Parameters<typeof createReleaseHost>[0]; authorityOutageGraceMs?: number; hostLiveness?: Parameters<typeof createHostedRelay>[0]['hostLiveness']; diagnosticContext?: Parameters<typeof createHostedRelay>[0]['diagnosticContext'] };

/**
 * A hosted Relay over a fake clock with a controllable authority and release host. `signIn` is `login` plus the browser cookie;
 * `advance` moves the clock and runs what falls due; `refreshNow` runs the pending refresh as an alarm does.
 */
export async function startRelayWorld(options: WorldOptions = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const authority = options.authority ?? createAccountAuthority();
  const { scheduler, runPending } = observableScheduler();
  const harness = await startRelayHarness({ configure: {
    scheduler, ...(options.releases ? createReleaseHost(options.releases) : {}),
    ...(options.authorityOutageGraceMs === undefined ? {} : { authorityOutageGraceMs: options.authorityOutageGraceMs }),
    ...(options.hostLiveness ? { hostLiveness: options.hostLiveness } : {}),
    ...(options.diagnosticContext ? { diagnosticContext: options.diagnosticContext } : {}),
    diagnosticStorage: memoryDiagnosticStore(),
  } });
  vi.stubGlobal('fetch', authority.fetch);
  async function signIn(subject: string, browserCookie = '') {
    const begin = await harness.request('/auth/login');
    const loginCookie = begin.headers.get('set-cookie')!.split(';')[0]!;
    const nonce = new URL(begin.headers.get('location')!).searchParams.get('challenge');
    const iat = Math.floor(Date.now() / 1000);
    const ticket = signed('arc-relay+jwt', { iss: issuer, aud: origin, sub: subject, nonce, iat, exp: iat + 900, jti: crypto.randomUUID(), continuation: subject, sessionExpiresAt: Date.now() + 3_600_000 });
    const response = await harness.json('/auth/session', [loginCookie, browserCookie].filter(Boolean).join('; '), { ticket });
    if (response.status !== 200) throw new Error(`Sign-in of ${subject} answered ${response.status}.`);
    const cookies = response.headers.getSetCookie();
    return { cookie: cookies.find(value => value.startsWith('__Host-arc_session='))!.split(';')[0]!,
      browserCookie: cookies.find(value => value.startsWith('__Host-arc_browser='))?.split(';')[0], ...await response.json() as { basePath: string } };
  }
  /** The refusal the Relay gives an upgrade it will not accept, as the response a browser or Controller would see. */
  async function refusedUpgrade(path: string, headers: Record<string, string>): Promise<Response> {
    try { await harness.upgrade(path, headers); } catch (error) { if ((error as Error).cause instanceof Response) return (error as Error).cause as Response; throw error; }
    throw new Error(`The upgrade of ${path} was accepted.`);
  }
  return Object.assign(harness, {
    authority, signIn, refusedUpgrade,
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    refreshNow: runPending,
  });
}
export type RelayWorld = Awaited<ReturnType<typeof startRelayWorld>>;
const started: RelayHarness[] = [];
afterEach(async () => { for (const world of started.splice(0).reverse()) await world.close(); vi.useRealTimers(); });
/** A started world that closes after the test, with the real clock restored. */
export async function world(options: WorldOptions = {}) { const value = await startRelayWorld(options); started.push(value); return value; }
