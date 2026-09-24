# Copilot normalized event inventory

Audited on 2026-09-24 against this worktree's Provider SDK and Copilot adapter. The SDK is 1.0.11; the declared CLI package is 1.0.83, while the resolved executable used for native validation reports 1.0.84-5. This is a local implementation audit, not release or production acceptance.

The source of truth is [`observation.ts`](../../../packages/agent-provider-sdk/src/observation.ts), [`control.ts`](../../../packages/agent-provider-sdk/src/control.ts), and [`tool-result.ts`](../../../packages/agent-provider-sdk/src/tool-result.ts). A supported top-level event does not imply every optional field, interaction action, or native extension is supported.

Evidence labels below:

- **Native**: real SDK and stdio CLI against an isolated deterministic loopback model, usually through Relay TimelineStore/projector.
- **Unit**: adapter behavior with native event fixtures or mocked native control callbacks.
- **Inspection**: code/schema comparison; no positive runtime acceptance claim.
- **Browser**: the shared product Session View served through ARDB, using Chromium at 402 × 874. This is not iPhone hardware validation.

## All 11 AgentStreamEvent variants

| Event | Copilot mapping and limits | Evidence |
| --- | --- | --- |
| `thread_started` | Emitted after opening/resuming the root with its native session ID. Child views have their own runtime identity but do not emit this event on initialize. | Native lifecycle/resume; unit child tests |
| `turn_started` | First `assistant.turn_start` of a public interaction. Native numeric model-step IDs are not treated as globally unique turn IDs. Steering stays in the same interaction; queued input starts another. | Native queue/steering/child tests; projector tests |
| `turn_completed` | Live `assistant.idle`, queue interaction boundaries, and child task idle snapshots. History reconstructs terminal model steps using journal boundaries. Does not complete after every intermediate model step. Optional usage is sent separately. | Native live/resume and child tests |
| `turn_failed` | `session.error` and failed child tasks. Message is retained; optional public `code` and `diagnostic` are not populated. | Projector code; failure projection unit case |
| `turn_canceled` | Native `abort` and confirmed child cancellation. Main cancellation leaves child-owned prompts intact. Reason is generic, not the native abort detail. | Native root/child cancellation; unit tests |
| `timeline` | All eight item variants below have mappings. Tool metadata and history fidelity have the limits listed separately. | Native and unit tests |
| `usage_updated` | `assistant.usage` maps input/output/cache-read tokens; `session.usage_info` maps context used/limit. No inferred USD cost. | Unit projector tests |
| `runtime_updated` | Root open, model/effort, planning, permission confirmation and child-directory refresh publish snapshots. Read API supplies current foreground/waiting status. Native connection/retry telemetry and `activeTurnId` are not populated; child views expose runtime through `runtimeInfo()` rather than emitting root-style updates. | Native settings/plan; unit settings/children; connection limits by inspection |
| `interaction_requested` | Permission events plus identity-bound question, plan and elicitation callbacks. Five of six interaction kinds have mappings; see below. | Native approval/question/plan/form; URL unit test |
| `interaction_resolved` | Confirmed native completion or validated submitted callback response. Sensitive receipts are redacted. Submitted session grant survives completion racing the RPC response. | Native permissions/questions/forms; unit race tests |
| `interaction_invalidated` | Plan/form/URL callbacks that cease to be pending are invalidated rather than fabricated as user rejection. Question/tool cancellation uses the corresponding canceled/dismissed receipt. | Unit cancellation tests |

## All eight timeline item variants

