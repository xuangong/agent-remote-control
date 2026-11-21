import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What the OpenCode server does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). The native
 * smoke (`scripts/opencode-native.test.mjs`, `pnpm test:native:opencode`) confirmed the event types of a session on OpenCode 2.0.25; a value
 * marked "assumed" waits for a check of its own.
 */
export const openCodeBehaviour = {
  // The OpenCode server arbitrates its clients: no lease, every send steers, a busy session answers 409 (`docs/opencode.md`).
  concurrency: { model: 'shared_clients', probe: 'none', othersVisible: 'live' },
  // The server serves a session's messages without an attachment; their order on reread is assumed to be the live one.
  reread: { order: 'live', paging: 'messages', withoutAttach: true, cost: 'whole_session' },
  resume: { cost: 'subscription', deadlineMs: 15_000 },
  input: { identity: 'none', whileBusy: 'steer' },
  // `session.retry.scheduled { at, error }` with an error of HTTP status 429: the server retries the turn itself at `at`, in milliseconds
  // (`@opencode/schema` 2.0.25, `dist/session-event.js`, `dist/session-error.js`; `usage-limit.ts`).
  limits: { signal: 'event' },
  failures: { runtime: ['native_runtime_unavailable', 'native_usage_limited'], inUse: [] },
  // Interaction receipts live only in the server's memory; they are not marked yet (requirements review, section 4.5).
  liveOnly: [],
  verifiedVersion: '2.0.25',
} as const satisfies AgentProviderBehaviour;
