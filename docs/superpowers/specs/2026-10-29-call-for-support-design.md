# Call For Support

Status: design for review. Phase 1 is specified in detail; Phases 2 and 3 are bounded but not yet planned task by task.

## Purpose

A worker session should be able to obtain help it cannot provide itself: a stronger or independent model, another provider, another machine, another environment. The worker states what kind of support it needs. A support coordinator decides which sessions and resources provide it, runs them, and returns one curated report. The worker never manages the supporters and never sees how the support was organized.

The motivating case: a Codex worker on a medium model writes code and prepares a pull request. Before the pull request it calls for a code review. The coordinator brings in two reviewers on different providers and stronger models (for example a stronger Codex model and Claude Opus at maximum effort), both reading the worker's workspace without changing it. It merges their findings into one report for the worker, which fixes the code and calls again on the same review role, until the reviewers have no blocking findings.

## Principles

1. **Encapsulation.** The worker sees a contract: a call (what it needs) and a report (what came back). Rosters, models, hosts, retries, disagreements and partial failures stay with the coordinator. What the worker does not know cannot pollute its context.
2. **Least context downward.** The coordinator briefs each supporter with what that supporter needs, not the worker's whole conversation. Only the coordinator holds the full picture.
3. **Visible to the user, encapsulated for agents.** The user sees rosters, proposals, progress and decisions in the website and can intervene. The worker loses direct control; the user keeps it.
4. **The worker is the only writer of its workspace.** Supporters read it. Code a supporter produces comes back as a patch or commit for the worker to apply (Phase 3).
5. **Reports are advice.** A report is labeled with its call and role. The worker decides what to adopt. Conflicts go to the user.
6. **The system enforces the mandate.** Which providers, models, hosts, permissions and how many supporters a coordinator may use is checked by the Relay and Controller, never only stated in a prompt. A call comes from a model, and so does every coordinator decision; either may be steered by content in the repository.
7. **Context is kept, not rebuilt.** The same worker and role always reach the same coordinator. Coordinators and supporters are native sessions that are resumed, not recreated. Their key state is also kept outside the conversation.

## Terminology

| Term | Meaning |
|---|---|
| Call For Support | The mechanism. Code identifiers use the full prefix (`callForSupport`, `CallForSupport…`, `call-for-support`), never a bare `support`, which the codebase uses for capability checks such as `supports(...)`. |
| Worker (requester) | The session that calls. It owns its task and workspace. |
| Support call | One request: role, description, task, context, deliverable, optional follow-up of an earlier call. |
| Support role | The kind of support, for example "code reviewer". Identified by a `roleId` once established. |
| Support group | Everything serving one worker and one role: the coordinator, the supporters, the calls, the ledger. |
| Support coordinator | The AI session that organizes a support group and writes reports. |
| Supporter | A session working for the coordinator. |
| Support report | The coordinator's answer to one call. |
| Mandate | The user-approved bounds of a support group: allowed provider/model/effort configurations, supporter count, workspace strategies, access, approval mode. |
| Roster proposal | The coordinator's structured plan for which supporters to create. |
| Ledger | The coordinator's durable, structured state for the role: calls, reviewed commits, findings and their status. |

## Feature boundaries

### Phase 1: Call For Support from the website, shared-workspace supporters

In scope:
- The user calls for support on a session from the website: role, description, task, and the mandate (allowed provider/model/effort configurations, maximum supporters). A later call on the same session can choose an existing role.
- One support group per worker and role, built on Team (see "Built on Team").
- The coordinator proposes a roster. The Relay validates it against the mandate. The user approves or rejects every proposal in the website.
- Approved supporters are created on the worker's host, in the worker's working directory, read-only, with the chosen provider, model and reasoning effort.
- Supporters work only through the coordinator. The coordinator merges their results and reports to the worker. The report arrives in the worker's conversation as queued input, without interrupting a running turn.
- Follow-up calls on the same role reach the same coordinator and supporters, with their context and the ledger.
- Coordinator and supporter runtimes are released when idle and resumed when needed. A session is replaced only when it cannot be resumed; a model or provider change needs the user's confirmation.
- The coordinator and supporters follow the worker through handoffs and prompt edits.
- Read-only sessions for Codex and Claude, enforced natively. A provider that cannot enforce read-only access cannot be a shared-workspace supporter.
- Progress, rosters and reports are visible in the website, in the existing Team views.

