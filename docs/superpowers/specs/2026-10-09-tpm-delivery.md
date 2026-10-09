# TPM Delivery Sessions

Status: implemented with regression coverage. Native provider acceptance limits are documented in ../../tpm-delivery.md. Not deployed.
Baseline: `main@3a853aa`.

## Purpose and scope

A TPM is a persistent agent session accountable for one work item, from understanding the user's need through delivery and acceptance. It helps the user reason about requirements, alternatives, constraints, and tradeoffs. It maintains the agreed specification, coordinates implementation with a main session, checks evidence, and communicates progress. It does not implement product code.

One main session may serve several TPMs and unrelated user work. A main session becoming idle is not evidence that any particular TPM work item is complete. A TPM's native execution state and its work item's delivery state are separate facts.

The first release supports a TPM and its main session on the same Controller. It aggregates work items from authorized Controllers into a global browser list. Cross-Controller orchestration, automatic task reprioritization, and a general-purpose workflow builder are outside this release. Codex, Claude Code, and Copilot are target providers, gated by verified adapter capabilities; unsupported providers must not receive a misleading creation action.

## Agreed experience

- A global floating TPM entry opens a compact list, similar to Track view.
- TPM view visibility follows Track view: `/tpm` toggles it, and `/tpm on`, `/tpm off`, `/tpm enable`, and `/tpm disable` set it explicitly. The View menu exposes the same setting.
- Without a saved preference, TPM view is visible on mobile/coarse-pointer devices and hidden on desktop, using the same device classification as Track. Persist the user's explicit choice independently of Track visibility.
- Disabling TPM view hides its entry, list, and workspace only. It preserves work records, drafts, background leases, event subscriptions, and heartbeat scheduling. Re-enabling restores access to existing work without creating or restarting TPM sessions. View visibility never changes work pause/resume state.
- Each row represents a work item: title, delivery state, unread activity, and a needs-user indicator. Rows open the TPM workspace; they do not imply implementation-session focus.
- The workspace resembles Ask: a resizable desktop dialog and a small-screen overlay, rendering the normal Session View and full chatbox.
- The workspace defaults to conversation and offers a secondary Plan & acceptance document view plus navigation to the related main session. Pause, resume, and check-now are internal diagnostic operations, not end-user controls. Background scheduling is the TPM responsibility. Closing, minimizing, navigating, or disconnecting a browser never pauses the work item.
- Returning to a work item restores its draft and reading position using existing session-view behavior. Browser persistence owns presentation only.
- A TPM can explain that it is waiting, ask for a decision, report a blocker, or present acceptance evidence. Heartbeats without a meaningful change do not create user notifications.
- The list remains available when the user switches the main view. Association with the currently displayed session is a presentation hint, not the scope of the list.

## Role and authority

The role is assembled from appended provider-native instructions, an English workflow guide, and Host-bound tools. Preserve native instructions and policy. Do not replace the entire Claude default prompt to add the TPM role.

The workflow covers clarification, specification, implementation coordination, validation, and reporting. Small tasks may use a short specification; there is no mandatory long-form document ceremony. Every work item records its goal, scope, current decisions, open questions, and acceptance criteria.

The TPM distinguishes discussion from implementation requests. It may ask the main session to investigate feasibility while the user is still exploring. Once the user has authorized the work's scope, routine coordination within that scope does not require approval of every message. New scope, conflicting priorities, and consequential unresolved choices return to the user.

The role does not grant permission to approve native tool requests, cancel main-session work, change its model or policy, take over an external CLI, or reorder other TPMs' requests. Native permissions and Host workspace checks remain authoritative. Initial tools allow reading the bound session, sending normal messages, managing the TPM's own specification, recording work progress, and scheduling checks. They do not expose arbitrary filesystem writes or shell execution as TPM application capabilities.

Role instructions prohibit implementing product code. That behavioral instruction is not itself a security boundary. Any advertised read-only enforcement must also be backed by the provider's actual tool/sandbox policy.

## Existing foundations and verified gaps

