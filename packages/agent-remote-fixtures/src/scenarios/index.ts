import type { Scenario } from './scenario.js';
import { sessionWireScenarios } from './session-wire.js';
import { uplinkScenarios } from './uplink.js';
import { uplinkWireScenarios } from './uplink-wire.js';

export { recordScenario, type Scenario, type ScenarioContext, type ScenarioRecorder } from './scenario.js';
export const scenarios: Scenario[] = [...uplinkScenarios, ...uplinkWireScenarios, ...sessionWireScenarios];
export const transcriptDirectory = (scenario: Scenario): string => scenario.seam === 'S2' ? 'uplink' : 'session-wire';
