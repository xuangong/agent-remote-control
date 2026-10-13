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

A draggable Team button opens a list grouped by source session, including a collapsed archive section. New Team requires no prewritten requirements. Opening a Team closes the list and enters an inline Team workspace: source, Leader, members. Wide layouts scroll horizontally with adjustable pane widths; narrow layouts open the Leader directly with no horizontal multi-session layout; users can explicitly switch to a member. All panes reuse ordinary Session View behavior. Exit restores the regular workspace without stopping work. Team selection and bounded layout preferences survive refresh. Team controls remain available while a Team is open.

Each source, Leader, or member pane owns its subagent views as one contiguous family. Opening a subagent inserts an ordinary Session View immediately to the right of its parent, before the next Team participant. Nested subagents extend the same family; selecting a different child replaces that parent's displayed descendant branch. Closing a subagent view closes only that visible branch and never stops native work. Clicking a pane changes focus without collapsing its neighbors. Each pane remains independently resizable.

On narrow screens, a family displays its focused session with a back-to-parent control. Switching Team participants retains each family's focus, expanded path, and drafts. Expanded paths are stored per Team, participant, Host, Provider, and root session; refresh restores up to 24 descendants per family. Child attachment uses the existing parent-scoped directory API, with opening, failure, and retry displayed inside the child pane. The containing layout supplies navigation actions to the shared Session View; it does not navigate the hidden ordinary workspace or change Team membership.

## Implementation and acceptance

1. Public Team schemas and bounded state; protocol validation tests.
2. Relay membership, authorization, durable reservation and mailbox settlement; real uplink transport tests.
3. Controller session tools, persistence, idle dispatch and reconnect recovery; observable runtime tests.
4. Owner APIs and responsive Team workspace, grouped menu, archive/recovery controls; component and browser checks.
5. Compatibility metadata, type checks and regression review. Do not deploy or publish without a separate user request.

Acceptance covers source isolation, cross-Host registration, leader/member role restrictions, bidirectional messages, duplicate IDs and lost receipts, restart with uncertain native effects, archive races, standard Session View features, narrow layout, and retained ordinary dock layout.

## Usage

1. Open the source project session, open **Team**, and choose **New team**. Its Host must advertise Team support. The Leader starts in the source working directory, with a separate native conversation and a bounded source-history reader; this is not a provider-native fork.
2. Discuss the requirement with the Leader. Use **Add member** to select an online Host and provider. Supply that machine's working directory where needed. A name and initial responsibility can be supplied without predefining the complete solution.
3. Registration notifies the Leader. The Leader uses `read_team`, `describe_team_member`, `send_team_message`, and `report_team_progress`; members use the read, send, and progress tools. Messages are asynchronous tasks or replies, not synchronous remote shell calls.
4. On narrow screens, opening a Team opens only the Leader. The session selector can switch to a member or the source. On wide screens, resize pane dividers or scroll horizontally. Exit Team mode to return to the retained ordinary workspace.
5. Archive after delivery. Archive closes new claim admission and cancels unclaimed messages. Previously claimed native work may still start or finish. Native queued acceptance, unknown delivery, and unavailable members keep archiving pending. Restore never replays canceled messages.

## Recovery and limits

The communication journal is an operation record, not a complete copy of session history. It retains up to 200 messages / 128 KiB per Team; the account supports 32 Teams and 12 seats per Team, including the Leader and abandoned slots, within a 2 MiB total state limit. These are explicit capacity errors, not silent eviction; archiving does not free identity or deduplication records. Controllers retain up to 384 local seats. Automatic compaction and permanent Team deletion are not included.

Successful SDK submission records acceptance without inventing a native started/queued disposition. An explicit queued disposition blocks final archive until a later native receipt or explicit user resolution. Completion and validation remain separate, evidence-backed statements from the workers. Unknown dispatch is never automatically resent, including after Controller restart. Inspect the receiving session before confirming received / not executed in Delivery status.

Check creation reconciles the same reserved slot with the Controller's saved result. If the Controller lost the native identity after starting creation, automatic recreation would risk duplication: inspect native sessions first, abandon the uncertain slot, and create a replacement explicitly. Abandoning a slot does not terminate an unidentified native process.

Provider tools are supplied through the existing SDK extension contract, retaining each Host's native permissions and environment. Team membership does not share files, credentials, or working directories across machines. The source reference records the selected native session; automatic migration of Team sources/members through session succession is outside this change. Teams use task/reply delivery independently of an open browser; they do not add a model heartbeat or a TPM-style managed workflow.

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

Use `/team` or **View → Team view** to toggle the Team entry and workspace. Explicit `/team on`, `/team off`, `/team enable`, and `/team disable` are supported. The preference is saved locally and defaults to visible. Hiding the view restores the ordinary workspace without ending Team work, archiving it, or discarding the selected Team, pane state, or drafts. Showing it again restores the selected Team.