| Area | Existing source | Required work |
| --- | --- | --- |
| Source-session reads | `packages/agent-host/src/session-reference.ts` | Reuse the bound-reference concept; provide access through the common manager for all target providers |
| Host lifetime and leases | `packages/agent-host/src/host.ts`, `idle-sessions.ts` | Add durable background demand independent of uplink/browser subscribers |
| One native observation | `packages/agent-remote-relay/src/agent-manager.ts` | Subscribe to projected events; do not consume `AgentSession.observe()` a second time |
| Settlement | `packages/agent-remote-relay/src/session-wire.ts`, `operation-cache.ts` | Reuse operation admission and settlement for local sends; separately persist workflow intent |
| Provider creation | `packages/agent-provider-sdk/src/provider.ts` | Existing extensions include `systemPrompt` and tools; add explicit supported capability semantics |
| Codex | `packages/agent-provider-codex/src/session.ts` | Existing developer instructions and dynamic tools are reusable with native compatibility checks |
| Claude | `packages/agent-provider-claude/src/provider.ts`, `session.ts` | Append role instructions, bridge Host tools, and rebind extensions on resume |
| Copilot | `packages/agent-provider-copilot/src/provider.ts`, `session.ts` | Bind Host tools; preserve/rebind role config on resume instead of resuming with only cwd |
| Stdio lifetime | `packages/agent-host/src/stdio-directory.ts` | Preserve shared Host ownership; never spawn a second owner for a background observer |
| Workspace UI | `packages/agent-remote-lab/src/components/AskConversation.tsx` | Reuse Session View and extract a small common floating shell where needed |
| Attention UI | `packages/agent-remote-lab/src/components/SessionTrackingMenu.tsx` | Reuse interaction patterns; do not store work lifecycle in Track state |

Existing Side creation is an independent conversation with a source reference. A TPM uses this association model; a native history fork is optional, not required. Copying a snapshot does not provide subsequent synchronization.

## Boundaries

1. Provider adapters interpret native runtime state, tool callbacks, instruction configuration, input acceptance, and recovery. They contain no TPM-specific task state.
2. The public session layer owns observation, history, resource references, operation availability, and settlement. Headless clients and browser clients consume the same semantics.
3. A Controller-owned delivery coordinator owns work records, artifacts, timers, wake requests, and scoped session bindings. It is a consumer of the public session layer, not a new provider.
4. Relay transports authorized work-management requests and catalog updates. It is not the scheduler or the source of work progress.
5. Product UI owns the global list and floating workspace. The conversation uses the existing Remote client, replica, and Session View. ARDB uses the same management contract for headless verification.

Only genuinely reused primitives, such as local session attachment and event selection, belong in the common session layer. TPM workflow, work documents, and list organization belong in the delivery feature. Native ownership remains an adapter/Host concern.

## Durable work record

Store records under a versioned directory within the Controller state root, not inside the project checkout or browser storage. Use atomic updates and revision checks. A work item contains:

- Stable work ID, owning Controller identity, title, and timestamps.
- Bound main and TPM provider/native-session identities and persistence handles where required. Relay agent IDs are resolved bindings, not durable native identity.
- Delivery phase: `clarifying`, `ready`, `implementing`, `validating`, or `completed`.
- Waiting reason: `none`, `user`, or `main_session`; a concise reason and next action.
- Explicit `paused` state controlled by the user.
- Specification revision, structured acceptance criteria, and evidence references.
- Scheduling policy, next check time, last completed review, and pending wake reasons.
- History epoch/cursor plus bounded stable message identities used to reconcile replay.
- Bounded outbox entries, receipt/evidence references, and unresolved operation outcomes.
- Diagnostic health independently of delivery phase: recovery, unavailable provider, denied access, or uncertain operation.

Do not derive phase by parsing natural-language messages. The TPM reports its work assessment through a validated tool and cites the relevant evidence. Native status is displayed separately and never rewritten by that assessment.

Work artifacts are versioned Markdown stored with the work item. Updating a document requires its expected revision. The main session must receive the relevant specification revision/content or a readable resource reference; a Host-local pathname alone is not a portable document handoff. Copying a PRD into a repository is implementation work explicitly delegated to the main session.

## Bound tools

Tools are issued by the Host, scoped to one work ID and its bound main session. The model cannot supply a replacement session ID or an arbitrary destination path.

| Tool | Contract |
| --- | --- |
| `read_main_session` | Read bounded, paginated history or search it, plus current authoritative runtime facts; report truncation, cursor reset, and unavailable history explicitly |
| `send_main_message` | Persist a work-scoped intent and submit normal queued input when admitted; return acceptance/settlement, never claim completion |
| `read_work` | Return the current specification, criteria, phase, pending communication, and next scheduled check |
| `update_work` | Revision-checked updates to progress, evidence, questions, and next action; no user-pause override |
| `write_work_document` | Revision-checked update of this work's PRD/spec/acceptance notes only |
| `schedule_check` | Persist a bounded future deadline and reason; cannot disable the mandatory heartbeat for unfinished work |

