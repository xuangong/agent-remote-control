# Claude normalized event inventory

Verified against Agent SDK **0.3.247** and Claude Code **2.1.247**. This inventory describes the adapter and managed stdio integration on `feat/claude-normalized`; it is not a production release claim. Native interpretation stays in the Claude adapter. Host ownership, Relay connection control, ARDB recording and the production Session View reuse the existing contracts.

## Observation contract

| Normalized event | Claude mapping and boundary |
| --- | --- |
| `thread_started` | Not emitted separately. The authoritative native UUID is available in the initial runtime snapshot and `runtime_updated`. |
| `turn_started` | An accepted user input starts a turn with its native message UUID. |
| `turn_completed` | Successful native result, including the latest cumulative Query usage snapshot. |
| `turn_failed` | Native error result or unexpected Query termination. Ambiguous input is not automatically replayed. |
| `turn_canceled` | Public interrupt followed by native turn settlement. |
| `timeline` | Items below, identified by native message/content-block and tool-call identities. |
| `usage_updated` | Native root-model context occupancy and cumulative `modelUsage` snapshots with `runtime` scope, separate uncached input, output, cache read/write, and known total; absent fields stay absent. Native resume and `/clear` reset Query accounting; it is not a persisted session lifetime total. |
| `runtime_updated` | Native identity, cwd, model, permission/planning state, lifecycle and direct child descriptors. |
| `interaction_requested` | A live native callback with an actionable, validated response shape. |
| `interaction_resolved` | Answer, denial, dismissal or cancellation of that callback. |
| `interaction_invalidated` | Not emitted separately; canceled callbacks resolve with a canceled/denied response. Restart does not reconstruct callbacks from history. |

`observation` carries source identity, delivery (`history` or `live`), occurrence time and resource references where needed. Saved history ends at one `history_boundary`. Child transcript reconciliation can emit `timeline_replacement` through the existing epoch-replacement flow. Native message deduplication and finalized-block guards prevent streamed/final/late text from appearing twice.

## Timeline items

| Item | Support |
| --- | --- |
| `user_message` | Saved/live native text and ordered image content. |
| `assistant_message` | Text deltas plus any missing final suffix. Embedded output images use immutable resource references. |
| `reasoning` | Native thinking text; no fabricated hidden reasoning. |
| `tool_call` | Native tool identity, running/completed/failed states, typed shell/read/edit/write/search/fetch details and bounded results. No synthetic canceled result is inferred from interrupt alone. |
| `todo` | Native `TodoWrite` entries and their statuses. |
| `interaction` | The shared projection records normalized requests and resolutions. The adapter does not emit a duplicate timeline card. |
| `error` | Native failures use turn/lifecycle errors rather than a second independent error item. |
| `compaction` | Native compacting status maps to `loading`; compact boundary maps to `completed`, with available trigger/pre-token metadata. |

Successful `Edit`, `MultiEdit` and `Write` structured output becomes the existing `file_changes` JSON format. Hunk syntax and counts are validated. Unknown structures retain raw bounded output, and failed tool results never claim a committed diff. Creating a file can use the actual native Write result content when native `structuredPatch` is empty.

**Cold-history limit:** the public native history API omits `tool_use_result.structuredPatch`. Live Relay reconnection and ARDB JSONL preserve observed diffs, but a fresh provider restoring native history has result text without that diff. The adapter does not reconstruct a supposedly completed patch from requested tool input.

## Item identity

Every timeline observation carries the identity of its item (`itemIdentity`), equal in the live stream and in a reread of the SDK's session read widened with the transcript, so a journal recognizes the item (`packages/agent-provider-claude/src/projector.ts`, `transcript-extras.ts`). The adapter owns keys, completion and live-only marks. The recordings against the real CLI are `src/journal-recording.local.test.ts` and `src/journal-fixtures`.

| Item | Key | Notes |
| --- | --- | --- |
| user input, queued input run as the next turn, interrupt notice | `user:<uuid>` | the uuid the Controller gave the input is the transcript's |
| input folded into a running turn | `user:<source_uuid>` | the `queued_command` attachment names the uuid the Controller gave it; history restores the row under that uuid |
| input withdrawn before it ran | `user:<steer uuid>` | never in the transcript, so the next replacement drops it |
| typed slash command | `user:<uuid>` | the transcript's `<command-name>` envelope is read as the command was typed |
| assistant text, thinking | `assistant:<message id>:<block index>`, `reasoning:<message id>:<block index>` | stream deltas and the record share it; the record finishes the item with the text the stream lacks, an empty body when it was whole. A final that does not continue the stream finishes the item as streamed and adds a complete `...:correction` item |
| local command output (a synthetic assistant message) | `assistant:<message id>:0`, live-only | the SDK read omits it |
| tool | `tool:<tool_use_id>` | the `tool_use` block is the open row; the result record repeats the whole row. History carries the raw `toolUseResult` of the result row, as the live frame does |
| tool image | `tool:<tool_use_id>:image:<index>` | |
| TodoWrite | `todo:<tool_use_id>` | rebuilt from the tool call, not live-only |
| compaction | `compaction:<status uuid>` | the loading status opens it, the boundary completes it; a turn that ends first fails it. The SDK read restarts at the boundary, so a compaction is one replacement at the next reopen |
| permission prompt, question, plan approval | `interaction:<request id>`, live-only | the transcript holds no record beyond the tool rows |

