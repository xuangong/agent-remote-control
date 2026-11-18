import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Where the Relay gets the identifiers and secrets it mints: request and connection ids, Host and session ids, heartbeat nonces,
 * credentials and tunnel tokens, and the epochs of journals. The Relay never draws one itself, so a test supplies a sequence and
 * a recorded run gives the same ids every time. The default draws from the system's secure source.
 */
export interface RelayIds {
  /** A new unique id (a v4 UUID). */
  uuid(): string;
  /** A new secret with 256 bits of randomness, url-safe. */
  token(): string;
}

export const systemIds: RelayIds = {
  uuid: () => randomUUID(),
  token: () => randomBytes(32).toString('base64url'),
};

/** Predictable ids for tests: `uuid-1`, `uuid-2`, ... and `token-1`, ... Not unique across runs, so never a default. */
export function sequentialRelayIds(prefix = ''): RelayIds {
  let uuids = 0, tokens = 0;
  return { uuid: () => `${prefix}00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`, token: () => `${prefix}token-${++tokens}` };
}
