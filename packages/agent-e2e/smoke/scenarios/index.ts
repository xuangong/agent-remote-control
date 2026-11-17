import type { DeferredScenario, Scenario } from '../scenario.js';
import { badNetwork } from './m1-bad-network.js';
import { controllerRestart } from './m2-controller-restart.js';
import { relayRestart } from './m3-relay-restart.js';
import { hiddenAndDrops } from './m7-hidden-and-drops.js';

/** The scenarios this version runs, in the order of the plan. The quick subset is M1, M2 and M7. */
export const scenarios: Scenario[] = [badNetwork, controllerRestart, relayRestart, hiddenAndDrops];

export const deferredScenarios: DeferredScenario[] = [
  { id: 'M4', title: 'Quota pressure', reason: 'Needs tiny journal limits on the Relay; the local instance runs the default 64 MiB session limit and reads no limit from its environment. The quota profiles and big-output prompt exist in faults/quota.mjs; the scenario waits for the Node Relay host (M12), which takes limits as an option.' },
  { id: 'M5', title: 'Many sessions', reason: 'Needs the Node Relay host (M12) to create 200 sessions and a 50-bot group without 200 real model turns; the seeded plan exists in faults/many-sessions.mjs.' },
  { id: 'M6', title: 'Terminal races page', reason: 'The plan schedules it after the Node host exists (M12). It also needs a terminal driver for a real Claude and Codex terminal, which the instance refuses today (`session attach`) and v1 does not have.' },
  { id: 'M8', title: 'Soak', reason: '30 minutes of streaming on three sessions; the resource series invariants exist, the scenario waits for the Node host.' },
];