The main session receives a readable work ID, specification revision, message purpose (`consultation`, `implementation`, or `acceptance_feedback`), and requested response. Existing communication rendering should expose the exchange where its semantics fit. A sent marker is not proof that the main session acted.

A first release can observe the main session's replies in its normal content stream. Adding a native reply tool to an already-running main session is not a prerequisite. When a reply's work attribution is ambiguous, the TPM asks for clarification rather than associating unrelated output automatically.

## Content-driven wakeups

Consume normalized manager events after projection. Trigger on completed or committed user/assistant content and material transitions to failure, waiting for input, or run completion. Reuse the semantic selector behind content-visible attention where practical, including resource-bearing messages. Do not trigger for every token, tool-output fragment, usage update, or history pagination operation.

Relatedness has two stages: explicit work/message correlation cheaply identifies known replies; otherwise relevant visible-content changes mark the bound work dirty and the TPM assesses their relevance. No deterministic claim is made that arbitrary main-session prose can be assigned to exactly one task.

Coalesce events over a short window, record the latest pending watermark, and permit at most one active review per TPM. Advance the consumed watermark only after the review has been processed; merely accepting a wake input is insufficient. Events arriving during a review remain pending.

Ignore known echoes of TPM-originated messages as independent triggers. Their replies may trigger a review. Use explicit message/operation identities when available; do not depend on fuzzy text equality. Impose a per-work wake rate bound to stop rapid response loops, and retain the pending watermark for the next review.

## Heartbeat and scheduled checks

Initial implementation defaults, configurable within bounded Host policy:

- Five-minute heartbeat for unfinished, unpaused work that is not waiting on the user.
- Thirty-minute heartbeat while waiting on the user; unchanged questions do not generate repeated notifications.
- Event coalescing window of two seconds and a minimum thirty-second interval between automatic review starts for the same work.
- A TPM-requested check may bring the next review forward, but not before the minimum automatic interval. Add small jitter across work items.
- A bounded global concurrency of two automatic TPM reviews per Controller; queued reviews are served fairly.

These are proposed defaults, not native provider guarantees. The scheduler records wall-clock due times durably and uses bounded monotonic timers while running. A clock jump or long sleep results in one catch-up check, not a replay of every missed tick.

Each heartbeat asks the TPM to inspect its objective, accepted scope, evidence, pending messages, waiting reason, and next action. The result is action, justified waiting with a next check, a request for user input, or an evidence-backed completion assessment.

Busy TPMs receive one pending review; no concurrent turn is forced. User messages retain their normal interaction behavior. A completed work item stops automatic checks. Explicit user resume/reopen reactivates it; late main-session events do not silently reopen completed work. Pause prevents new dispatch immediately and allows an already-dispatched action to settle; pausing is not a disguised cancellation.

Runtime health checks are separate from model reflection. Lack of visible output alone is not proof of a hung process. Use adapter-confirmed state and bounded read deadlines; never kill shared main-session work solely because a heartbeat is overdue.

## Queueing, settlement, and recovery

Normal TPM messages do not interrupt ongoing main-session work. Use native `next_turn` only when the public capability and admission state permit it. Otherwise hold the intent on the Host until normal input is admissible. Scheduling is fair across work items; TPM does not set user task priority implicitly.

Write each outbound intent before dispatch, using a stable operation ID. Within a process, use the common settlement implementation. Record accepted, rejected, and unknown outcomes distinctly. Acceptance (`started`, `queued`, `handled`, or unspecified) is not delivery completion.

After a crash between dispatch and receipt persistence, an operation is uncertain. Do not automatically resend it using either a fresh ID or an ID whose in-memory cache was lost. Reconcile using authoritative native evidence where available; otherwise expose the uncertainty for explicit resolution. Apply this rule to initial TPM creation and heartbeat input as well as messages to the main session.

Durable workflow intent does not create exactly-once native execution. Creation uses a persisted intent and records a returned native identity immediately; a lost creation receipt must not produce a second TPM automatically.

On Controller start, load valid work records, acquire the existing session bindings, rebind native tools and instructions, subscribe, reconcile history, and schedule one overdue review. Preserve user pause/completion. A history epoch change forces reconciliation; it does not reset operation identity or classify every replayed message as new.

