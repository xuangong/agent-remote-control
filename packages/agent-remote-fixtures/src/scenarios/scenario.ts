import type { JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

import { createRecorder, type Seam, type Transcript } from '../transcript.js';

/** Where a scenario gets what the real CLIs recorded: the provider's recording by name. */
export interface ScenarioContext { recording(provider: 'codex' | 'claude' | 'copilot', name: string): JournalRecording }

/** The recorder a scenario writes its frames and step markers to. */
export type ScenarioRecorder = ReturnType<typeof createRecorder>;

/** An ordered, named script over real modules; replaying it must give the committed transcript. */
export interface Scenario {
  seam: Seam;
  name: string;
  description: string;
  /** Test files, relative to the repository root, that replay the transcript. */
  consumers: string[];
  run(recorder: ScenarioRecorder, context: ScenarioContext): Promise<void>;
}

/** Runs a scenario and returns its transcript, stamped with the protocol version and the repository state it ran at. */
export async function recordScenario(scenario: Scenario, context: ScenarioContext, stamp: { protocolVersion: string; recordedAt: string }): Promise<Transcript> {
  const recorder = createRecorder({ seam: scenario.seam, scenario: scenario.name, description: scenario.description, consumers: scenario.consumers, ...stamp });
  await scenario.run(recorder, context);
  return recorder.finish();
}
