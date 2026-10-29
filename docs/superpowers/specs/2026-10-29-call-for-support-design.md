# Call For Support

Status: design approved in conversation on 2026-10-29. The target is the complete feature below; milestones order the work but none of them is a stopping point. Gating experiments were run before this revision (see "Evidence").

## Purpose

A worker session should be able to obtain help it cannot provide itself: a stronger or independent model, another provider, another machine, another environment. The worker states what kind of support it needs. A support coordinator decides which sessions and resources provide it, runs them, and returns one curated report. The worker never manages the supporters and never sees how the support was organized.

The motivating case: a Codex worker on a medium model writes code and prepares a pull request. Before the pull request it calls for a code review. The coordinator brings in two reviewers on different providers and stronger models (a stronger Codex model and Claude Opus at maximum effort), both reading the worker's workspace without changing it. It merges their findings into one report for the worker, which fixes the code and calls again on the same review role, until the reviewers have no blocking findings.

## Principles

1. **Encapsulation.** The worker sees a contract: a call (what it needs) and a report (what came back). Rosters, models, hosts, retries, disagreements and partial failures stay with the coordinator. What the worker does not know cannot pollute its context.
2. **Least context downward.** The coordinator briefs each supporter with what that supporter needs, not the worker's whole conversation. Only the coordinator holds the full picture.
3. **Visible to the user, encapsulated for agents.** The user sees profiles, rosters, proposals, progress, usage and decisions in the website and can intervene. The worker loses direct control; the user keeps it.
4. **The worker is the only writer of its workspace.** Supporters read it, or write their own worktree. Code a supporter produces comes back as a patch for the worker to apply.
5. **Reports are advice.** A report is labeled with its call and role. The worker decides what to adopt. Conflicts go to the user.
6. **The system enforces the mandate.** Which providers, models, hosts, workspaces, permissions, how many supporters and how much usage a coordinator may use is checked by the Relay and Controller, never only stated in a prompt. A call comes from a model, and so does every coordinator decision; either may be steered by content in the repository.
7. **Context is kept, not rebuilt.** The same worker and role always reach the same coordinator. Coordinators and supporters are native sessions that are resumed, not recreated. Their key state is also kept outside the conversation.

## Terminology

| Term | Meaning |
|---|---|
| Call For Support | The mechanism. Code identifiers use the full prefix (`callForSupport`, `CallForSupport…`, `call-for-support`), never a bare `support`, which the codebase uses for capability checks such as `supports(...)`. |
| Worker (requester) | The session that calls. It owns its task and workspace. |
| Support call | One request: role, task, context, deliverable, optional follow-up of an earlier call. |
| Support profile | A user-defined, reusable kind of support: name, description, mandate, coordinator configuration. Stored per account. |
| Support group | Everything serving one worker and one role: the coordinator, the supporters, the calls, the ledger. Its ID is the `roleId`. |
| Support coordinator | The AI session that organizes a support group and writes reports. |
| Supporter | A session working for the coordinator. |
| Support report | The coordinator's answer to one call. |
| Mandate | The bounds of a group: allowed supporter configurations, hosts and workspaces, access, count, usage budget, approval mode. |
| Roster proposal | The coordinator's structured plan for which supporters to create. |
| Ledger | The coordinator's durable, structured state for the role: calls, reviewed commits, findings and their status. |

## Scope

The complete feature:

