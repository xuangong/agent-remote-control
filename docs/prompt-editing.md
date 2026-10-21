# Editing an earlier prompt

The hosted workbench follows the installed Codex app-server's verified Esc behavior. Codex 0.155.1 creates a native branch before the selected turn; editing the first prompt starts an empty thread. The original thread remains unchanged. This implementation rejects unverified native versions instead of guessing between fork, rollback, and revert.

User messages expose an edit action on desktop and beside the swipe-revealed timestamp on mobile. The initiating browser restores the selected text and ordered image tags into the new composer without sending. Missing images, unsupported native input bindings, review prompts, native child sessions, side/Ask references, active turns, and mid-turn steers cannot be edited through this action.

## Account and device behavior

- The Relay commits the source-to-target migration and the initiating account's favorite replacement together. It broadcasts only to that account's authenticated channels. Other users and the original native session are unaffected.
- Each browser replaces its locally tracked native identity, including transitive migrations delivered out of order. Titles are not identity keys.
- Loaded windows follow after five foreground seconds. Hidden pages, navigation, and incomplete initiating draft recovery pause the countdown. The original-session link remains available; an explicit original-session visit is not redirected again.
- Existing drafts stay with their original session. The initiating tab retains its operation identity through reload and pauses following until its selected prompt has been restored. Failed opening offers Retry.
- Offline clients recover migration records on reconnect and page resume. Worker SQLite storage persists migrations and favorites across restarts. At most 1,024 migration records per account and 16,384 globally are retained; reaching a limit rejects new edits before native creation.

## Contract and safety

Controllers advertise `providers[].promptEditing: true` during Host registration. The Relay rejects edits on older Hosts before forwarding a create request. Native interpretation stays in the Codex adapter. The create request adds `editNativeSessionId`, `editTurnId`, and `editMessageId` together, using the existing operation identity and uncertain-outcome rules. No operation automatically sends a new user turn.

Browser channels opt into `session_migrated` frames with `migrations=1`. `GET /v1/session-migrations` supplies account-scoped recovery. The standalone workbench does not acquire an account dependency. CLI-created forks do not trigger workbench reference migration.

## Claude Code

Claude follows the same semantics: the branch holds the conversation before the selected prompt, editing the first prompt starts an empty conversation, the original session is unchanged, and files are not reverted. Claude Code has no fork-at-message request on a running session, so the Controller reads the native transcript and uses the Agent SDK's `forkSession` with the entry before the prompt as its last entry. That copy includes the conversation from before a compaction, so an earlier prompt is the way back from a conversation that has grown too large to answer or compact.

Only the prompt that started a turn is editable: its turn ID is its own transcript entry ID. Messages sent while Claude was working, the compaction summary, native command records such as `/compact`, tool results, entries outside the current conversation and native child conversations are refused with an explanation. A loaded source must be idle with no queued input, pending question or background task. Side and Ask conversations are refused. Reopened history assigns each entry the turn of its nearest preceding prompt, following parent links because parallel tool calls branch into sibling entries.

Before opening a branch, the Controller checks that its user and assistant entries equal the source's entries through the fork point. A reopened Claude session, including a new branch, reports its context usage before its next turn, so the owner can see whether to compact there or edit an earlier prompt. `pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/prompt-edit.local.test.ts` runs the branch against the installed Claude Code with a local mock model.

Validation covers native transport boundaries, account isolation and SQLite restart through real Worker HTTP/WebSocket transports, mobile countdown behavior, exact Track identity, image draft restoration, and desktop/mobile touch actions. `ARC_PROMPT_EDIT_TEST_EXECUTABLE` enables the isolated real 0.155.1 native test with a local mock model endpoint; it does not use the user's shared daemon or model credentials.
