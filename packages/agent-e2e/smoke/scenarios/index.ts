import type { DeferredScenario, Scenario } from '../scenario.js';
import { badNetwork } from './m1-bad-network.js';

export const scenarios: Scenario[] = [badNetwork];

export const deferredScenarios: DeferredScenario[] = [];