| Item | Copilot mapping and limits | Evidence |
| --- | --- | --- |
| `user_message` | Native text/message ID; root blob image attachments reference session-owned resources. Binary assets restore saved images. Child views do not run the root image resource mapper. | Native image resume/resource test; unit image bounds |
| `assistant_message` | Incremental deltas, final unsent suffix, duplicate/late delta suppression. A non-prefix correction becomes a separate message instead of corrupting an append-only stream. | Native exact-once live/resume; projector tests |
| `reasoning` | Incremental reasoning and final suffix, without opaque reasoning data. Empty rows are suppressed. Cannot reconstruct reasoning omitted by the durable native journal. | Unit projector tests |
| `tool_call` | Start, bounded partial snapshots, completion/failure, original call identity. Diff mapping described below. Native `success:false` maps to failed; the adapter does not independently emit tool status `canceled`. | Native shell/child/diff tests; projector tests |
| `todo` | Serialized `plan.readSqlTodos` on open and `session.todos_changed`; changed snapshots and clear are emitted. Native historical todo snapshots are not invented from current SQL. `activeForm` is not mapped. | Native SQL todo test; unit serialized refresh/clear |
| `interaction` | Completed historical request/response pairs, with child approvals on the owning parent. Old pending callbacks are never reopened. Native permission journal records only approved/denied, so historical approval scope currently falls back to once; live JSONL retains observed scope. | Native resume; projector/provider tests |
| `error` | Failed compaction and unsupported/ambiguous interaction schemas become visible errors. Native `session.warning`, `session.info`, system notices and model retry diagnostics are not mapped. | Unit failure/ambiguity tests; ignored events by inspection |
| `compaction` | Start and successful completion; manual/auto trigger and pre-token count. Failure emits an error, never a false success. | Unit projector tests |

## All seven tool detail variants and result fields

| Detail | Current mapping | Audit result |
| --- | --- | --- |
| `shell` | Native `command` or `fullCommandText` | Implemented; command cwd is not retained |
| `read` | Native `path`, `file_path` or `fileName` | Implemented, but generic path-based classification can misclassify search tools with a path |
| `edit` | Path-bearing edit/patch tools; single-file freeform patch update/delete | Implemented; patch delete is a file-edit intention, with deletion kind in the completed result |
| `write` | Path-bearing write/create tools; single-file freeform patch add | Implemented |
| `search` | No dedicated query/pattern mapping | Adapter gap; native tool falls back to read/other |
| `fetch` | No dedicated URL mapping | Adapter gap; native tool falls back to other |
| `other` | Unknown native tools and multi-file patch summaries | Implemented; child session link metadata is not populated |

`apply_patch` input is a freeform patch string. Its file headers identify intent and the tool card's filename, including multi-file summaries. Completion reads native `detailedContent` with `content` fallback. Recognized Git unified diffs use the existing version-1 `file_changes` JSON format: added, modified, deleted and renamed files, original path on rename, and complete hunk text. Workspace-resolved argument paths recover absolute paths stripped by native Git-style headers. Parsing is display-only and never reads files.

Results preserve the native summary and structured JSON. Unknown/malformed diff formats remain raw detailed text, including the whole result if any file section cannot be interpreted. No proposed input patch is converted into an executed diff. All results use the existing 65,536-character / 128-block bound and retain its truncation marker. An oversized JSON result can degrade to bounded raw text, as in other providers.

| Result field/content | Status |
| --- | --- |
| Text, detailed text, structured JSON | Implemented; equal summary/detail text is not duplicated |
| `file_changes` JSON | Implemented; unit multi-file/rename/delete/fallback/bounds, native live/resume, shared mobile Browser |
| `exitCode` | Gap: native `contents` can include `shell_exit`/legacy `terminal`; not extracted |
| `durationMs` | Not populated; no confirmed native timing source mapped |
| `truncated` | Public bounding is implemented; native `outputTruncated` metadata is not propagated |
| Native `contents`, output images/audio/resources, citable sources/UI resources | Not normalized as dedicated outputs. Native textual summary or `structuredContent` may remain, but this is not media support. Public tool result content currently has only text/JSON variants. |
| File resource acquisition | Browser verification exposes a separate gap: shared resource discovery sees the tool filename, but Copilot's reader only accepts owned input images and current skill documents. A changed-file resource can show `Unknown Copilot resource` even while its diff renders correctly. File opening/download is not certified by the diff test. |

## All six interaction kinds