Out of scope for Phase 1, each assigned to a later phase:
- The worker calling for support itself (`call_for_support` tool): Phase 2.
- Dynamic enablement of the capability on a session after creation: Phase 2.
- Approval within the mandate without asking the user: Phase 3.
- Supporters in their own worktree or on another host; supporters that run code or produce patches: Phase 3.
- Releasing or replacing supporters during a call, scaling a group: Phase 3.
- Budgets in tokens or cost: Phase 3, after per-provider usage reporting is established.
- Reusable support profiles managed in Settings: Phase 3. Phase 1 stores the mandate on the group.
- Suggesting a call when a session looks like coding work: Phase 3. It only ever suggests.
- Moving TPM onto this mechanism: not planned. TPM remains the external-observer pattern and may later trigger calls.

Never in scope:
- Supporters writing the worker's workspace.
- Supporters messaging the worker directly.
- A coordinator choosing resources outside its mandate.
- Changing a supporter's model or provider without the user's confirmation.

### Phase 2: the worker calls

- A gateway tool `call_for_support` (and a read-only companion to list roles and call status) for the requester seat only. Calls return a call ID immediately; reports arrive asynchronously as today.
- The worker can request an existing `roleId`, ask for a fresh coordinator, give preferences ("a different model family", "stronger reasoning"), and follow up on a call. Preferences are mapped to the mandate by the coordinator; the worker never names concrete models.
- Dynamic enablement: Claude through the SDK's `setMcpServers` on the live query; Codex through deferred dynamic tools in a namespace registered at `thread/start` and found with `tool_search`. Both are verified by experiment before design is final. Sessions created before Phase 2 keep the website call path or gain the tool through a handoff.

### Phase 3: autonomy and other workspaces

- Approval mode "within mandate": proposals inside the mandate are provisioned without asking; anything outside returns `needs_approval`.
- Workspace strategies `worktree` (own checkout at a commit on the same host, writable) and `remote` (another host, checkout of a pushed branch). Patches and test reports as deliverables.
- Releasing, replacing and adding supporters during a call. Usage-based budgets. Support profiles in Settings, reusable across workers. Suggesting calls for sessions that look like coding work.

## Relationship to Team and TPM

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

Team is therefore the manual, transparent form of the same mechanism: a Team's Leader works with the user, implements, and sees and directs every member. A support group is the encapsulated form. They share one implementation: a support group is a Team with a `callForSupport` profile. Existing Teams are unchanged.

TPM stays separate. It observes a main session from outside and is triggered by events; a support group serves calls.

## Built on Team

### Mapping

| Support concept | Team concept |
|---|---|
| Support group | A Team with `callForSupport` set. Its `id` is the `roleId`. |
| Worker | The Team source, and a member with the new role `requester` bound to the existing worker session (no session is created). |
| Coordinator | The Team Leader, with instructions and tools for coordination instead of implementation. |
| Supporter | A Team member. |
| Call | A Team message from the requester to the Leader, carrying `callForSupportCallId`. |
| Report | A Team message from the Leader to the requester, carrying the same call ID. |

The Team source becomes the worker; one worker may have several support groups, one per role.

### Data model changes (protocol)

All in `packages/agent-remote-protocol/src/team.ts`, all optional, so existing Teams validate unchanged.