1. **Profiles.** The user defines support profiles in Settings (for example "Cross review", "Opus consultant", "Linux tester"), each with a description, a mandate and a coordinator configuration.
2. **Calls from the website.** The user calls for support on any session: an existing role of that session, or a new role from a profile, with a task and optional follow-up.
3. **Calls from the worker.** A session for which the user enabled Call For Support can call itself with the `call_for_support` tool, list its roles and calls, read reports and download delivered patches. The tool is injected after creation: Claude through `setMcpServers` on the live session; Codex through a tool namespace declared at every thread start, deferred and found with `tool_search` when the session is enabled later, direct when it is enabled at thread start.
4. **Enablement.** Call For Support is off for every session until the user enables it for that session, or a profile's default enables it. The website suggests enabling it for sessions that edit files in a git repository; it never enables it by itself.
5. **Groups on Team.** One support group per worker and role, built on Team (see "Built on Team"). Follow-up calls reach the same coordinator and supporters with their context and the ledger.
6. **Rosters.** The coordinator proposes rosters. The Relay validates them against the mandate. Depending on the mandate's approval mode, the user approves every roster, or valid rosters are provisioned at once and only rosters outside the mandate wait for the user.
7. **Supporters.** Created with the chosen provider, model and reasoning effort, in one of three workspaces: `shared` (the worker's directory on the worker's host, read-only), `worktree` (an own worktree at the call's commit on the worker's host, writable) or `remote` (an own worktree at the call's commit on another host). Read-only is enforced natively.
8. **Reports.** The coordinator merges supporters' results into a structured report: status, summary, findings with severity, location, problem, suggestion and agreement, and attached resources (patches, test logs). Reports reach the worker as queued input without interrupting a running turn. Details are read on demand.
9. **Scaling.** The coordinator can release supporters and propose new ones during a call, within the mandate.
10. **Usage.** Each group's usage is accounted per session from provider usage reports. The mandate can bound tokens per call and in total, and cost where providers report it. Reaching a bound pauses the group and asks the user.
11. **Lifecycle.** Idle runtimes are released and resumed on demand. Sessions are replaced only when they cannot be resumed; a model or provider change needs the user's confirmation. Groups follow the worker through handoffs and prompt edits. Worktrees are removed when supporters are released or groups archived.
12. **Visibility.** Profiles in Settings; groups in the Team list and as Team layouts; pending rosters as approval cards; calls, reports and usage per group; open calls in the worker's session attributions.

Never in scope:
- Supporters writing the worker's workspace.
- Supporters messaging the worker directly.
- A coordinator choosing resources outside its mandate.
- Changing a supporter's model or provider without the user's confirmation.
- Enabling Call For Support for a session without the user.

TPM is not moved onto this mechanism. It remains the external-observer pattern and could later trigger calls.

## Evidence

Run on 2026-10-29 in the worktree, against local scripted model servers (no model calls):

- **Claude read-only** (Claude Code 2.1.247, Agent SDK 0.3.247): `permissionMode: 'dontAsk'`, `disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']`, `sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { denyWrite: [cwd] } }`. Edit tools are unavailable; `echo > file` and `git commit` in the workspace fail with "operation not permitted"; `cat` and `git show` work; writing to `$TMPDIR` works; no approval is requested. `permissionMode: 'plan'` only blocked writes through the approval callback, and `dontAsk` alone relies on Claude's classification of shell commands; both were rejected.
- **Codex read-only** (codex-cli 0.165.0): `thread/start` with `sandbox: 'read-only'`, `approvalPolicy: 'never'`. Shell writes and `git commit` fail with "operation not permitted"; git reads work; no server requests.
- **Codex deferred tool** (0.165.0): a `dynamicTools` namespace `agent_remote` with a `deferLoading` function is absent from the model's tool list. With a model whose catalog entry supports the search tool (for example `gpt-5.5`), `tool_search` returns it, the model calls it, the app-server sends `item/tool/call` with `namespace`, `tool` and `arguments`, and the client's result reaches the model. With a model without search support the deferred tool is not offered at all.
- **Claude dynamic tool**: `setMcpServers({ agent_remote: server })` on a running streaming query adds `mcp__agent_remote__call_for_support` to the next turn; the model's call executes and its result reaches the model. Claude keeps a connected SDK server by name, so a server whose tool declarations change must be removed and added again.
- **Claude Host tool approval**: Host MCP tools ask for approval in `default` mode and are denied in `dontAsk` mode, including read-only sessions, unless an allow rule names them. A flag-layer rule `mcp__<server>` (initial `settings`, later `applyFlagSettings({ permissions })`) lets them run without asking in both modes.

The pinned Codex for compatibility tests is 0.162.0. The native namespace and read-only tests pass on 0.162.0 and 0.165.0, so the pin stays.

## Refinements

Found while planning the Relay work (2026-10-29); they refine the sections below.

- Profiles and enablement live in the tenant broker state next to Teams, not next to favorites in the gateway state. The tenant broker is per account, and group creation reads profiles in the same commit. Routes: `GET /v1/remote/call-for-support`, `POST /v1/remote/call-for-support/profiles`, `POST /v1/remote/call-for-support/enablement`, owner only.
- A session's effective enablement is its explicit entry if the user set one, possibly empty, otherwise the profiles with `enableByDefault`.
- A call that arrives while another is open has status `queued`; reporting the open call opens the next. A call's task is at most 12000 characters so its framed message fits a Team message.
- The Relay frames call and report messages; Controllers deliver them like other Team messages.
- Roster decisions reach the coordinator as `[Call For Support]` notes from the requester seat.
- Controllers poll enablement with a `support_enablement` host call. Worker tools go only to sessions without a Team or TPM role.
- Enabling sends no separate note to the worker: it would start a turn on an idle worker. Tool and namespace descriptions say when to call.
- A report is at most 24 KiB of JSON. A group's Call For Support state is compacted to 64 KiB: evidence of all but the latest reported call first, then findings of the oldest reported calls, then the oldest reported calls.

## Built on Team

Team already provides most of a support group:

| Need | Team today |
|---|---|
| Records visible across machines | The roster lives in the Relay (`packages/agent-remote-hosted/src/teams.ts`); each member's Controller creates and runs its session. |
| Centered on the worker | A Team is created from a source session, and its Leader reads that source (`read_source_session`). |
| A hub | Members may message only their Leader (`TeamBroker.hostCall` `send`). |
| Any host, any provider | Each member has its own `hostId`, `providerId` and `cwd`. |
| Reliable delivery | Durable messages with claims, receipts and acknowledgement (`packages/agent-host/src/team.ts`, `team-inbox.ts`). |
| Files | Team resources, up to 50 MiB each, across hosts. |
| Handoff | Members follow role succession, including a provider change. |
| Layout | A Team opens as an ordinary session layout. |

Team is the manual, transparent form of the same mechanism: its Leader works with the user, implements, and sees and directs every member. A support group is the encapsulated form: a Team with `callForSupport` set. Existing Teams are unchanged.

| Support concept | Team concept |
|---|---|
| Support group | A Team with `callForSupport`. Its `id` is the `roleId`. |
| Worker | The Team source, and a member with the new role `requester` bound to the existing worker session. No session is created for it. |
| Coordinator | The Team Leader, with coordination instructions and tools instead of implementation. |
| Supporter | A Team member. |
| Call | A Team message from the requester to the Leader, carrying `callForSupportCallId`. |
| Report | A Team message from the Leader to the requester, carrying the same call ID. |

## Data model

### Profiles (account state in the Relay)

```ts
interface CallForSupportProfile {
  id: string; name: string /* ≤ 128 */; description: string /* ≤ 4000 */;
  mandate: CallForSupportMandate;
  coordinator: { providerId?: string; model?: string; reasoningEffort?: string }; // absent: the worker's provider and its default model
  enableByDefault: boolean;                 // new sessions on the user's hosts start with Call For Support on for this profile
  revision: number; updatedAt: number;
}
```

Stored per account next to favorites, at most 32 per account, served at `/v1/call-for-support/profiles` with revision-checked writes. A group copies its profile's mandate and coordinator configuration when created and records `profileId` and the profile revision. Editing a profile does not change existing groups; the group view offers to apply the new revision.

### Mandate

```ts
interface CallForSupportMandate {
  supporters: Array<{ providerId: string; model: string; reasoningEffort?: string }>; // 1..8 allowed configurations
  maxSupporters: number;                                // 1..6 active at a time
  workspaces: Array<'shared' | 'worktree' | 'remote'>;
  remoteHosts: Array<{ hostId: string; workspace: string }>; // hosts and repository paths allowed for 'remote'
  approval: 'every_roster' | 'within_mandate';
  budget?: { tokensPerCall?: number; tokensTotal?: number; costUsdTotal?: number };
}
```

`shared` always means read-only. `worktree` and `remote` supporters write only their own worktree.

### Team additions (`packages/agent-remote-protocol/src/team.ts`)

All optional, so existing Teams validate unchanged.

`TeamMember`:
- `role` adds `'requester'`: at most one, only when `callForSupport` is set, never at index 0.
- `creation` adds `'released'`: a supporter the coordinator or user released. Its session is kept for history; it no longer counts toward `maxSupporters` and receives nothing.
- `model?`, `reasoningEffort?`: the configuration the member was created with.
- `access?: 'read_only'`: the session must not write its workspace.
- `workspace?: { kind: 'shared' } | { kind: 'worktree'; commit: string } | { kind: 'remote'; commit: string; repository: string }`.
- `usage?: { tokens: number; costUsd?: number; updatedAt: number }`.

`TeamMessage`:
- `callForSupportCallId?: string` on calls and reports.

`Team`:
- `callForSupport?: CallForSupportGroup`:

```ts
interface CallForSupportGroup {
  profileId?: string; profileRevision?: number;
  role: string /* ≤ 256 */; description: string /* ≤ 4000 */;
  mandate: CallForSupportMandate;
  coordinator: { providerId: string; model?: string; reasoningEffort?: string };
  status: 'active' | 'paused_budget';
  calls: CallForSupportCall[];          // most recent 64
  roster?: CallForSupportRoster;        // the pending or last decided proposal
  ledger: { text: string /* ≤ 16000 */; revision: number };
  usage: { tokens: number; costUsd?: number };
}
interface CallForSupportCall {
  id: string; task: string /* ≤ 16000 */; followUpOf?: string;
  context?: { commit?: string; base?: string; files?: string[] /* ≤ 64 */; conversation?: boolean };
  deliverable: 'findings' | 'answer' | 'test_report' | 'patch';
  origin: 'user' | 'worker';
  status: 'open' | 'reported' | 'needs_input' | 'failed';
  createdAt: number; reportedAt?: number;
  usage: { tokens: number; costUsd?: number };
  report?: CallForSupportReport;
}
interface CallForSupportReport {
  status: 'reported' | 'needs_input' | 'failed';
  summary: string /* ≤ 4000 */;
  findings: Array<{ id: string; severity: 'blocking' | 'major' | 'minor' | 'note'; location?: string; problem: string; suggestion?: string;
    agreement?: string /* e.g. "2 of 2 reviewers" */; evidence?: string /* ≤ 4000, read on demand */ }>; // ≤ 64
  resources?: TeamResource[];           // ≤ 8, patches and logs
}
interface CallForSupportRoster {
  id: string; status: 'pending' | 'approved' | 'rejected' | 'provisioned';
  members: Array<{ name: string; responsibility: string; providerId: string; model: string; reasoningEffort?: string;
    workspace: 'shared' | 'worktree' | 'remote'; hostId?: string /* remote only */ }>; // 1..6
  release?: string[];                   // members to release when provisioned
  rationale: string /* ≤ 4000 */; withinMandate: boolean;
  createdAt: number; decidedAt?: number; note?: string;
}
```

### Actions

`TeamCreate` gains `callForSupport?: { profileId: string; task: string; context?; deliverable; origin }`. Creating a group creates the coordinator and requester seats and the first call.

`TeamAction` gains (user, from the website):
- `call_for_support { teamId, operationId, task, context?, deliverable, followUpOf? }`.
- `resolve_roster { teamId, rosterId, decision: 'approve' | 'reject', note? }`.
- `release_member { teamId, memberId }`.
- `update_mandate { teamId, mandate, profileRevision? }`.
- `resume_group { teamId }` after a budget pause, with a raised budget in `update_mandate`.

`TeamHostCall` gains:
- For the coordinator: `propose_roster`, `report_support { callId, operationId, report }`, `write_ledger { revision, text }`, `release_supporter { target }`.
- For the requester (the worker's tool): `call_for_support { operationId, roleId?, profileId?, task, context?, deliverable, followUpOf?, fresh? }` and `support_status { roleId?, callId? }`.
- For Controllers: `report_usage { teamId, memberId, tokens, costUsd? }` (cumulative per member, monotonic).

Worker calls on a new role go through the Relay's group creation; the requester host call carries the worker's identity, so the Relay finds or creates the group for that worker and profile.

## Relay (`packages/agent-remote-hosted`)

- **Profiles store** (`call-for-support-profiles.ts`), modeled on `favorites.ts`: per-account list, revision-checked commands, at most 32 profiles.
- **Session enablement** per account: `{ host, provider, nativeSessionId } → profileIds[]`, following role succession like favorites. Served with the profiles; written by the website.
- **Group creation**: requires the worker's host and every supporter host to have negotiated `callForSupport`. Finds an existing active group for (worker role anchor, profile) unless `fresh`; otherwise creates one, archiving the previous one when `fresh`.
- **Roster validation**: every member's configuration is in `mandate.supporters`; its workspace is in `mandate.workspaces`; `remote` members use a host and repository in `mandate.remoteHosts`; active supporters after the roster's releases do not exceed `maxSupporters`; the host advertises the provider, and read-only support for it when the workspace is `shared`; the group is not paused. A roster outside the mandate is rejected for `within_mandate` coordinators' automatic provisioning and waits for the user with `withinMandate: false`.
- **Provisioning**: approved rosters release the listed members, then add the new members through the existing `createSeat`, with `model`, `reasoningEffort`, `access` and `workspace`, and the requester's working directory for `shared`. `worktree` and `remote` seats carry the call's commit; `remote` seats also the repository. Registration messages to the coordinator already exist.
- **Messaging**: the requester and supporters may message only the coordinator (existing rule). Only `report_support` creates coordinator-to-requester messages, so every report has a call. A report's resources must be resources the coordinator may access.
- **Usage**: `report_usage` updates the member, the open call and the group. If a budget bound is reached, the group pauses: no new deliveries to the coordinator or supporters, the open call is reported `needs_input` with the reason, and the website shows the pause.
- **Projection**: hosts that have not negotiated `callForSupport` never receive support groups in `poll` or `read`. A rolled-back Controller keeps its other Teams working; the group pauses until it updates.
- **Capacity**: the Team count limit rises from 32 to 128; support groups and Teams share the existing 2 MiB state and 128 KiB per-Team message budgets. Report evidence counts toward the message budget; tests measure a group with full calls, reports and ledger.

## Controller (`packages/agent-host`)

- **Capability** `callForSupport`, negotiated like `teamSuccession`: requested by the Controller, acknowledged in `registered`. The Controller's provider snapshot reports per provider whether read-only sessions are available.
- **Requester seat**: `create` binds the existing source session. It verifies the session is on this Controller and reports its working directory. The seat follows the worker's role succession like any member.
- **Seat creation** passes `model`, `reasoningEffort` and `access` to `directory.create`, and `access` again on every resume. A read-only session refuses changes to permission settings and to planning mode.
- **Workspaces** (`call-for-support-workspaces.ts`):
  - `worktree`: `git -C <worker repo> worktree add --detach <repo>/.agent-remote/worktrees/<teamId>/<memberId> <commit>`, with `.agent-remote/` added to the repository's `.git/info/exclude`. The path lies inside the worker's repository, so it is inside the same allowed roots.
  - `remote`: the worker's Controller creates `git bundle create <file> <base>..<commit>` (or the commit's full history when `base` is absent) and uploads it as a Team resource; the remote Controller fetches the bundle into the configured repository and adds a worktree at the commit in the same layout.
  - Release and archive remove the worktree (`git worktree remove --force`, then `git worktree prune`).
  - A supporter's patch is produced by the Controller from its worktree (`git diff --binary <commit>` plus `git format-patch <commit>..HEAD` when it committed) and uploaded as a Team resource on the coordinator's request.
- **Extensions**:
  - Coordinator: coordination instructions (below) and tools `read_team`, `acknowledge_team_messages`, `send_team_message` (to supporters), `read_source_session`, `propose_roster`, `release_supporter`, `report_support`, `write_ledger`, `collect_supporter_patch`, `download_team_resource`, `upload_team_resource`.
  - Supporter: supporter instructions and the member tools it has today; it may message only the coordinator.
  - Requester: only the Call For Support tools, and only while enabled (see "Worker tools").
- **Delivery to the requester** uses the existing claim/receipt path with a report framing: `[Support report · <role> · call <id> · <status>]`, the summary and findings without evidence, resource IDs, and a fixed note that this is advice the worker may adopt, that the worker owns the decision and the workspace, and how to read details or follow up. A report to a busy worker is queued for its next turn; to an idle worker it starts a turn.
- **Idle release**: the Team runtime holds a member's lease while the member has a queued, dispatching or unsettled delivery, until it reports idle, and while archiving needs its presence. Otherwise the Host's existing idle release frees the runtime, and the next delivery resumes the same native session. This applies to all Teams.
- **Usage accounting** (`call-for-support-usage.ts`): for each coordinator and supporter session, follow `usage_updated` and `turn_completed` usage. `session`-scoped totals (Codex) count their increase; `runtime`-scoped totals (Claude) count their increase and treat a decrease as a new runtime; `turn`-scoped values add. `totalCostUsd` is accounted the same way where reported. Cumulative values are sent with `report_usage`.

### Worker tools

One namespace `agent_remote` (Codex) or MCP server `agent_remote` (Claude):

- `call_for_support({ roleId?, profileId?, task, context?: { commit?, base?, files?, conversation? }, deliverable, followUpOf?, fresh? })` → `{ callId, roleId, status: 'accepted' | 'needs_approval' | 'unavailable', message }`. A new role needs a `profileId` from `support_status`. Accepted calls are reported later as input.
- `support_status({ roleId?, callId? })` → enabled profiles (id, name, description), the session's roles (roleId, role, open calls, last report summary), or one call's status.
- `read_support_report({ callId, findingId? })` → the full report, or one finding with its evidence.
- `download_support_resource({ callId, resourceId, outputDirectory? })` → a verified local file, for patches and logs; never applied or executed.

Injection:
- Claude: when enabled, `setMcpServers` with the session's existing `agent_host` server and `agent_remote`; when disabled, without `agent_remote`. Applied again on resume.
- Codex: every thread the Controller starts declares the `agent_remote` namespace. It is direct when Call For Support is already enabled for the session at thread start, and deferred otherwise, so it costs nothing until a search-capable model looks for it. Codex's `model/list` does not report search support, so a session enabled later on a model without search support cannot see the tools; the website call path and a handoff remain. The tools answer `unavailable` while the session is not enabled. Threads started outside the Controller or before this release gain the tools only through a handoff.
- Instructions cannot change after creation, so enabling sends one queued note to the worker describing the tools and when to call.

### Coordinator instructions (summary)

The coordinator serves one role for one worker. It:
- reads the call and, when needed and allowed (`context.conversation`), the worker's conversation;
- proposes rosters with `propose_roster`, waits for registration messages, and releases supporters it no longer needs;
- briefs supporters with only what they need: the task, the commit, the files, the completion criteria;
- tells `shared` supporters to read code at the commit through git (`git diff <base>..<commit>`, `git show <commit>:<path>`), never the live working tree, because the worker may keep working;
- collects evidence, merges duplicates, marks agreement and disagreement;
- reports with `report_support`; uses `needs_input` when it needs the worker or the user;
- keeps the ledger with `write_ledger` so it can continue after compaction or handoff;
- never names supporters, models or hosts in a report unless the worker needs to know;
- never edits the worker's workspace and never asks a supporter to.

## Providers

`packages/agent-provider-sdk`:
- `AgentSessionConfig.access?: 'read_only'`; `descriptor.sessionAccess?: { readOnly: true }` for adapters that enforce it on create and resume.
- `AgentSessionExtensions.toolNamespaces?: AgentSessionToolNamespace[]`, where a namespace has a `name`, a `description`, `tools` and `deferred?: boolean`; `descriptor.sessionExtensions.toolNamespaces?: 'creation' | 'live'`.
- `AgentSession.updateToolNamespaces?(namespaces)`: replaces the session's namespaces. `live` adapters may add and remove namespaces; `creation` adapters may only rebind the executors of namespaces declared when the session started, and reject anything else.

- **Codex**: `thread/start` and `thread/resume` with `sandbox: 'read-only'` and `approvalPolicy: 'never'` for read-only sessions. Dynamic tool namespaces with `deferLoading`. `item/tool/call` requests with a namespace are routed to the namespace's tools.
- **Claude**: read-only sessions use the verified options (see "Evidence") plus `EnterPlanMode` and `ExitPlanMode` removed and bypass not allowed; the `permissions` setting and planning are locked, and read-only access persists in the session's handle. Each namespace is its own MCP server, changed with `setMcpServers`. Namespace tools, and the `agent_host` tools of read-only sessions, are allowed by flag-layer rules: the Host governs them, and a read-only session cannot ask. The `agent_host` tools of writable sessions keep asking as before.
- **Copilot, OpenCode**: they may be supporters only in `worktree` and `remote` workspaces until they enforce read-only natively, and they cannot receive worker tools after creation until a dynamic mechanism is verified for them.

## Website (`packages/agent-remote-lab`)

- **Settings → Call For Support**: profiles list and editor (name, description, mandate rows of provider/model/effort from the hosts' catalogs, workspaces, remote hosts and repositories, maximum supporters, budget, approval mode, coordinator configuration, enable by default).
- **Session actions → Call for support**: choose an existing role of this session or a profile for a new role; task, context (commit, base, files, conversation access), deliverable, follow-up. Toggle **Enable for this session** with the profiles it may use.
- **Suggestion**: for a session whose timeline contains file changes and whose working directory is a git repository, the session actions show "Call For Support is available" until dismissed or enabled.
- **Groups** appear in the Team list with their role, worker, status and usage, and open as Team layouts. A pending roster shows as a card with members, configurations, rationale and whether it is within the mandate, with **Approve** / **Reject**. Calls and reports are listed with their findings and resources. A budget pause shows the reason and **Resume** after raising the budget.
- **Worker view**: open calls and their status in the session attributions; reports appear in the conversation as delivered input.

## Flows

### Worker call on a new role
1. The worker calls `support_status`, picks a profile, and calls `call_for_support` with `profileId`, task, commit and deliverable.
2. The Relay creates the group: the coordinator, on the worker's host in the worker's directory, read-only, with the profile's coordinator configuration; and the requester seat bound to the worker. It records the call and queues it to the coordinator. The tool returns `accepted` with `callId` and `roleId`.
3. The coordinator proposes a roster. Within the mandate and with `within_mandate` approval it is provisioned at once; otherwise the user approves it.
4. The coordinator briefs supporters, merges results, and reports. The report is delivered to the worker.

### Follow-up
The worker calls with `roleId` and `followUpOf`. The same coordinator and supporters continue with their context and the ledger. Calls on one group are handled in order; a call arriving during another is queued behind it.

### Patch deliverable
A `worktree` or `remote` supporter changes its worktree and tells the coordinator. The coordinator calls `collect_supporter_patch`, reviews the patch, and attaches it to its report. The worker downloads it with `download_support_resource` and applies it itself.

### Idle release, resume, replacement
Idle runtimes are released by the Host. A delivery resumes the same native session with its extensions and access. Replacement only when resume fails: the native session is gone (new session, briefed from the ledger; the replacement is recorded in the group); the host is offline (the coordinator reports and may move the role to another host within the mandate); the model or provider is no longer available (the user decides).

### Worker handoff
The requester seat follows the worker's role succession, as members do. Reports go to the current worker session; its tools are re-injected on attach. Supporters are unchanged.

### Archive
Archiving a group follows today's Team archive and removes its worktrees. `fresh` archives the previous group of the role.

## Failure modes

| Case | Behavior |
|---|---|
| Call while not enabled | `unavailable`, with how the user can enable it. |
| New role without a profile | `needs_approval`; the website asks the user to choose a profile. |
| Roster outside the mandate | Waits for the user with `withinMandate: false`; the coordinator is told. |
| User rejects a roster | The coordinator receives the decision and note, proposes again or reports `needs_input`. |
| Supporter creation unknown | Existing Team `unknown` state; retry or abandon in the group view. |
| Commit missing for a worktree or remote supporter | Provisioning fails with the reason; the coordinator reports `needs_input` asking the worker to commit. |
| Remote repository lacks the base | The bundle carries full history; if the fetch still fails, provisioning fails with the git error. |
| Budget reached | Group pauses; open call `needs_input`; the user raises the budget and resumes. |
| Report undeliverable | Existing Team receipts; the report stays readable with `read_support_report` and in the website. |
| Controller rolled back | The Relay hides groups from it; delivery pauses until it updates. |

## Compatibility and rollout

- Protocol additions are optional fields and new union members, guarded by the `callForSupport` capability for Controllers. The website and Relay deploy together.
- Order: deploy the website (Relay accepts profiles and groups, hides groups from hosts without the capability), then release the Controller, then update hosts.
- Existing Teams: unchanged data and behavior, except the idle lease change, which only stops holding idle members' runtimes.

## Milestones

Each milestone ends with its tests green and is committed; none is released alone. The website is deployed and the Controller released after milestone 7.

1. **Provider foundations**: read-only sessions for Codex and Claude with locked permissions; model, effort and access at Team seat creation; Codex deferred dynamic namespaces and namespaced tool calls; Claude live MCP server updates; native tests.
2. **Protocol and Relay groups**: data model, profiles store and enablement, group creation, calls, rosters with both approval modes, reports, ledger, release, projection by capability, capacity.
3. **Controller groups**: capability negotiation, requester seats, coordinator and supporter extensions, report delivery, idle lease release.
4. **Worker tools**: tool definitions, injection and enablement for Claude and Codex, requester host calls, report reading and resource download.
5. **Workspaces and patches**: worktree and remote provisioning, bundles, patch collection, cleanup.
6. **Usage and budgets**: accounting, reporting, pauses and resume.
7. **Website**: Settings profiles, call dialog, enablement and suggestion, group views, roster cards, reports, usage.
8. **Acceptance and release**: end-to-end native acceptance, documentation, website deploy, Controller release.

## Verification

- Protocol: schema and invariant tests for every addition.
- Relay: group creation and reuse, `fresh`, roster validation in both approval modes, provisioning with releases, messaging rules, usage and pause, projection by capability, profile store, enablement following succession, capacity with full groups.
- Controller: requester binding and its succession, seat creation arguments and resume access, permission lock, coordinator and supporter extensions, report framing and delivery mode, idle lease release and resume, worktree and bundle provisioning against real git repositories, patch collection, usage accounting for each scope.
- Providers: Codex read-only and deferred tools (unit and native on the pinned version); Claude read-only and live MCP updates (unit and native).
- Website: unit tests for Settings, the call dialog, enablement, roster cards and reports; browser tests of a full call against the recorded provider, including approval and a follow-up.
- End to end, local native: a Codex worker on a search-capable model calls a "Cross review" profile with a Claude supporter and a Codex supporter on the shared workspace; the supporters cannot write; a report reaches the worker; a follow-up reuses the sessions; a `worktree` supporter's patch is downloaded and applies cleanly.

## Risks

- Coordinator quality depends on its model; the mandate bounds resources, not judgment. `every_roster` approval is the default for new profiles.
- Codex deferred tools and `tool_search` are experimental Codex APIs; the native test on the pinned version guards them, and the direct registration is the fallback.
- Team storage budgets were sized for user-built Teams; reports, evidence and ledgers are bounded and measured.
- Remote workspaces depend on the remote repository; failures are reported with git's message rather than retried silently.
- The worker may ignore or misread a report. Reports are structured, readable on demand, and visible to the user.
