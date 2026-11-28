# Native assumption checks
Module: one check per CLI, by hand or nightly: `pnpm test:native:codex` (`agent-provider-codex/src/native-assumptions.local.test.ts` and the recorder), `pnpm test:native:claude` (`agent-provider-claude/src/native-assumptions.local.test.ts`, the recorder and the terminal fork), `pnpm test:native:copilot` (`agent-provider-copilot/tests/native-assumptions.local.test.ts` and the recorder), `pnpm test:native:opencode` (`scripts/opencode-native-assumptions.test.mjs`), `pnpm test:native:pi` (`agent-provider-pi/tests/native-assumptions.local.test.ts` and the recorder `tests/journal-recording.test.ts`). Each runs the installed CLI in a temporary home against a scripted model: nothing signs in, and no session of the person's own CLIs, Codex daemon or Controller is touched. Design source: section 4.4 of the requirements review (step B5, gap 6).

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 6 | 0 | 0 | 0 |

## Clauses
- N1. A recording names the CLI and the version that made it (`"cli"` header, required by `pnpm fixtures:check`); the check fails while the installed CLI is another version.
- N2. The installed CLI is the declaration's `verifiedVersion`; the Controller's health compares installed CLIs with the same field (no table of its own).
- N3. The recorder, run against the committed recordings, finds the same shape: only the journal's rules move a line (`recordingShape`).
- N4. Each declared field the check can provoke holds on the installed CLI: the probe and the refusal of a second writer, typed; the echoed input id, live and read again; every error text the adapter matches as words, and whether the CLI now gives it a structured code.
- N6. A goal as the person sets it (`/goal`) is what the adapter reads: Claude Code's `goal_status` transcript rows (set, each check with its reason, met, cleared) against a scripted goal evaluator, and the goal restored when the session is opened again; Codex's `thread/goal/*` (statuses, seconds, set, edit, pause, resume, clear, `get` on a reopened thread) against a scripted model that never finishes the goal. (`native-goal.local.test.ts` of each adapter, part of `pnpm test:native:claude` and `pnpm test:native:codex`.)
- N5. A normal turn sends no event of a kind the adapter does not know (gap 10); a new one is listed with its meaning, or reported.

Run on 2026-11-22 on this machine:

| CLI (installed) | N1 recordings | N2 declaration | N3 recorder | N4, N5 |
|---|---|---|---|---|
| Codex 0.171.0 | pass, after recording again on 0.171.0 (was 0.169.0) | pass (0.171.0) | 12 of 12; on 0.169.0, `plan-mode` had drifted: a new plan item's id is now its own id, no longer `<turn>-plan` (keys still equal live and read again) | pass: the active-writer refusal is `-32600` with the exact words and no structured code; `no active turn to steer`; input id echoed; no unknown notification |
| Claude Code 2.1.319 | pass | pass | 19 of 19, and the terminal fork | pass: input uuid kept in the transcript; no unknown message or record |
| Copilot runtime 1.0.109 (the pinned 1.0.83 package is a loader that runs it) | pass, after recording again on 1.0.109 | pass, `verifiedVersion` 1.0.109 (was none) | 8 of 8 | pass: `checkInUse` refuses a second client, typed `writer_elsewhere`; ten `model.*` event types the SDK does not declare, now listed as known |
| OpenCode 2.0.25 | none recorded | pass, `verifiedVersion` 2.0.25 (was none) | n/a | pass: no unknown event type in two turns |
| pi 0.73.1 (recorded 2026-11-26) | recorded on 0.73.1: settled, restart, reasoning, approval, interrupted, failed, steered, partial-tool | `verifiedVersion` 0.73.1; the check compares it with the installed CLI | 8 of 8 | checks: two processes on one session file are both accepted (`fork_on_divergence`, probe `none`); a normal turn sends no unknown event; a session that never got an answer has no file, so it cannot be reopened; `set_session_name` and the appended `session_info` entry are both read as the session name. Pass/fail recorded when the check file runs. |

Continuity across the Codex plan id change: none is lost. Codex stores a plan item's id, so a session written before the change reads back with its old `<turn>-plan` id and an existing journal reopens unchanged, with no replacement (checked natively on this machine: a plan written by Codex 0.170.0 and read again by 0.171.0 keeps its key); only new plan items take the new id, equal live and read again. Not checked natively: Codex's 70 s unload in the shared daemon, the limit signals (the scripted models send none), Claude Code's fork beyond the terminal test.
