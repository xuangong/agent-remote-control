import type { DeferredScenario, Scenario } from '../scenario.js';
import { badNetwork } from './m1-bad-network.js';
import { controllerRestart } from './m2-controller-restart.js';
import { quotaPressure } from './m4-quota-pressure.js';
import { manySessions } from './m5-many-sessions.js';
import { relayRestart } from './m3-relay-restart.js';
import { soak } from './m8-soak.js';
import { hiddenAndDrops } from './m7-hidden-and-drops.js';

/** The scenarios this version runs, in the order of the plan. The quick subset is M1, M2 and M7. */
export const scenarios: Scenario[] = [badNetwork, controllerRestart, relayRestart, quotaPressure, manySessions, hiddenAndDrops, soak];

export const deferredScenarios: DeferredScenario[] = [
  { id: 'M6', title: 'Terminal races page', reason: 'The plan schedules it after the Node host exists (M12). It also needs a terminal driver for a real Claude and Codex terminal, which the instance refuses today (`session attach`) and v1 does not have.' },
];
