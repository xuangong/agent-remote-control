import { readdirSync, readFileSync } from 'node:fs';
import type { ProviderConformanceSubject } from '@orchardworks/agent-provider-sdk/conformance';
import type { JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

import { claudeBehaviour } from './behaviour.js';
import { claudeNativeFake } from './test-utils/native-fake.js';

/** What a real claude CLI did for each recorded scenario, and the rows the runtime must hold for it. Test support: the package's `./recordings` entry, never published. */
const directory = new URL('../src/journal-fixtures/', import.meta.url);

/** The names of the recordings this provider has. */
export const recordingNames = (): string[] =>
  readdirSync(directory).filter(file => file.endsWith('.json') && !file.endsWith('.rows.json')).map(file => file.slice(0, -'.json'.length)).sort();

/** One recording: the live observations of a run, and the history observations of the same session opened again. */
export const recording = (name: string): JournalRecording => JSON.parse(readFileSync(new URL(`${name}.json`, directory), 'utf8')) as JournalRecording;

/** The golden rows of a recording: what the runtime holds for its live run and for its reread. Reviewed once; see `docs/current/agent-remote/seams.md` (S1). */
export const recordingRows = (name: string): { live: unknown[]; reread: unknown[] } => JSON.parse(readFileSync(new URL(`${name}.rows.json`, directory), 'utf8')) as { live: unknown[]; reread: unknown[] };

/** Claude Code for the provider conformance kit (`@orchardworks/agent-provider-sdk/conformance`): its declaration, these recordings, and the adapter over a scripted Agent SDK query. */
export const claudeConformanceSubject = (): ProviderConformanceSubject => ({
  name: 'claude code', providerId: 'claude', behaviour: claudeBehaviour, recordings: { names: recordingNames, recording }, native: claudeNativeFake(),
});
