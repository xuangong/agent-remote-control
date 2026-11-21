import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { claudeBehaviour } from '@orchardworks/agent-provider-claude';
import type { RemoteSessionSummary } from '@orchardworks/agent-session-runtime';

import { createManagedStdioDirectory, type ManagedStdioProvider } from './stdio-directory.js';
import { DIVERGENCE_QUIET_MS } from './transcript-divergence.js';

afterEach(() => vi.useRealTimers());

const WRITTEN_AT = 1_000_000;
const HELD = ['base', 'page'];

/** A directory over a provider that keeps its conversation in memory; the transcript, its update time and the listing are the test's. */
function divergenceDirectory(state: { quiet: boolean; writtenAt: number; records: readonly string[] } | null = { quiet: true, writtenAt: WRITTEN_AT, records: HELD },
  behaviour: AgentProviderBehaviour = claudeBehaviour) {
  const input = { listedUpdatedAt: WRITTEN_AT, nativeUpdatedAt: WRITTEN_AT as number | undefined, transcript: HELD as readonly string[] | undefined, state, reads: 0 };
  const provider = {
    descriptor: { behaviour },
    listSessions: async (): Promise<RemoteSessionSummary[]> => [{ nativeSessionId: 'session', providerId: 'claude', title: 'T', createdAt: new Date(0).toISOString(), updatedAt: new Date(input.listedUpdatedAt).toISOString(), state: 'idle' }],
    sessionState: () => input.state ?? undefined,
    sessionNativeUpdatedAt: async () => input.nativeUpdatedAt,
    sessionTranscript: async () => { input.reads += 1; return input.transcript; },
  } as unknown as ManagedStdioProvider;
  const directory = createManagedStdioDirectory('claude', 'Claude', provider, []);
  return { input, directory: directory as Required<Pick<typeof directory, 'divergedAt' | 'canReleaseSession' | 'checkDivergence'>> & typeof directory };
}

describe('transcript divergence of a managed stdio directory', () => {
  it('offers the rule only for a CLI that declares it forks a transcript two writers use, and reads its content', () => {
    expect(divergenceDirectory().directory.checkDivergence).toBeTypeOf('function');
    const shared = divergenceDirectory(undefined, { ...claudeBehaviour, concurrency: { model: 'single_writer', probe: 'native', othersVisible: 'never' } }).directory;
    expect([shared.divergedAt, shared.canReleaseSession, shared.checkDivergence]).toEqual([undefined, undefined, undefined]);
    const contentless = createManagedStdioDirectory('claude', 'Claude', { descriptor: { behaviour: claudeBehaviour }, listSessions: async () => [], sessionState: () => undefined } as unknown as ManagedStdioProvider, []);
    expect(contentless.checkDivergence).toBeUndefined();
  });

  it.each([
    ['a transcript that ends with what the session wrote', HELD, false],
    ['a transcript whose newest branch another writer wrote', ['base', 'terminal'], true],
    ['a transcript another writer continued', [...HELD, 'terminal'], true],
  ])('checks %s by content: %s', async (_name, transcript, expected) => {
    const { input, directory } = divergenceDirectory();
    input.transcript = transcript;
    expect(await directory.checkDivergence('session')).toBe(expected);
    expect(directory.divergedAt('session')).toBe(expected ? WRITTEN_AT : undefined);
  });

  it('finds a fork whatever the times: the transcript changed in the same millisecond as the session wrote', async () => {
    const { input, directory } = divergenceDirectory();
    input.nativeUpdatedAt = WRITTEN_AT;
    input.transcript = ['base', 'terminal'];
    expect(await directory.checkDivergence('session')).toBe(true);
  });

  it('gives no verdict while something runs, or when the transcript cannot be read', async () => {
    const running = divergenceDirectory({ quiet: false, writtenAt: WRITTEN_AT, records: HELD });
    running.input.transcript = ['base', 'terminal'];
    expect(await running.directory.checkDivergence('session')).toBe(false);
    expect(running.input.reads).toBe(0);
    const unreadable = divergenceDirectory();
    unreadable.input.transcript = undefined;
    expect(await unreadable.directory.checkDivergence('session')).toBe(false);
    expect(unreadable.directory.divergedAt('session')).toBeUndefined();
  });

  it('reads the transcript again only when it or what the session holds changed', async () => {
    const { input, directory } = divergenceDirectory();
    input.transcript = ['base', 'terminal'];
    await directory.checkDivergence('session');
    await directory.checkDivergence('session');
    expect(input.reads).toBe(1);
    input.nativeUpdatedAt = WRITTEN_AT + 1;
    await directory.checkDivergence('session');
    expect(input.reads).toBe(2);
    input.state = { quiet: true, writtenAt: WRITTEN_AT + 2, records: [...HELD, 'next'] };
    expect(directory.divergedAt('session')).toBeUndefined();
    input.transcript = [...HELD, 'next'];
    expect(await directory.checkDivergence('session')).toBe(false);
    expect(input.reads).toBe(3);
  });

  it('takes the update time a listing read instead of reading it again', async () => {
    const { input, directory } = divergenceDirectory();
    input.nativeUpdatedAt = undefined;
    input.transcript = ['base', 'terminal'];
    expect(await directory.checkDivergence('session', WRITTEN_AT + 5)).toBe(true);
    await directory.checkDivergence('session', WRITTEN_AT + 5);
    expect(input.reads).toBe(1);
  });

  it('releases a diverged session only after 30 s of quiet in its transcript, and never one that did not diverge', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { input, directory } = divergenceDirectory();
    const updatedAt = WRITTEN_AT + 500;
    input.nativeUpdatedAt = updatedAt;
    await directory.checkDivergence('session');
    vi.setSystemTime(updatedAt + DIVERGENCE_QUIET_MS);
    expect(directory.canReleaseSession('session')).toBe(false);
    input.transcript = ['base', 'terminal'];
    input.nativeUpdatedAt = updatedAt + 1;
    await directory.checkDivergence('session');
    vi.setSystemTime(updatedAt + 1 + DIVERGENCE_QUIET_MS - 1);
    expect(directory.canReleaseSession('session')).toBe(false);
    vi.setSystemTime(updatedAt + 1 + DIVERGENCE_QUIET_MS);
    expect(directory.canReleaseSession('session')).toBe(true);
  });

  it('does not release a diverged session while something runs for it, nor one it holds no state for', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { input, directory } = divergenceDirectory();
    input.transcript = ['base', 'terminal'];
    await directory.checkDivergence('session');
    input.state = { quiet: false, writtenAt: WRITTEN_AT, records: HELD };
    vi.setSystemTime(WRITTEN_AT + 10 * DIVERGENCE_QUIET_MS);
    expect(directory.canReleaseSession('session')).toBe(false);
    input.state = null;
    expect(directory.canReleaseSession('session')).toBe(false);
    expect(directory.divergedAt('session')).toBeUndefined();
  });
});
