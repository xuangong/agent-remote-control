import type { DeferredScenario, Scenario } from '../scenario.js';
import { badNetwork } from './m1-bad-network.js';
import { controllerRestart } from './m2-controller-restart.js';
import { quotaPressure } from './m4-quota-pressure.js';
import { manySessions } from './m5-many-sessions.js';
import { relayRestart } from './m3-relay-restart.js';
import { terminalRacesPage } from './m6-terminal-races-page.js';
import { soak } from './m8-soak.js';
import { hiddenAndDrops } from './m7-hidden-and-drops.js';

/**
 * The scenarios of the plan, in its order. The quick subset is M1, M2, M4 and M7; M5 (minutes), M6 (50 terminal rounds per provider,
 * about two hours) and M8 (a soak of `--duration` minutes) are full-run only, and run alone with `pnpm smoke M6 --rounds N`.
 */
export const scenarios: Scenario[] = [badNetwork, controllerRestart, relayRestart, quotaPressure, manySessions, terminalRacesPage, hiddenAndDrops, soak];

/** Scenarios of the plan that this version does not run, with the reason; none since M6 runs. */
export const deferredScenarios: DeferredScenario[] = [];
