import { readFileSync } from 'node:fs';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';

/** What the real Copilot CLI did for one scenario: the live observations, and the history observations of the same session opened again. */
export interface CopilotRecording { live: ProviderObservation[]; reread: ProviderObservation[] }

/** A recording of tests/fixtures/journal in the Copilot package, made by `journal-recording.test.ts` against the real CLI. */
export const recording = (name: string): CopilotRecording =>
  JSON.parse(readFileSync(new URL(`../../../agent-provider-copilot/tests/fixtures/journal/${name}.json`, import.meta.url), 'utf8')) as CopilotRecording;
