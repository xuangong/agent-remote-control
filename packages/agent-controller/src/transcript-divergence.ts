/**
 * Transcript divergence: whether something other than this process wrote to a session's transcript after this process's last
 * write, for a runtime that keeps the conversation in memory (Claude Code). Such a runtime continues from its own last message, so
 * a turn a terminal wrote is not seen until the session is released and read again.
 *
 * Contract.
 * - A native update counts as another writer's only when it is more than `DIVERGENCE_TOLERANCE_MS` after this process's last
 *   write; an update within the tolerance is taken for this process's own write reaching the file.
 * - A diverged session may be released only when nothing runs for it and its transcript has been quiet for `DIVERGENCE_QUIET_MS`.
 * - Limit: a terminal turn that ends within the tolerance of this process's last write is not seen as divergence, so two turns
 *   written at the same time (a fork of the transcript) leave the runtime on its own branch (section 10, O49).
 *
 * Pure: the times are the caller's.
 */
export const DIVERGENCE_TOLERANCE_MS = 2000;
export const DIVERGENCE_QUIET_MS = 30_000;

/** Whether the transcript changed after this process's last write by more than the tolerance. */
export function diverged(nativeUpdatedAt: number | undefined, writtenAt: number): boolean {
  return nativeUpdatedAt !== undefined && nativeUpdatedAt > writtenAt + DIVERGENCE_TOLERANCE_MS;
}

/** Whether a diverged session may be released now: nothing runs for it and the transcript has been quiet long enough. */
export function mayReleaseDiverged(state: { quiet: boolean; writtenAt: number } | undefined, nativeUpdatedAt: number | undefined, now: number): boolean {
  return !!state?.quiet && diverged(nativeUpdatedAt, state.writtenAt) && now - nativeUpdatedAt! >= DIVERGENCE_QUIET_MS;
}
