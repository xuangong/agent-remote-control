/**
 * Transcript divergence: whether a session's transcript holds what something other than this process wrote, for a CLI that forks a
 * transcript two writers use (`concurrency.model` `fork_on_divergence`, as Claude Code declares). Such a runtime continues from its own
 * last message, so a turn another writer added is not seen by it until the session is released and read again.
 *
 * Contract.
 * - D1 Divergence is decided by content, never by time: the transcript, as a new attachment would read it, holds a record the resident
 *   runtime neither read when it loaded nor wrote since, or its newest record is not the resident runtime's last one. Two turns that end
 *   in the same millisecond fork a transcript as surely as two that end minutes apart, and a reread shows the branch written last.
 * - D2 A transcript that holds only what the resident runtime read or wrote, ending with its last record, is not diverged, however close
 *   in time another process wrote to the file.
 * - D3 A diverged session may be released only when nothing runs for it and its transcript has been quiet for `DIVERGENCE_QUIET_MS`, so a
 *   terminal still writing between its turns is left to finish first.
 *
 * Pure: the records and the times are the caller's.
 */
export const DIVERGENCE_QUIET_MS = 30_000;

/**
 * D1, D2: `held` is what the resident runtime holds of its transcript, the records it read at load or wrote since, newest last;
 * `transcript` is the transcript as a new attachment would read it, newest last.
 */
export function divergedByContent(held: readonly string[], transcript: readonly string[]): boolean {
  if (transcript.at(-1) !== held.at(-1)) return true;
  const known = new Set(held);
  return transcript.some(record => !known.has(record));
}

/** D3: whether a diverged session may be released now: nothing runs for it and its transcript has been quiet long enough. */
export function mayReleaseDiverged(facts: { quiet: boolean; diverged: boolean; nativeUpdatedAt: number | undefined }, now: number): boolean {
  return facts.quiet && facts.diverged && facts.nativeUpdatedAt !== undefined && now - facts.nativeUpdatedAt >= DIVERGENCE_QUIET_MS;
}
