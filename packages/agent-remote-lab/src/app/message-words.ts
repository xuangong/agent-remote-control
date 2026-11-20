import { errorWords, type Translate } from '@orchardworks/agent-client';

/** What to show for a failure: the error's own words (in the locale when it has a catalogue key), else the given fallback. */
export function messageWords(error: unknown, fallback: string, t: Translate): string {
  return error instanceof Error && error.message ? errorWords(error, t) : fallback;
}
