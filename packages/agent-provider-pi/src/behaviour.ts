import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What the pi CLI does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). A value marked
 * "assumed" waits for a native check of its own (`tests/native-assumptions.local.test.ts`).
 */
export const piBehaviour = {
  // pi has no lock and no server: each client runs its own process over the session's JSONL file, and two processes appending to one
  // file each extend their own last entry. Assumed: a second process is not detected and its turns are not seen until a reread.
  concurrency: { model: 'fork_on_divergence', probe: 'none', othersVisible: 'on_reread' },
  // The session file is read whole; entries are appended in the order the turn produced them.
  reread: { order: 'live', paging: 'none', withoutAttach: true, cost: 'whole_session' },
  // A process of its own per attached session; a cold start takes about a second.
  resume: { cost: 'process', deadlineMs: 30_000 },
  // pi keeps no client input id; input during a turn is a steering message delivered after the current tool calls.
  input: { identity: 'none', whileBusy: 'steer' },
  // A provider's rate limit is an assistant message with stopReason error whose text names the provider's error; pi retries transient errors itself.
  limits: { signal: 'none' },
  failures: { runtime: ['native_exited'], inUse: [] },
  // Interactions, reasoning that the model did not return as a block, and errors have no entry in the session file.
  liveOnly: ['interaction', 'error'],
  verifiedVersion: '0.73.1',
} as const satisfies AgentProviderBehaviour;
