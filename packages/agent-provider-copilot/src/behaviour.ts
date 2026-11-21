import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What the GitHub Copilot CLI does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). The native
 * checks (`tests/native-assumptions.local.test.ts`) confirmed the native probe, the writer refusal and the event types of a turn on the
 * Copilot runtime 1.0.109, which the pinned 1.0.83 loader runs; a value marked "assumed" waits for a check of its own.
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
  // `session.error` with `errorType` `rate_limit` or `quota`, and the seconds until the reset only in an `auto_mode_switch.requested`
  // that may follow (`@github/copilot-sdk` 1.0.11, `dist/generated/session-events.d.ts`; `usage-limit.ts`).
  limits: { signal: 'error' },
  failures: { runtime: ['native_usage_limited'], inUse: ['writer_elsewhere'] },
  // The text a turn streamed before it was interrupted is kept live-only, since the CLI's history drops it (recording `interrupted`).
  liveOnly: ['interaction', 'reasoning', 'todo', 'error', 'partial_output'],
  // The pinned @github/copilot 1.0.83 package is a loader that runs the runtime it keeps current: 1.0.109 on 2026-11-22.
  verifiedVersion: '1.0.109',
} as const satisfies AgentProviderBehaviour;
