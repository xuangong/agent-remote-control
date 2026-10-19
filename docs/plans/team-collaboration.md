# Team collaboration

## Requirements and boundaries

A Team isolates finite collaboration from its long-lived source session. Creating a Team creates one Leader on the source Host, with the same working directory. The Leader is an executing worker: it discusses requirements, reads and changes code, delegates, validates, and reports to the user. It does not rely on the source agent to implement work. The source session receives neither membership tools nor automatic messages.

Members are ordinary provider sessions on explicitly selected Hosts and working directories. They register with the Team and receive tasks from the Leader. Their responsibilities, environment, permitted work, expected evidence, and dependencies are established during the Leader/user conversation and recorded with membership. Host identity alone is not a role. Members communicate with the Leader; they cannot create members, redirect operations outside the Team, or silently elevate native permissions.

TPM remains unchanged. Team uses the existing provider tool-extension abstraction, native session managers, operation settlement, and standard Session Views. Provider adapters continue to own native interpretation.

## Architecture

The Relay stores Team membership and a bounded durable communication journal. Browser-authenticated owner actions create Teams and authorize member Hosts. Registered Controller sockets authenticate subsequent Team calls. Every call is checked against its exact Team/member/Host binding. Model-visible tools never receive account credentials. Standalone Relay storage remains process-local unless configured with persistence.

Controllers persist local Team session bindings and delivery receipts, restore tool extensions on resume, and consume pending messages independently of browsers. Native dispatch uses the existing operation executor. Durable dispatching records recover as unknown; reconnect must never re-execute uncertain native input. Operation identities are sender-scoped and immutable. Acceptance is not task completion; members explicitly report progress, blocked, or completed outcomes with evidence.

Creation reserves a durable slot before native effects. Retrying uses the same slot and must not create another native session. Unknown creation is visible and requires explicit reconciliation. No arbitrary existing session is silently adopted.

Archive first closes dispatch admission and cancels messages not yet claimed. In-flight work is allowed to settle; unavailable members and unknown outcomes keep the Team visibly archiving. No new messages are claimed after archive admission; previously admitted native calls may still settle. Restore does not replay canceled messages. Model tools cannot archive the Team or grant membership.

## Presentation

A draggable Team button opens a management list grouped by source session, including archived Teams. Creation requires no prewritten requirements. Rename, archive/restore, member creation/recovery, responsibility and delivery reconciliation belong to this list. Add member opens a modal dialog using the same interaction pattern as session rename; failed submission keeps its fields and operation identity for explicit retry.

Opening a Team applies a preset to the ordinary workspace. On wide screens it selects the Team source as the actual main session and opens the Leader followed by ready members as ordinary docked session windows. Existing docks are retained; native session identity deduplicates repeated opens. Member windows carry a layout close-with relation to their Leader: closing the Leader closes those member windows and their visible descendants, retaining the main and unrelated docks. Closing one member affects only its own window. This is a presentation operation, not archive, native cancellation or membership removal. There is no separate Team workspace, exit mode, hidden background main session, or Team-only chat renderer. Changing the main through favorites, tracking or discovery leaves independent docks in place. On narrow screens opening a Team selects the Leader as the ordinary main session; other members can be opened from the Team list. No horizontal multi-session mode is imposed on narrow screens.

Every session view owns its subagent views as one contiguous family. Opening a subagent inserts an ordinary Session View immediately to its parent's right, before the next independent dock. Nested children extend the family; choosing a sibling replaces that parent's visible descendant branch. Closing a child closes only that branch without stopping native work. Focus changes never collapse neighboring views. Dock movement and floating move the entire family; descendants are not independent sortable docks. Root and descendant widths remain adjustable.

Window identities, placement, order, widths, visible child paths and focus are workspace presentation state, not Team state. Refresh restores them through scoped conversation storage. Team view visibility toggles only its management entry; hiding it, closing a dock or archiving a Team does not impose extra restrictions on ordinary session controls. A preset is applied on explicit open, not continuously enforced by polling Team state. Pending or unknown member creation stays visible in the manager until the user reconciles it; it never creates a speculative session pane.

The Leader's **Gather** action reads the current Team roster and opens missing ready member windows, including members added since the layout opened. It retains existing window positions, floating/docked placement, drafts and the current main session. Closing a member never removes membership; the management list remains the authoritative roster. A failed roster read opens nothing and allows retry; unavailable native sessions retain ordinary opening/retry behavior. Closing the Leader also prevents an outstanding Gather response from reopening the group.

## Implementation and acceptance

1. Public Team schemas and bounded state; protocol validation tests.
2. Relay membership, authorization, durable reservation and mailbox settlement; real uplink transport tests.
3. Controller session tools, persistence, capability-based timely dispatch and reconnect recovery; observable runtime tests.
4. Owner APIs and responsive Team workspace, grouped menu, archive/recovery controls; component and browser checks.
5. Compatibility metadata, type checks and regression review. Do not deploy or publish without a separate user request.

Acceptance covers source isolation, cross-Host registration, leader/member role restrictions, bidirectional messages, duplicate IDs and lost receipts, restart with uncertain native effects, archive races, standard Session View features, narrow layout, and retained ordinary dock layout.

## Usage

