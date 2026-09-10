# Provider Commands Implementation Plan

**Goal:** Render a Provider-owned slash command directory and route invocation and subsequent interactions back to the native runtime.

**Architecture:** `AgentSession.listCommands()` returns descriptors and `executeCommand(id, args)` invokes them. Remote adds corresponding request/reply pairs; existing question/form requests and interaction responses carry command menus. Provider adapters own native operation mapping. The composer owns filtering and keyboard navigation only. Existing session-setting toolbar controls remain shortcuts.

**Scope:** Codex models, permissions, compact, dynamic enabled skills and custom prompts; DSH registered commands plus native model/permission pickers. No terminal emulation or full TUI menu discovery claim. No synthetic message queue. Protocol 1.4.0 is still an unshipped worktree change and includes this corrected contract.

## Contract

- `AgentCommand`: `{ id, name, description, kind: 'command' | 'skill' | 'prompt', inputHint? }`. IDs are opaque. Names exclude the slash; arguments preserve their contents.
- `AgentCommandResult`: `{ text?: string }`. An empty result may mean an interaction has opened. It does not imply the whole interaction flow is complete.
- SDK capability `commands?: boolean`; optional `listCommands(): Promise<AgentCommand[]>`, `executeCommand(id: string, args: string): Promise<AgentCommandResult>`.
- `list_commands` request `{requestId, agentId}` and `command_list` response with `commands`.
- `execute_command` request `{requestId, agentId, commandId, args}` and `command_result` response with `result`. No extra ACK duplicates either response. Native failures use the existing error path.
- SDK `CommandInteractions` tracks command-owned question/form requests, validates responses, prevents duplicate submission, preserves a failed step for retry, and publishes existing interaction events. A successful step may open a subsequent step. These pending callbacks are process-local, like existing pending native requests.

## Tasks

- [x] Add SDK command types, validation, and reusable interaction continuation helper with failure/duplicate-response tests.
- [x] Codex adapter: discover skills via `skills/list`, prompts in the configured Codex home, explicit supported built-ins, native compact, model then effort selection, permission selection. Validate names, filter disabled skills, bound filesystem reads, preserve confirmed settings and Planning.
- [x] DSH adapter: discover the agent-scoped registry on demand, execute registered commands without model submission, expose results, bridge model/permission choices via existing services and interaction requests. Preserve arguments and native side effects.
- [x] Protocol, Relay and client: codec validation, command directory routing, native invocation, correlated replies, capability and session checks, transport regression.
- [x] Composer: replace fixed slash entries with fetched descriptors, pending/error/empty states, input hints, keyboard handling, stale session isolation. Keep toolbar status accessible outside the native directory.
- [x] Verify native command discovery/selection in desktop and mobile Codex browser fixtures; preserve Working/interrupt regression. Run bounded unit tests, build, typecheck, compatibility and docs checks.

## Execution decisions

- The user's approval covers continuing implementation in the existing task worktree. Do not reset prior settings or activity changes.
- Native menus are adapted to existing question/form requests. No public message per command or menu level is needed.
- Native command directories are fetched when the menu opens; invocation revalidates the current native command. Do not permanently cache runtime-dependent availability.
- Command controls may wait for native questions; the interaction-response path must remain available while command execution is pending.

## Validation

- Workspace build and typecheck passed.
- Full unit suite: 1,068 passed, 6 skipped.
- Codex browser suite: 8 passed across desktop and mobile with a real pinned Codex app-server and deterministic model response fixture. Covered dynamic command discovery, multi-step model and permission selection, menu recovery after reload, toolbar settings, Working and elapsed time, ordinary immediate input during an active turn, interruption, and consecutive turns. Directory screenshots were inspected in both layouts.
- DSH command and settings behavior is covered by adapter tests; this change has not been exercised against a full live DSH installation.
- Review fixes cover native command waiting beyond ordinary operation timeouts, cancellation while command execution is pending, and DSH catalog refresh and recovery.
- Custom prompts currently expand raw `$ARGUMENTS` only; unsupported placeholder forms fail explicitly. Full Codex TUI command parity is outside this adapter contract.

## Message delivery implementation

- Ordinary send delegates idle/start versus active/steer selection to native adapters.
- Optional `delivery: "next_turn"` and `queueMessage` capability reuse the send request and acknowledgement. DSH forwards to its own Inbox; Codex exposes no synthetic queue.
- Codex preserves approvals while accepting active-turn input, and retries only on definite native non-delivery.
- Native command execution rejects concurrent sends promptly instead of implicitly retaining messages.
- A real Host uplink test verifies exact next-turn delivery and rejection without capability. Desktop and mobile Codex validation also confirms that another send remains available after steering acceptance.
