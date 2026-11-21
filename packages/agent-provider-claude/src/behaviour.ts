import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What Claude Code does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). Facts come from the
 * S6a recordings (Claude Code 2.1.319) and smoke M6; a value marked "assumed" waits for a native check.
 */
export const claudeBehaviour = {
  // Claude Code coordinates no writers: a resident session never sees a terminal's turn, and two turns at once fork the transcript
  // (`terminal-fork.local.test.ts`, O49). Another writer shows only in the transcript, so only a reread sees it.
  concurrency: { model: 'fork_on_divergence', probe: 'none', othersVisible: 'on_reread' },
  // The whole transcript is read, unpaged, in a worker with a deadline (`catalog.ts`); concurrent tool results may come back in
  // another order than they ran.
  reread: { order: 'siblings_unordered', paging: 'none', withoutAttach: true, cost: 'whole_session' },
  // Each resume starts a Claude Code process, with a 15 s start-up deadline.
  resume: { cost: 'process', deadlineMs: 15_000 },
  // Claude Code keeps the uuid a user message is sent with (FL1); input while a turn runs is steered into it.
  input: { identity: 'echoes_client_id', whileBusy: 'steer' },
  // `rate_limit_event` (Agent SDK 0.3.247 `SDKRateLimitEvent`, `sdk.d.ts`): status `rejected` stops turns until `resetsAt`, in seconds.
  limits: { signal: 'event' },
  // A Claude Code process that ends under a turn fails it `native_exited` (`session.ts`).
  failures: { runtime: ['native_usage_limited', 'native_exited'], inUse: [] },
  liveOnly: ['interaction', 'synthetic_output'],
  verifiedVersion: '2.1.319',
} as const satisfies AgentProviderBehaviour;