| Kind | Support and limits | Evidence |
| --- | --- | --- |
| `question` | Single choice and optional free text. SDK callback has no request ID; require a unique complete-payload match. Identical simultaneous unbound questions fail explicitly. No invented multi-select support. | Native question; unit ambiguity and ownership |
| `tool_approval` | Once/session only when native prompt permits it. Path and tool approval remain distinct. Managed policies can prevent session grants. No public policy-rule creation. | Native path/read/session and shell; mobile Browser |
| `plan_approval` | Exit-only → approve; interactive → approve-and-resume; rejection plus feedback. Autopilot actions are not substituted. | Native rejection; unit approval/cancel |
| `form` | Supported flat MCP schema with constraints, validation and sensitive receipt redaction. Unsupported schemas fail explicitly. | Native sensitive form roundtrip; unit variants |
| `permission_approval` | Not advertised. Native permission prompts use tool approvals; there is no verified equivalent of this SDK's standalone scoped permission grant. | Inspection |
| `external_action` | Validated HTTP(S) URL elicitation with completed/decline/cancel response. | Unit mapping/callback; native URL roundtrip not yet tested |

## Stream envelopes, usage and recovery

| Contract | Status |
| --- | --- |
| `observation` | Root/child events carry source keys, delivery and time; native projections also have increasing revisions. Local RPC-derived events use local source keys. |
| `history_boundary` | One boundary after root history; children read paginated native event logs before their boundary. |
| `timeline_replacement` | Not emitted. Native truncation/snapshot rewind/context clear are not normalized into timeline corrections; no public rewind control is advertised. These are gaps if exposed externally. |
| `inputTokens`, `outputTokens`, `cachedInputTokens` | Mapped from native usage; unit verified. |
| `contextWindowUsedTokens`, `contextWindowMaxTokens` | Mapped from native context usage; unit verified. |
| `totalCostUsd` | Intentionally absent: native cost/credits do not establish a USD amount. |
| Runtime cwd, model, effort, planning, tool policy, children, persistence | Implemented where native calls confirm them; settings become unavailable/unknown when not confirmed. Resumed tool policy has no supported getter. |
| Runtime native connection state/attempt/retry time | Not emitted by this stdio adapter. Relay/browser connection state is a separate boundary and must not be confused with it. |
| ARDB JSONL replay | Replays observed normalized events, including transient interactions. It does not recover fields already omitted by the adapter when recording. Native resume is a different path and cannot recreate omitted ephemeral journal entries. |

## Next priorities identified by this audit

1. Finish existing tool semantics: native shell exit/truncation metadata, explicit search/fetch details, and a defined acquisition policy for tool-referenced file resources. Do not equate a native file path with permission to read arbitrary host files.
2. Validate recovery failures and external native history mutations before claiming connection telemetry or timeline replacement support.
3. Decide product support for output media and native warnings/system notices before adding new normalized presentation behavior. Keep provider telemetry, hooks, OAuth plumbing, canvas and extensions out of ordinary conversation rows unless they have an explicit user-facing contract.

The `apply_patch` change is implemented here. The remaining gaps are audited findings, not claims that those features were implemented in this change.

## Validation for this change

- `pnpm test:copilot`: 79 tests across six files, including 11 real SDK/stdio CLI scenarios. Per-test deadlines are 10 seconds for units and 45 seconds for native scenarios; the root runner enforces 540 seconds overall.
- Shared `FileChanges.test.tsx`: three tests passed with a 10-second per-test deadline and a 60-second process deadline.
- `copilot-diff.spec.ts`: one mobile-size browser scenario passed through real SDK/CLI, ARDB Relay and the shared Session View, including page reload, a single tool card and no document horizontal overflow. Per-test deadline is 45 seconds; process/global deadlines are bounded. The screenshot also records the separate unavailable file-resource issue above.
- Repository typecheck, Copilot and ARDB builds, compatibility update/check, and whitespace checks passed.
- Read-only reprojection of the reported native plan journal confirmed that the denied patch has no file changes and the subsequent successful patch contains the actual 23 added lines in `plan.md`. No agent command was replayed or file rewritten by this verification.

These checks do not replace native iOS, Windows or production validation. Existing user debug sessions were not restarted; running processes keep their already-loaded adapter code until restarted or replaced explicitly.
