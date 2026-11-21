import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What a DeepSeek Harness agent does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). The
 * agent runs inside the Controller's process, so the session has no other client; input while busy is assumed refused.
 */
export const dshBehaviour = {
  concurrency: { model: 'none', probe: 'none', othersVisible: 'never' },
  reread: { order: 'live', paging: 'none', withoutAttach: false, cost: 'whole_session' },
  resume: { cost: 'shared_process', deadlineMs: 30_000 },
  input: { identity: 'none', whileBusy: 'refuse' },
  limits: { signal: 'none' },
  failures: { runtime: [], inUse: [] },
  liveOnly: [],
} as const satisfies AgentProviderBehaviour;

/** A recorded trace played back: nothing writes to it, and opening it reads the trace. */
export const recordedDshBehaviour = {
  ...dshBehaviour,
  resume: { cost: 'subscription', deadlineMs: 30_000 },
} as const satisfies AgentProviderBehaviour;
