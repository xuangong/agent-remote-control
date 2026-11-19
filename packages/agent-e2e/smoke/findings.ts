import type { InvariantResult } from './invariants/types.js';
import type { Finding } from './report.js';

/** Where a broken invariant is tested next: the seam of the integration test and the module (in architecture/modules.json) that owns the rule. */
const owners: Record<string, { seam: string; module: string }> = {
  'first-paint-from-device-store': { seam: 'S7', module: 'client (device-store)' },
  'message-settles-once': { seam: 'S3', module: 'client (send-state, step M7)' },
  'no-duplicate-item-key': { seam: 'S6', module: 'client (replica)' },
  'journal-sequences-contiguous': { seam: 'S3', module: 'journal / relay-core (journal-service)' },
  'one-replacement-per-restart': { seam: 'S2', module: 'controller (publisher)' },
  'turn-rows-complete-after-return': { seam: 'S2', module: 'controller (session-core)' },
  'no-blank-frame': { seam: 'S6', module: 'client (replica) and the renderer' },
  'no-session-connection-label': { seam: 'S6', module: 'client (session-presentation)' },
  'trim-reported': { seam: 'S3', module: 'relay-core (journal-service, window-decision)' },
  'live-only-items-survive': { seam: 'S2', module: 'journal' },
  'no-refused-row-hole': { seam: 'S2', module: 'journal' },
  'subscriptions-within-budget': { seam: 'S3', module: 'relay-core-edge' },
  'unchanged-rows-not-rerendered': { seam: 'S6', module: 'client-web / workbench' },
  'memory-flat': { seam: 'S6', module: 'client (replica)' },
  'row-counts-stable': { seam: 'S6', module: 'client (replica)' },
  'socket-counts-stable': { seam: 'S3', module: 'client (connection)' },
  'lease-follows-native-owner': { seam: 'S3', module: 'relay-core (session-control)' },
  'no-lost-or-doubled-message': { seam: 'S3', module: 'client (send-state)' },
  'take-over-works': { seam: 'S3', module: 'relay-core (session-control)' },
  'terminal-rows-appear': { seam: 'S1', module: 'the provider adapter that reads the native history' },
  'catch-up-costs-one-tail-request': { seam: 'S3', module: 'client (session-client)' },
  'half-open-socket-recovers': { seam: 'S3', module: 'client (connection)' },
  'draft-and-position-kept': { seam: 'S6', module: 'workbench (draft ownership)' },
};

/**
 * One finding per failed invariant. Each names the saved transcript and seed and the tests that follow section 5.7: the
 * transcript into `agent-remote-fixtures`, a failing integration test on the seam, then a failing unit test in the owning module.
 */
export function findingsFromFailures(scenario: string, seed: number, invariants: InvariantResult[], transcript: string | undefined): Finding[] {
  return invariants.filter(item => item.status === 'failed').map(item => {
    const owner = owners[item.invariant] ?? { seam: 'S3', module: 'unassigned' };
    const first = item.violations[0];
    return {
      id: `${scenario}-${item.invariant}`,
      summary: `${item.invariant}: ${first?.message ?? 'failed'}${item.violations.length > 1 ? ` (and ${item.violations.length - 1} more)` : ''}`,
      evidence: `scenario ${scenario}, seed ${seed}${transcript ? `, transcript ${transcript}` : ''}`,
      candidateTests: [
        `Add the transcript to agent-remote-fixtures and a failing integration test on seam ${owner.seam} in agent-remote-seams that replays it and asserts ${item.invariant}.`,
        `Add a failing unit test for the rule in ${owner.module}.`,
      ],
    };
  });
}

export const knownInvariants = Object.keys(owners);
