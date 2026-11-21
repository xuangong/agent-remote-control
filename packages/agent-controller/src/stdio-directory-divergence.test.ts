import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';

import { createManagedStdioDirectory, type ManagedStdioProvider } from './stdio-directory.js';
import { DIVERGENCE_QUIET_MS, DIVERGENCE_TOLERANCE_MS } from './transcript-divergence.js';

afterEach(() => vi.useRealTimers());

const WRITTEN_AT = 1_000_000;

/** A directory over a provider that keeps its conversation in memory; the listing and the native update time are the test's. */
function divergenceDirectory(state: { quiet: boolean; writtenAt: number } | null = { quiet: true, writtenAt: WRITTEN_AT }) {
  const input = { listedUpdatedAt: WRITTEN_AT, nativeUpdatedAt: undefined as number | undefined, state };
  const provider = {
    listSessions: async (): Promise<RemoteSessionSummary[]> => [{ nativeSessionId: 'session', providerId: 'claude', title: 'T', createdAt: new Date(0).toISOString(), updatedAt: new Date(input.listedUpdatedAt).toISOString(), state: 'idle' }],
    sessionState: () => input.state ?? undefined,
    sessionNativeUpdatedAt: async () => input.nativeUpdatedAt,
  } as unknown as ManagedStdioProvider;
  const directory = createManagedStdioDirectory('claude', 'Claude', provider, []);
  return { input, directory: directory as Required<Pick<typeof directory, 'divergedAt' | 'canReleaseSession' | 'checkDivergence'>> & typeof directory };
}

describe('transcript divergence of a managed stdio directory', () => {
  it('offers no divergence rule when the provider keeps no session state', () => {
    const directory = createManagedStdioDirectory('claude', 'Claude', { listSessions: async () => [] } as unknown as ManagedStdioProvider, []);
    expect(directory.divergedAt).toBeUndefined();
    expect(directory.canReleaseSession).toBeUndefined();
    expect(directory.checkDivergence).toBeUndefined();
  });

  it.each([
    [DIVERGENCE_TOLERANCE_MS, undefined],
    [DIVERGENCE_TOLERANCE_MS + 1, WRITTEN_AT],
  ])('reports the write time as diverged for a listing %i ms after the last write: %s', async (after, expected) => {
    const { input, directory } = divergenceDirectory();
    input.listedUpdatedAt = WRITTEN_AT + after;
    await directory.list();
    expect(directory.divergedAt('session')).toBe(expected);
  });

  it('reports nothing for a session the provider holds no state for', async () => {
    const { input, directory } = divergenceDirectory(null);
    input.listedUpdatedAt = WRITTEN_AT + 60_000;
    await directory.list();
    expect(directory.divergedAt('session')).toBeUndefined();
    expect(directory.canReleaseSession('session')).toBe(false);
  });

  it('releases a diverged session only after 30 s of quiet in its transcript', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { input, directory } = divergenceDirectory();
    const updatedAt = WRITTEN_AT + DIVERGENCE_TOLERANCE_MS + 1;
    input.listedUpdatedAt = updatedAt;
    await directory.list();
    vi.setSystemTime(updatedAt + DIVERGENCE_QUIET_MS - 1);
    expect(directory.canReleaseSession('session')).toBe(false);
    vi.setSystemTime(updatedAt + DIVERGENCE_QUIET_MS);
    expect(directory.canReleaseSession('session')).toBe(true);
  });

  it('does not release a diverged session while something runs for it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { input, directory } = divergenceDirectory({ quiet: false, writtenAt: WRITTEN_AT });
    input.listedUpdatedAt = WRITTEN_AT + 5000;
    await directory.list();
    vi.setSystemTime(WRITTEN_AT + 5000 + 10 * DIVERGENCE_QUIET_MS);
    expect(directory.canReleaseSession('session')).toBe(false);
  });

  it.each([
    [DIVERGENCE_TOLERANCE_MS, true, false],
    [DIVERGENCE_TOLERANCE_MS + 1, true, true],
    [DIVERGENCE_TOLERANCE_MS + 1, false, false],
  ])('checks divergence of a native update %i ms after the last write while quiet is %s: %s', async (after, quiet, expected) => {
    const { input, directory } = divergenceDirectory({ quiet, writtenAt: WRITTEN_AT });
    input.nativeUpdatedAt = WRITTEN_AT + after;
    expect(await directory.checkDivergence('session')).toBe(expected);
  });

  it('is not diverged when the provider knows no native update time', async () => {
    const { directory } = divergenceDirectory();
    expect(await directory.checkDivergence('session')).toBe(false);
  });

  it('keeps the native update time a check read, for the release rule that follows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { input, directory } = divergenceDirectory();
    const updatedAt = WRITTEN_AT + 10_000;
    input.nativeUpdatedAt = updatedAt;
    await directory.checkDivergence('session');
    expect(directory.divergedAt('session')).toBe(WRITTEN_AT);
    vi.setSystemTime(updatedAt + DIVERGENCE_QUIET_MS);
    expect(directory.canReleaseSession('session')).toBe(true);
  });
});
