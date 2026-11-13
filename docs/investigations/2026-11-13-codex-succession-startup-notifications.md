# Codex handoff interrupted by MCP startup notifications

## Reported operation

Operation `eac6ffa2-604f-48ad-b0df-669727c6f857` was durably rejected with
`succession_preparation_failed` after creating its Codex candidate. Its source
Claude session remained the primary role at revision 1. Its context attachment
was pending, with no first-input delivery. Checking status cannot retry a terminal
rejection, and reconciliation does not revive it.

The installed Controller's records were inspected read-only. They do not retain
the underlying exception, so they cannot establish which exception caused this
particular rejection. No installed service or reported session was changed.

## Reproduction and fix

In the isolated local instance, both Claude-to-Codex and Codex-to-Codex handoffs
could fail native attachment verification. Temporary diagnostic instrumentation
confirmed that the binding, agent and native session remained the same while the
Codex validity token became stale. The last notification crossing this retained
verification window was `mcpServer/startupStatus/updated`.

`CodexAppServerSession.receiveNotification` previously invalidated native evidence
for every notification. MCP `starting` and `ready` updates describe background
service initialization; they change neither session work nor projected history.
Their timing could therefore reject preparation or interrupt commit despite an
idle session. A later attempt could succeed when those updates arrived earlier.

The adapter now preserves evidence for these two progress states only. It still
processes the notifications normally. Failed, unknown and malformed status
notifications, native input, settings, queue changes, runtime changes and lost
connections retain their existing invalidation behavior. The Host, public
protocol and Relay transaction rules are unchanged. Temporary instrumentation
was removed.

## Verification

- Before the fix, both new progress regression cases failed with
  `native_evidence_stale`; after it, all 485 tests in 38 Codex adapter files passed.
- Adapter typecheck, `git diff --check`, `pnpm compatibility:update` and
  `pnpm compatibility:check` passed. Tests used per-test and outer deadlines.
- Real page controls committed Claude-to-Codex operation
  `1233fe97-65f5-432b-a678-e8f66b18312f` and Codex-to-Codex operation
  `585e1352-525f-4b16-b1b8-057c3fc99f9c`.
- The cross-provider successor answered `HANDOFF-OK` on its first input.
- The same-provider successor answered `LOCAL-OK` when asked to repeat the previous
  session's last reply without supplying that answer again. Native readback and
  the successor page both confirmed the reply and carried context.
- An initial Claude model probe was cancelled after waiting without a reply;
  successful model-turn evidence is from Codex. Claude idle creation and handoff
  were exercised independently.

Origin: `http://localhost:63725` (isolated worktree instance).
Build: running `24890e43fc47` (dirty); checkout `24890e43fc47` (dirty), rebuilt
with the final implementation before acceptance.

| Layer | Result |
| --- | --- |
| Build | Verified: `pnpm local up` completed with the final code. |
| Site | Verified: running, local user signed in. |
| Controller | Verified: registered uplink; Claude and Codex enabled. |
| Page | Verified: headless DOM assertions and opened screenshots. |
| Feature | Verified: both page handoffs committed and opened successors. |
| Model turn | Verified: Codex first-input and context-continuation replies. |

Evidence is under the worktree's ignored `.tmp/local/`: `handoff-page.mjs` and
`handoff-page.log`, `codex-handoff-page.mjs` and `codex-handoff-page.log`, and
`context-reply.json`. Opened screenshots `claude-to-codex-before.png`,
`claude-to-codex-complete.png` and `codex-to-codex-complete.png` show the provider
choice and successful handoff notices; `context-reply.png` shows the successor's
carried history and actual reply. These are paired with DOM assertions.

Test Codex sessions were released and unfinished test handoffs cancelled. The
isolated instance was stopped after verification. The implementation was prepared on branch `fix/succession-preparation` for
Controller 0.2.79. Publishing the package does not update running Hosts.
