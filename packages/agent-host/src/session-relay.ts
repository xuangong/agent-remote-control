import { isSuccessionActionResult, isSuccessionDescription, type SuccessionActionResult } from '@orchardworks/agent-remote-protocol';
import type { CommandChannel } from './cli-client.js';
import { CliError } from './cli-output.js';
import { relayError, relayRequest, type CliCredentials } from './relay-client.js';

/** A session as the Relay names it: by its Host's ID, whatever address the command line was given. */
export interface NamedSession { address: string; hostId: string; providerId: string; nativeSessionId: string; title?: string; cwd?: string }

/** Resolves self, local and full addresses through the Controller or Relay that answers session commands. */
export async function namedSession(channel: CommandChannel, address: string): Promise<NamedSession> {
  const answer = await channel.call('session', { command: 'read', target: address, limit: 0 });
  if ('error' in answer) throw new CliError(answer.error.code, answer.error.message);
  const session = answer.result.session as { address?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const [hostId, providerId, ...rest] = typeof session?.address === 'string' ? session.address.split('/') : [];
  if (!hostId || hostId === 'local' || !providerId || !rest.length) throw new CliError('host_unregistered', 'The session\'s Host is not registered with the Relay yet.');
  return { address: session!.address as string, hostId, providerId, nativeSessionId: rest.join('/'),
    ...(typeof session!.title === 'string' ? { title: session!.title } : {}), ...(typeof session!.cwd === 'string' ? { cwd: session!.cwd } : {}) };
}

function signedIn(credentials: CliCredentials | undefined): CliCredentials {
  if (!credentials) throw new CliError('signed_out', 'Stars and handoffs are kept by the Relay: run agent-remote-controller login first.');
  return credentials;
}
async function relay(credentials: CliCredentials, method: 'POST' | 'DELETE', path: string, body: unknown, fetcher: typeof fetch) {
  const { status, data } = await relayRequest(credentials, method, path, body, fetcher);
  if (status !== 200) throw relayError(status, data);
  return data;
}

/** Stars or unstars a session among the signed-in user's favorites. */
export async function starSession(session: NamedSession, starred: boolean, credentials: CliCredentials | undefined, fetcher: typeof fetch = fetch): Promise<{ starred: boolean }> {
  const identity = { hostId: session.hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId };
  await relay(signedIn(credentials), starred ? 'POST' : 'DELETE', '/v1/stars', starred
    ? { ...identity, title: session.title || session.nativeSessionId, ...(session.cwd ? { workspace: session.cwd } : {}) } : identity, fetcher);
  return { starred };
}

const SETTLED = ['committed', 'cancelled', 'rejected'];
const DELAYS = [1000, 2000, 4000, 8000, 15000];

/**
 * Hands a session's work over to a new native session, as the website's Handoff does: prepare, wait until it is ready,
 * then commit. Repeating it with the same operation continues that handoff instead of starting another.
 */
export async function handoffSession(session: NamedSession, options: { operationId: string; targetProviderId?: string }, credentials: CliCredentials | undefined,
  fetcher: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<Record<string, unknown>> {
  const signed = signedIn(credentials);
  const path = (action: string) => `/v1/remote/hosts/${encodeURIComponent(session.hostId)}/succession/${action}`;
  const act = async (action: string, body: Record<string, unknown>): Promise<SuccessionActionResult> => {
    const value = await relay(signed, 'POST', path(action), body, fetcher);
    if (!isSuccessionActionResult(value)) throw new CliError('invalid_response', 'The Relay returned an invalid handoff result.');
    return value;
  };
  const { operationId } = options;
  let result = await act('status', { operationId }).catch(error => {
    if (error instanceof CliError && error.code === 'succession_not_found') return undefined;
    throw error;
  });
  if (!result) {
    const description = await relay(signed, 'POST', path('describe'), { providerId: session.providerId, nativeSessionId: session.nativeSessionId }, fetcher);
    if (!isSuccessionDescription(description)) throw new CliError('invalid_response', 'The Relay returned an invalid handoff description.');
    if (description.eligibility.status !== 'ready') throw new CliError(description.eligibility.code, description.eligibility.reason);
    const target = options.targetProviderId ?? description.role.current.providerId;
    if (!description.targets.some(item => item.providerId === target)) throw new CliError('invalid_request', `The session cannot be handed to ${target}; it can go to ${description.targets.map(item => item.providerId).join(', ') || 'no provider'}.`);
    result = await act('prepare', { operationId, providerId: description.role.current.providerId, nativeSessionId: description.role.current.nativeSessionId,
      expectedRevision: description.role.revision, targetProviderId: target });
  }
  for (let attempt = 0; !SETTLED.includes(result.record.phase) && attempt <= DELAYS.length; attempt++) {
    if (result.record.phase === 'ready') { result = await act('commit', { operationId }); continue; }
    if (result.record.phase === 'unknown') break;
    await sleep(DELAYS[Math.min(attempt, DELAYS.length - 1)]!);
    result = await act('status', { operationId });
  }
  const { record, locator } = result;
  if (record.phase === 'rejected' || record.phase === 'cancelled') throw new CliError(record.failureCode ?? `handoff_${record.phase}`, `The handoff was ${record.phase}.`, { operationId });
  if (record.phase !== 'committed') throw new CliError('outcome_unknown', 'The handoff has not settled. Run the same command with --operation-id to check and continue it.', { operationId, phase: record.phase });
  return { operationId, phase: record.phase, ...(locator ? { session: { address: `${locator.hostId}/${locator.providerId}/${locator.nativeSessionId}` } } : {}), from: { address: session.address } };
}
