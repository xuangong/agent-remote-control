import type { JournalRecording } from '@orchardworks/agent-provider-sdk/testing';
import * as claude from '@orchardworks/agent-provider-claude/recordings';
import * as codex from '@orchardworks/agent-provider-codex/recordings';
import * as copilot from '@orchardworks/agent-provider-copilot/recordings';
import * as pi from '@orchardworks/agent-provider-pi/recordings';

/** What a real native runtime did for one scenario: the live observations, and the history observations of the same session opened again. */
export type Recording = JournalRecording;

export type RecordedProvider = 'copilot' | 'codex' | 'claude' | 'pi';

/** Each provider's recordings, read through its `./recordings` entry; a provider's recorder (`journal-recording` in its package) writes them. */
const LIBRARY: Record<RecordedProvider, { recording(name: string): Recording; recordingNames(): string[] }> = { copilot, codex, claude, pi };

/** One recording of a provider, made by its recorder against the real CLI. */
export const recording = (provider: RecordedProvider, name: string): Recording => LIBRARY[provider].recording(name);

/** The names of the recordings a provider has; none while it has not been recorded. */
export function recordingNames(provider: RecordedProvider): string[] {
  try { return LIBRARY[provider].recordingNames(); } catch { return []; }
}