The tool result a row carries is `slimToolUseResult` of the native one (type, file path, patch hunks, image metadata, small scalars) in the live frame and in the transcript alike, so a transcript with whole files in its results restores far under the catalog's 32 MB cap; the transcript is read line by line and only those fields are kept. The `source_uuid` of a folded input was observed in Claude Code 2.1.319; an attachment without it (an older CLI) is restored under the attachment's own uuid, which costs one `changed` replacement per folded input. A compaction's summary row is dropped from a reread, as the live stream never shows it.

A reread lists its rows in the transcript's line order, the order Claude Code wrote them and the stream showed them. The SDK read follows the parent chain instead, which a tool that finishes while later blocks of its message still stream breaks: the next block links to that result, and the SDK appends the blocks that left the chain after the message's last chained row (the `parallel-edits` recording).

At a turn's end, a block that streamed and never got its record ends with an empty body. A user row a finished sub-agent wakes the session with is not shown, as in the stream.

## Interactions and controls

| Public interaction kind | Support |
| --- | --- |
| `tool_approval` | Once/deny/cancel. Session scope only when the full native suggestion group consists of allow-rule/directory additions, with destinations restricted to `session`. The card states the rule/directory scope. An explicit native ask rule remains once-only. |
| `question` | `AskUserQuestion`, unique questions/options, single/multiple answers, custom text and dismissal. |
| `plan_approval` | Actual `ExitPlanMode.plan`; approve-and-resume waits for native permission-mode confirmation. |
| `form` | Disabled: the pinned native MCP elicitation path loses constraints and sensitive markers. |
| `permission_approval` | Not advertised as a separate granular filesystem/network permission API. |
| `external_action` | Not advertised; no equivalent native callback mapping. |

Session permission updates are native rules, not a blanket adapter allow-list. A repeated ordinary shell command is verified to prompt once. Native path/safety checks may still prompt again for a command with redirection even after a suggested session grant. Grants never write persistent user/project settings and are not promised to survive Query restart.

The Host allows the adapter's supported permission modes (`default`, `acceptEdits`, `dontAsk`, `plan`, `bypassPermissions` labeled YOLO) while preserving workspace admission. YOLO removes permission prompts and runs without a sandbox: selecting it lifts the restricted native command sandbox, and any sandbox the user's or project's settings enable, through the native flag settings, after the mode is confirmed; leaving it restores the previous sandbox before the next mode applies. A managed policy sandbox still applies. Other modes keep the restricted sandbox, which confines shell commands, not file, MCP or web tools. The Host saves the mode each session's owner confirms, outside planning, and a session reopened after an idle release or a Controller restart resumes in it; a persistence handle that carries a mode takes precedence. Native policy rejection remains authoritative.

Before the first native init event, an unspecified model selects the native catalog's `default` option when advertised. No concrete model is guessed or pinned; native init replaces the selection with the reported model.

Idle model/permission changes, planning, discovered skills, interrupt, image input and bounded image resources use existing controls. Effort is selectable at creation only. Steer and next-turn delivery remain disabled: native priority input can outlive its target turn and survive interrupt. Direct children remain read-only; their approvals belong to the root Query.

## Ownership and recovery

- All authorized browser views and headless Remote clients share the Host-owned Query and its single observation stream. Opening, closing or reconnecting a page does not transfer native ownership or revoke another page's ability to operate.
- `agent-remote-controller session attach <address>` for a Claude session participates in the same profile-scoped lease as the Host. `--take-over` explicitly interrupts the old managed writer; the successor starts only after confirmed native process exit.
- Browser reconnect does not seize control back from the CLI. A transferred session requires explicit native takeover; every authorized page can use the restored Host-owned Query after synchronization.
- The cwd lookup uses native ID directly, independent of paged catalog discovery. Unknown cwd fails closed; it never silently resumes in the Controller's working directory.
- A failed shutdown retains its ownership lease. Handoff preserves the latest available persistence settings.
- Claude has no public external-session lock probe. Direct unmanaged `claude` processes, new CLI sessions without an explicit ID, and `resume --last` are outside this coordination. Use the wrapper with an explicit ID for managed handoff.
- macOS native SDK/CLI handoff and Chromium mobile Session View are validated with isolated profiles and a loopback Messages service. Windows process behavior and an online model service are not certified by those tests.

## Regression entry points

Build first. Set an absolute `AGENT_CLAUDE_TEST_EXECUTABLE` path so pnpm PATH resolution cannot select an older installation.

- `pnpm test:claude`: adapter units and real native lifecycle/history/controls/resources/children/diff/approval probes, with process and individual deadlines.
- `packages/agent-controller/src/claude-handoff.local.test.ts`: actual running SDK → CLI → SDK, same native ID and stale-writer rejection.
- `packages/agent-controller/src/stdio-directory.test.ts`: lease retention on failed exit and persistence settings across transfer.
- `packages/agent-remote-debugger/e2e/claude-session.spec.ts`: real Query → ARDB Relay → shared Session View, pending approval through disconnect, actual diff, reload deduplication and mobile width.
