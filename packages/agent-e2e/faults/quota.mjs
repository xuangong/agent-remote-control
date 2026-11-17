// Quota pressure profiles for the Relay's journal store, and the prompts that fill it. A profile names the limits the Relay
// should run with (`HostJournalsOptions.limits`); the instance does not read limits from its environment yet, so a scenario
// that needs a tiny profile waits for the Node Relay host (M12) and `pnpm local` runs only the default limits.

export const QUOTA_PROFILES = {
  default: { sessionBytes: 64 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024 },
  /** One large tool output no longer fits a session. */
  tinySession: { sessionBytes: 256 * 1024, hostBytes: 8 * 1024 * 1024 },
  /** Several sessions share a Host quota that one of them can fill. */
  tinyHost: { sessionBytes: 1024 * 1024, hostBytes: 2 * 1024 * 1024 },
};

/** A prompt that makes a session run a shell command printing about `mebibytes` MiB of text, then answer with a short word. */
export function bigToolOutputPrompt(mebibytes, { word = 'FILLED' } = {}) {
  if (!(mebibytes > 0)) throw new Error('Ask for a positive number of MiB.');
  const bytes = Math.round(mebibytes * 1024 * 1024);
  return `Run this exact shell command and do not summarize its output: head -c ${bytes} /dev/zero | tr '\\0' 'q' | fold -w 100. Then reply with the single word ${word}.`;
}
