import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What the GitHub Copilot CLI does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). No
 * native check has confirmed it yet, so it names no verified version; a value marked "assumed" waits for one.
 */
export const copilotBehaviour = {
  // One client of the Copilot CLI writes a session; the SDK says at resume whether another client has it (`sessions.checkInUse`).
  // Whether a client that opens the session later is seen is assumed not.
  concurrency: { model: 'single_writer', probe: 'native', othersVisible: 'never' },
  // `getEvents()` is read whole; the todo board's place among its siblings varies from run to run.
  reread: { order: 'siblings_unordered', paging: 'none', withoutAttach: false, cost: 'whole_session' },
  // A call into the shared Copilot CLI process, with 15 s per call.
  resume: { cost: 'shared_process', deadlineMs: 15_000 },
  // Assumed: no input id is kept, and input while busy waits for the next turn (immediate input is degraded).
  input: { identity: 'none', whileBusy: 'queue' },
  // `session.error` with `errorType` `rate_limit` or `quota` (`@github/copilot-sdk` 1.0.11).
  limits: { signal: 'error' },
  failures: { runtime: [], inUse: ['writer_elsewhere'] },
  liveOnly: ['interaction', 'reasoning', 'todo', 'error'],
} as const satisfies AgentProviderBehaviour;