`TeamMember`:
- `role` adds `'requester'`. A Team has at most one requester, only when `callForSupport` is set, and never at index 0.
- `model?: string`, `reasoningEffort?: string`: the configuration the member was created with.
- `access?: 'read_only'`: the member's session must not write its workspace. Absent means today's behavior.
- `workspace?: 'shared'`: the member uses the requester's working directory on the requester's host. Phase 3 adds `'worktree'` and `'remote'`.

`TeamMessage`:
- `callForSupportCallId?: string` on calls and reports.

`Team`:
- `callForSupport?: CallForSupportGroup`:

```ts
interface CallForSupportGroup {
  role: string;                  // ≤ 256, as the user or worker named it
  description: string;           // ≤ 4000, responsibility and completion criteria
  mandate: CallForSupportMandate;
  calls: CallForSupportCall[];   // most recent 64
  roster?: CallForSupportRoster; // the pending or last decided proposal
  ledger: { text: string; revision: number }; // ≤ 16000 characters
}
interface CallForSupportMandate {
  supporters: Array<{ providerId: string; model: string; reasoningEffort?: string }>; // 1..8 allowed configurations
  maxSupporters: number;         // 1..6
  workspaces: ['shared'];        // Phase 3 adds 'worktree' | 'remote'
  access: 'read_only';           // required for 'shared'
  approval: 'every_roster';      // Phase 3 adds 'within_mandate'
}
interface CallForSupportCall {
  id: string; task: string /* ≤ 16000 */; followUpOf?: string;
  status: 'open' | 'reported' | 'needs_input' | 'failed';
  createdAt: number; reportedAt?: number;
}
interface CallForSupportRoster {
  id: string; status: 'pending' | 'approved' | 'rejected';
  members: Array<{ name: string; responsibility: string; providerId: string; model: string; reasoningEffort?: string;
    access: 'read_only'; workspace: 'shared' }>; // 1..6
  rationale: string;             // ≤ 4000
  createdAt: number; decidedAt?: number; note?: string;
}
```

`TeamCreate` gains `callForSupport?: { role, description, mandate, task }`. Creating a support group also creates its requester seat and its first call.

`TeamAction` gains:
- `call_for_support { teamId, operationId, task, followUpOf? }`: a new call on an existing group, sent by the user on the worker's behalf.
- `resolve_roster { teamId, rosterId, decision: 'approve' | 'reject', note? }`.

`TeamHostCall` gains, for the Leader of a support group only:
- `propose_roster { teamId, memberId, operationId, members, rationale }`.
- `report_support { teamId, memberId, operationId, callId, status: 'reported' | 'needs_input' | 'failed', text }`.
- `write_ledger { teamId, memberId, revision, text }`.

`isTeam` gains the invariants above: the requester exists exactly when `callForSupport` is set; requester and supporters are on the source host while workspaces are `'shared'`; every member configuration is in the mandate; message call IDs refer to existing calls.

### Relay (`packages/agent-remote-hosted/src/teams.ts`, `broker.ts`)

