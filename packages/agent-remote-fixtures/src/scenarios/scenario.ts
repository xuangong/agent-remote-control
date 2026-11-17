import type { JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

import type { Relay } from '../relay-harness.js';
import { createRecorder, type Seam, type Transcript } from '../transcript.js';
import type { UplinkOptions } from '../uplink-harness.js';

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
  /**
   * What the real Relay is set up with before the first frame, for a scenario whose Relay side does not depend on anything the
   * scenario does later. A player can then stand in for the browser or the Controller against that same Relay. A scenario without
   * it is replayed by running it again.
   */
  relayBacking?: { seed?: boolean; scenery?(relay: Relay): Promise<void>; uplink?: UplinkOptions };
}

/** Runs a scenario and returns its transcript, stamped with the protocol version and the repository state it ran at. */
export async function recordScenario(scenario: Scenario, context: ScenarioContext, stamp: { protocolVersion: string; recordedAt: string }): Promise<Transcript> {
  const recorder = createRecorder({ seam: scenario.seam, scenario: scenario.name, description: scenario.description, consumers: scenario.consumers, ...stamp });
  await scenario.run(recorder, context);
  return recorder.finish();
}
