import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';

/**
 * What the Codex CLI does, as the Provider SDK's behaviour contract states it (`agent-provider-sdk/src/behaviour.ts`). Facts come from
 * the S6a recordings (Codex 0.169.0) and smoke M6 (Codex 0.171.0); a value marked "assumed" waits for a native check.
 */
const shared = {
  // Through the shared daemon the Controller is one client of a loaded thread: every connection receives the other clients'
  // notifications, and Codex orders the turns (`codex-daemon-client/src/thread-router.ts`). A process outside the daemon meets
  // Codex's single writer ("thread <id> already has an active writer", `~/.codex/thread-writer-locks`), and the daemon unloads a
  // thread 60 to 70 s after its last client leaves (M6 on 0.171: refused at +58 s and +60 s, accepted at +70 s).
  concurrency: { model: 'shared_clients', probe: 'lock_file', othersVisible: 'live', unloadAfterLastClientMs: 70_000 },
  // History is re-sorted by start time (`history.ts`), pages hold 10 turns. Whether `thread/turns/list` reads an unloaded thread
  // without loading it is assumed not until a native check shows it (O47).
  reread: { order: 'live', paging: 'turns', withoutAttach: false, cost: 'page' },
  // `thread/resume` on the running daemon; the transport allows 90 s per request (`app-server-transport.ts`).
  resume: { cost: 'subscription', deadlineMs: 90_000 },
  // Codex lists the `clientUserMessageId` given to `turn/start` and `turn/steer` as `clientId` (`native-evidence.ts`), which the projector
  // reports as the user row's `clientMessageId`; every send passes the operation's id as it.
  input: { identity: 'echoes_client_id', whileBusy: 'steer' },
  // A turn the account's limit stops fails with `TurnError.codexErrorInfo` `usageLimitExceeded` or `rateLimitExceeded`, and
  // `account/rateLimits/updated`, sent with every turn, gives each window's `usedPercent` and `resetsAt` in seconds (app-server protocol of
  // codex-cli 0.171.0, `codex app-server generate-ts`: `v2/TurnError.ts`, `v2/CodexErrorInfo.ts`, `v2/RateLimitWindow.ts`; `usage-limit.ts`).
  limits: { signal: 'event' },
  failures: {
    runtime: ['native_file_limit', 'native_runtime_unavailable', 'native_session_unavailable', 'native_resume_timeout', 'native_history_timeout', 'native_request_timeout', 'native_usage_limited'],
    inUse: ['writer_elsewhere'],
  },
  liveOnly: ['interaction', 'todo', 'error', 'startup_notice'],
  verifiedVersion: '0.171.0',
} as const satisfies AgentProviderBehaviour;

/** A private app-server process of the Controller's own: the thread's single writer while it runs, unloaded when it exits. */
const privateRuntime = {
  ...shared,
  concurrency: { model: 'single_writer', probe: 'lock_file', othersVisible: 'never' },
  resume: { cost: 'process', deadlineMs: 90_000 },
} as const satisfies AgentProviderBehaviour;

export function codexBehaviour(connectionMode: 'private' | 'shared' | undefined): AgentProviderBehaviour {
  return connectionMode === 'shared' ? shared : privateRuntime;
}