1. Open the source project session, open **Team**, and choose **New team**. Its Host must advertise Team support. The Leader starts in the source working directory, with a separate native conversation and a bounded source-history reader; this is not a provider-native fork.
2. Discuss the requirement with the Leader. Use **Add member** to select an online Host and provider. Supply that machine's working directory where needed. A name and initial responsibility can be supplied without predefining the complete solution.
3. Registration notifies the Leader. The Leader uses `read_team`, `acknowledge_team_messages`, `describe_team_member`, `send_team_message`, and `report_team_progress`; members use the read, acknowledge, send, and progress tools. Messages are asynchronous tasks or replies, not synchronous remote shell calls. Read returns bounded pages of complete incoming messages; acknowledging fully read messages confirms receipt without waiting for task completion.
4. On narrow screens, opening a Team opens only the Leader. The session selector can switch to a member or the source. On wide screens, resize pane dividers or scroll horizontally. Exit Team mode to return to the retained ordinary workspace.
5. Archive after delivery. Archive closes new claim admission and cancels unclaimed messages. Previously claimed native work may still start or finish. Native queued acceptance, unknown delivery, and unavailable members keep archiving pending. Restore never replays canceled messages.

## Recovery and limits

The communication queue is an operation record, not a complete copy of session history. It retains up to 200 unresolved messages / 128 KiB of stable input fields per Team; the account supports 32 Teams and 12 seats per Team, including the Leader and abandoned slots, within a 2 MiB total state limit. These are explicit capacity errors, not silent eviction of pending work. Settlement compacts bodies into bounded retry receipts; archiving does not delete Team identities or resource grants. Controllers retain up to 384 local seats. Permanent Team deletion is not included.

Successful SDK submission records acceptance without inventing a native started/queued disposition. An explicit queued disposition blocks final archive until a later native receipt or explicit user resolution. Completion and validation remain separate, evidence-backed statements from the workers. Unknown dispatch is never automatically resent, including after Controller restart. Inspect the receiving session before confirming received / not executed in Delivery status.

Check creation reconciles the same reserved slot with the Controller's saved result. If the Controller lost the native identity after starting creation, automatic recreation would risk duplication: inspect native sessions first, abandon the uncertain slot, and create a replacement explicitly. Abandoning a slot does not terminate an unidentified native process.

Provider tools are supplied through the existing SDK extension contract, retaining each Host's native permissions and environment. Team membership alone does not share files, credentials, or working directories across machines. Explicit [Team resource transfers](../guides/team-resources.md) upload files, attach authorized references, and download verified local copies. The source reference records the selected native session; automatic migration of Team sources/members through session succession is outside this change. Teams use task/reply delivery independently of an open browser; they do not add a model heartbeat or a TPM-style managed workflow.

Relay and Controller must both support Team. Capability negotiation uses the `team=1` uplink query and a `teamManagement` registration acknowledgement, so an updated Controller can remain connected to an older Relay without issuing Team calls. Deploying this feature requires web/Relay deployment and a Controller update on participating Hosts.

## Verification

- Protocol codec checks cover Team calls, bounded payloads and allowed create-seat RPCs; old/new Relay capability negotiation has real WebSocket coverage.
- Two real Controller uplinks and an HTTP Relay, with deterministic native SDK fixtures, cover source isolation, registration, bidirectional messages, duplicate requests, SDK void success, queued receipts, lost native receipts, Controller restart without replay, explicit reconciliation and archive settlement.
- Cloudflare Worker tests cover owner isolation and durable membership across Worker restart.
- Component tests cover source grouping, archived grouping, ordinary Session View reuse, Leader-only mobile attachment, and retained mutation errors.
- Chromium and WebKit, desktop and mobile: Team entry, resizing, narrow navigation, draft retention and refresh pass. Existing workspace tests verify main/Side navigation and independent docks; desktop-only dock tests are intentionally skipped on mobile.
- Controller and Lab type checks, dependency/web builds, and compatibility update/check pass. No installed Controller or production service was replaced.
- These tests validate SDK integration and real transport behavior, not real Codex/Claude Code/Copilot/OpenCode task execution on remote machines. A live-provider smoke test remains a release verification step.

## Team presentation preference

Use `/team` or **View → Team view** to toggle the Team management entry. Explicit `/team on`, `/team off`, `/team enable`, and `/team disable` are supported. The preference is saved locally and defaults to visible. Existing main/dock sessions remain visible and usable regardless of the management entry's visibility.

## Delivery queue settlement

`Team.messages` is the unresolved delivery queue, not the communication archive. Accepted input leaves it once it is no longer reported as queued; explicit rejection and cancellation also leave it. Unknown effects remain for reconciliation. Settlement atomically removes the body and stores a bounded Relay-only fingerprint/outcome receipt. Restoring existing state compacts legacy settled messages. Attachment recipient grants are independent of queue lifetime. See [Team resources](../guides/team-resources.md#limits-and-retention) for retry-window and capacity semantics. Public Team schemas and existing Controller polling remain compatible.

Running sessions no longer wait unconditionally for idle. Controllers select immediate delivery when native steer is available, otherwise next-turn delivery when queuing is available. An active turn waiting for a question or approval can also receive input through these capabilities; delivery does not resolve the pending interaction. Pending interactions without an active turn still wait. Native interpretation stays in adapters. Codex confirms queue admission from its steer response and consumption from the correlated native user-message event, rather than inferring consumption from turn completion.

`read_team` is still a query. The agent-facing projection exposes only complete incoming bodies plus compact outgoing status and receipts; internal Controller reconciliation retains the full read response. `acknowledge_team_messages` is a separate, exact-recipient-bound receipt operation. It validates the full batch before consumption and cannot clear a claimed or unknown native delivery. A successful acknowledgement prevents a stale poll from claiming the same body. This closes the read-then-later-inject duplication path without claiming exactly-once delivery across the read/claim race. The additive acknowledgement call requires the negotiated `teamInbox` capability; deploy Relay first and update Controllers on participating Hosts.