- `create` with `callForSupport`: requires the source host to have negotiated `callForSupport`; creates the Leader (coordinator) and the requester seat, provisions both (the requester seat only binds), and queues the first call as a requester-to-Leader message.
- `propose_roster`: validates each member against the mandate (configuration allowed, count with existing supporters ≤ `maxSupporters`, workspace and access allowed, provider available on the host, the host advertises read-only support for that provider). An invalid proposal fails with a reason the coordinator can act on. A valid one replaces any pending proposal and waits for the user.
- `resolve_roster approve`: adds the members exactly as proposed (with `model`, `reasoningEffort`, `access`, `workspace` and the requester's `cwd`) and provisions them through the existing `createSeat`. Registration messages to the Leader already exist.
- Messaging: the requester may message only the Leader; supporters may message only the Leader (existing rule). Only `report_support` creates Leader-to-requester messages in a support group, so every report has a call.
- `call_for_support`: queues a requester-to-Leader message and records the call. A follow-up must name a call of the same group.
- Projection: hosts that have not negotiated `callForSupport` never receive support groups in `poll` or `read`. This also protects a Controller that was rolled back: its other Teams keep working, and the support group pauses until it updates.
- Capacity: support groups count toward the existing Team limits. The Team count limit rises from 32 to 64; archived groups keep counting until deleted. Every change still passes the 2 MiB state and 128 KiB per-Team message budgets, which tests measure for a full support group.

### Controller (`packages/agent-host/src/team.ts`, `host.ts`)

- Uplink capability `callForSupport`, negotiated like `teamSuccession`: requested by the Controller and acknowledged in `registered`. The Controller requests it only when the Relay can accept it.
- Requester seat: `create` binds the existing source session instead of creating one. It verifies the session exists on this Controller and reports its working directory. The seat follows the worker's role succession like any member.
- Seat creation passes `model`, `reasoningEffort` and `access` to `directory.create`. Resume passes `access` again.
- Extensions:
  - Coordinator: support instructions (below) and tools `read_team`, `acknowledge_team_messages`, `send_team_message` (to supporters), `read_source_session`, `propose_roster`, `report_support`, `write_ledger`. No implementation role.
  - Supporter: supporter instructions and the member tools it has today; it may message only the coordinator.
  - Requester: no Team tools in Phase 1. Phase 2 adds `call_for_support` only.
- Delivery to the requester uses the existing claim/receipt path with a support framing:
  `[Support report · <role> · call <id> · <status>]` followed by the report and a fixed note: it is advice from support the user or worker called; the worker owns the decision and the workspace. A report to a busy worker is queued for its next turn (`next_turn`); to an idle worker it starts a turn, so the worker can act on it.
- Idle release: today the Team runtime holds a lease on every ready member of every active Team, which keeps their runtimes alive indefinitely. It will hold a lease only while a member has a queued, dispatching or unsettled delivery, and while archiving needs its presence. Otherwise the Host's existing idle release frees the runtime, and the next delivery resumes the same native session.

### Coordinator instructions (summary)

The coordinator serves one role for one worker. It:
- reads the call and, when needed, the worker's conversation;
- proposes a roster with `propose_roster` and waits for approval (registration messages tell it when supporters are ready);
- briefs supporters with only what they need: the task, the commit to review, the files, the completion criteria;
- tells supporters to read code at the commit through git (`git diff <base>..<sha>`, `git show <sha>:<path>`), never the live working tree, because the worker may keep working;
- collects evidence, merges duplicates, marks agreement and disagreement;
- reports with `report_support`: status, summary, then findings with severity, location, problem, suggested change and agreement; `needs_input` when it needs the worker or the user;
- keeps the ledger with `write_ledger`: calls, reviewed commits, findings and their status, so it can continue after compaction or handoff;
- never names supporters, models or hosts in a report unless the worker needs to know;
- never edits the worker's workspace and never asks a supporter to.

### Providers

`packages/agent-provider-sdk`: `AgentSessionConfig.access?: 'read_only'`, and `descriptor.sessionAccess?: { readOnly: true }` for adapters that enforce it natively on create and resume. The Controller reports per provider whether read-only is available in its provider snapshot; the Relay uses it to validate rosters.

- Codex: `thread/start` and `thread/resume` with `sandbox: 'read-only'` and an approval policy that never asks. The supporter's permissions are locked, so `/permissions` cannot widen them.
- Claude: to be established by a native experiment before implementation. Candidates: permission mode `plan`; a deny-all write rule for edit tools in `canUseTool` together with the sandbox's filesystem write restriction for shell commands. Claude is required for the motivating case; if neither enforces writes reliably, Phase 1 stops and the design is revisited.
- Copilot and OpenCode: not declared in Phase 1.

### Website (`packages/agent-remote-lab`)

- A **Call for support** action in a session's actions menu. The dialog offers existing roles of this session, or a new role with role, description, task, and the mandate: rows of provider/model/effort from the session's host catalog (`/remote/models`), and the maximum number of supporters. Follow-up of an earlier call is selectable.
- Support groups appear in the Team list with their role and worker, and open as Team layouts. A pending roster shows as a card with members, configurations and rationale, and **Approve** / **Reject** with an optional note.
- The worker's view shows its open calls and their status in the session attributions. Reports appear in its conversation as delivered input.

## Flows

### First call
1. The user opens **Call for support** on the worker and enters role, description, task and mandate.
2. The Relay creates the support group: the coordinator (Leader, created on the worker's host in the worker's directory, read-only) and the requester seat (bound to the worker). It queues the call to the coordinator.
3. The coordinator reads the call, proposes a roster; the user approves; the Relay provisions supporters; registration messages reach the coordinator.
4. The coordinator briefs supporters, merges their results and reports. The report is delivered to the worker.

### Follow-up and reuse
The user chooses the existing role (Phase 2: the worker passes `roleId`, or `followUpOf`). The same coordinator and supporters continue with their context and the ledger. Calls on one group are handled in order; a call arriving during another is queued behind it.

### Idle release, resume, replacement
Idle runtimes are released by the Host. A delivery resumes the same native session with its role extensions. Replacement only when resume fails: the native session is gone (new session, briefed from the ledger, the replacement recorded); the host is offline for long (Phase 1: wait and report `failed` to the call; Phase 3: move within the mandate); the model or provider is no longer available (ask the user).

### Worker handoff
The requester seat follows the worker's role succession, as members do. Reports go to the current worker session. Supporters are unchanged.

### Archive
Archiving the worker's support group follows today's Team archive. Archiving the worker does not archive its groups in Phase 1; the Team list shows them with the worker's state.

## Failure modes

| Case | Behavior |
|---|---|
| Roster outside the mandate | `propose_roster` fails with the reason; the coordinator revises. |
| User rejects a roster | The coordinator receives the decision and note, proposes again or reports `needs_input`. |
| Supporter creation unknown | Existing Team `unknown` state; the user retries or abandons in the Team view. |
| Supporter host or provider unavailable | The coordinator reports `failed` or proceeds with the remaining supporters and says so. |
| Report undeliverable (worker closed or moved) | Existing Team receipts; the report stays visible in the group. |
| Controller rolled back | The Relay hides support groups from it; delivery pauses until it updates. |

## Compatibility and rollout

- Protocol additions are optional fields and new union members, guarded by the `callForSupport` capability for Controllers. The website and Relay deploy together.
- Order: deploy the website (Relay accepts and hides support groups by capability), then release the Controller (negotiates `callForSupport`, adds read-only sessions and support seats), then update hosts.
- Existing Teams: unchanged data, behavior and UI, except the idle lease change, which only stops holding idle members' runtimes.

## Verification

- Protocol: schema and invariant tests for every addition, including invalid requesters, mandate violations and call references.
- Relay: broker tests for group creation, roster validation, approval and provisioning, messaging rules, projection by capability, capacity with a full group.
- Controller: requester binding and its succession, seat creation arguments, coordinator and supporter extensions, support report framing and delivery mode, idle lease release and resume.
- Providers: Codex read-only on create and resume (unit and native); the Claude read-only experiment, then unit and native tests of the chosen mechanism.
- Website: unit tests for the dialog, roster card and call status; a browser test of a full call against the recorded provider.
- End to end, local: a Codex worker and a Claude supporter on the same working directory; the supporter cannot write; a report reaches the worker; a follow-up reuses both sessions.

## Risks and open questions

- Claude read-only enforcement (see Providers). This gates Phase 1.
- Coordinator quality depends on its model; the mandate bounds cost, not judgment. Every roster is approved by the user in Phase 1.
- Team storage budgets were sized for user-built Teams; reports and ledgers are bounded, and tests measure a full group.
- Codex deferred tools and `tool_search` are experimental; Phase 2 depends on the experiment.
- The worker may ignore or misread a report. Reports are structured and the user sees them; Phase 2 adds call status the worker can query.
