import { readdirSync, readFileSync } from 'node:fs';
import type { JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

/** What a real native runtime did for one scenario: the live observations, and the history observations of the same session opened again. */
export type Recording = JournalRecording;

export type RecordedProvider = 'copilot' | 'codex' | 'claude';

/** Where each provider's recorder (`journal-recording` in its package) writes its fixtures. */
const DIRECTORY: Record<RecordedProvider, string> = {
  copilot: 'agent-provider-copilot/tests/fixtures/journal',
  codex: 'agent-provider-codex/src/journal-fixtures',
  claude: 'agent-provider-claude/src/journal-fixtures',
};

const directoryOf = (provider: RecordedProvider): URL => new URL(`../../../${DIRECTORY[provider]}/`, import.meta.url);

/** One recording of a provider, made by its recorder against the real CLI. */
export const recording = (provider: RecordedProvider, name: string): Recording =>
  JSON.parse(readFileSync(new URL(`${name}.json`, directoryOf(provider)), 'utf8')) as Recording;

/** The names of the recordings a provider has; none while it has not been recorded. */
export function recordingNames(provider: RecordedProvider): string[] {
  try { return readdirSync(directoryOf(provider)).flatMap(file => file.endsWith('.json') ? [file.slice(0, -'.json'.length)] : []).sort(); } catch { return []; }
}