Unread/notification state is separate from scheduler consumption. Reading a workspace does not acknowledge a pending operation. The browser may be closed throughout this process.

## Lifetime and connectivity

Unfinished work retains explicit background leases for the required main and TPM managers. A shared main manager has reference-counted leases, not one native process per TPM. The last browser disconnect cannot release these leases.

When paused or complete, release background leases safely, respecting native busy state and any browser/other-TPM demand. A user takeover to an unmanaged CLI suspends affected automation with a visible reason; TPM never silently takes it back.

Relay disconnection does not stop same-Controller coordination. Model network availability and local machine sleep remain physical execution limits. Persist due checks and resume conservatively when services return. Controller update admission must account for active TPM callbacks/reviews and persist pending work before shutdown.

## Public API and compatibility

Expose capability-negotiated work catalog/create/read/update/actions through authorized Host control routing. All mutations carry operation identity; edits carry expected revision. Apply the same account/Host access boundaries as existing session operations. Do not introduce an account system into ARDB or the standalone workbench.

The API includes work creation, list/read, pause/resume/reopen, explicit check-now, document reads, and resolution of uncertain delivery. Conversation input continues through the existing session protocol. The UI must not send raw provider callbacks or executable hook definitions.

Update public schemas, protocol fixtures, replay support, and compatibility metadata together. An older Controller presents TPM as unavailable while normal sessions continue working. No silent fallback to browser-owned automation is allowed.

## Acceptance evidence

1. Create a TPM, close every browser connection, emit main-session content, and observe one automatic review plus a recorded result.
2. With no new main content, advance the test clock past heartbeat and verify a review; while busy, verify coalescing without interruption.
3. Deliver a burst of streaming deltas and a final resource-bearing message; only the eligible committed content produces a coalesced wake.
4. Restart the Controller after intent persistence, after native dispatch, and after receipt persistence; verify the distinct outcomes without duplicate native effects.
5. Disconnect/reconnect the uplink while both native sessions remain local; keep one observation and continue local coordination.
6. Attach two TPMs and two browsers to one main session; verify one manager/native observation, independent work progress, fair sends, and lease release.
7. Let the main session complete unrelated work; no TPM is marked complete without its own evidence.
8. Pause a work item, deliver late events and restart; no new automatic send. Reopen a completed item explicitly and verify scheduling resumes.
9. For Codex, Claude, and Copilot, verify role instructions, callable tools, workspace policy, and resume reattachment using isolated native sessions.
10. In desktop and mobile browsers, open the global list, select a work item, interact with the ordinary chatbox, minimize/reopen, and verify draft/position continuity.
11. Exercise authorization failure, provider disablement, CLI ownership transfer, revision conflict, inaccessible artifacts, and an old Controller; display truthful recoverable states.
12. Use ARDB plus real transport tests to cover event handoff, operation receipts, replayed history, and closed-browser execution. Native smoke tests are separate from mocked adapter tests.
13. Verify mobile/desktop visibility defaults, persisted overrides, all `/tpm` command forms, and the View-menu toggle. Disable TPM view during active work, verify background event/heartbeat execution continues, then re-enable and reopen the same work with its draft intact. Track visibility remains independent.

## Delivery sequence

1. Normalize instruction/tool extension creation and resume capabilities across target adapters.
2. Add work records, scoped artifacts, and durable operation intent with explicit uncertainty.
3. Implement local session binding/leases and work-scoped query/send tools.
4. Add content subscription, heartbeat, scheduling, restart recovery, and health reporting.
5. Expose Host work management to product and ARDB through the public authorized route.
6. Build the TPM list and reusable floating Session View workspace.
7. Complete fault-injection, native-provider, and browser validation; then update compatibility metadata and package validation.

Do not advertise the feature as complete until closed-browser execution, recovery, all advertised providers, and the workspace interaction are validated. Merge, deployment, and Controller publishing remain separate user-authorized delivery steps.

## Composable execution companions

TPM uses the standard session todo and heartbeat toolkits described in [Session companions](../../session-companions.md). The Host enforces ordered progress and explicit revision-bound user confirmation. The model may revise only unfinished steps at boundaries; approved-plan changes require renewed consent. Native status remains adapter-owned, and the ordinary Session View renders the optional checklist. There is no generic workflow graph or new chat type.
