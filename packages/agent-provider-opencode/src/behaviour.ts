import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What the OpenCode server does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). No native
 * check has confirmed it yet, so it names no verified version; a value marked "assumed" waits for one.
 */
export const openCodeBehaviour = {
  // The OpenCode server arbitrates its clients: no lease, every send steers, a busy session answers 409 (`docs/opencode.md`).
  concurrency: { model: 'shared_clients', probe: 'none', othersVisible: 'live' },
  // The server serves a session's messages without an attachment; their order on reread is assumed to be the live one.
  reread: { order: 'live', paging: 'messages', withoutAttach: true, cost: 'whole_session' },
  resume: { cost: 'subscription', deadlineMs: 15_000 },
  input: { identity: 'none', whileBusy: 'steer' },
  // `session.retry.scheduled`.
  limits: { signal: 'event' },
  failures: { runtime: ['native_runtime_unavailable'], inUse: [] },
  // Interaction receipts live only in the server's memory; they are not marked yet (requirements review, section 4.5).
  liveOnly: [],
} as const satisfies AgentProviderBehaviour;
