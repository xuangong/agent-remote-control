# Call For Support

## Role

Call For Support lets a working session (the worker) obtain help it cannot give itself: an independent review, a stronger or different model, another provider, another machine. The worker states the kind of support it needs; a coordinator session organizes supporter sessions within a mandate, merges their results and returns one report. The worker never manages the supporters and never sees how the support was organized; the user sees and controls all of it in the website.

A support group is a Team with `callForSupport` set (`packages/agent-remote-protocol/src/call-for-support.ts`, `packages/agent-remote-protocol/src/team.ts`). Its Leader is the coordinator, its members are supporters, and the worker holds a `requester` seat bound to its existing session. Ordinary Teams are unchanged.

## Boundary

| Area | Owner | Files |
| --- | --- | --- |
| Schemas, Team additions, host calls | Protocol | `call-for-support.ts`, `team.ts`, `remote-host-uplink.ts` (`callForSupport`) |
| Profiles, enablement, groups, calls, rosters, reports, ledger, usage, pauses, retention | Relay (tenant broker state) | `packages/agent-remote-hosted/src/call-for-support-profiles.ts`, `call-for-support.ts`, `teams.ts`, `team-resources.ts`, `broker.ts` |
| Requester seats, coordinator and supporter extensions, deliveries, idle release, worktrees, bundles, patches, usage accounting, forgetting ended groups | Controller | `packages/agent-host/src/team.ts`, `call-for-support-roles.ts`, `call-for-support-workspaces.ts`, `call-for-support-usage.ts` |
| Worker tools and their injection | Controller | `packages/agent-host/src/call-for-support-worker.ts`, `host.ts` |
| Read-only sessions, tool namespaces | Provider adapters | `agent-provider-sdk` (`access`, `toolNamespaces`, `updateToolNamespaces`), Codex `session.ts`, Claude `session.ts`, `permission-modes.ts` |
| Settings, Team panel, group views | Website | `packages/agent-remote-lab/src/components/call-for-support/` |

## Key flows

### Negotiation

A Controller requests groups with `callForSupport=1` on its uplink and names the providers that enforce read-only sessions with `readOnlyProvider=<id>` query parameters; Relays before Call For Support ignore both, so an updated Controller still registers with them. The Relay acknowledges `callForSupport: 1` only together with `teamSuccession`, and treats a provider as read-only only while it acknowledged the request.

### Profiles and enablement

The account's profiles live in the tenant broker state next to its Teams: at most 32, revision-checked (`GET /v1/remote/call-for-support`, `POST …/profiles`, owner only). A profile names the coordinator configuration and a mandate: allowed supporter configurations (provider, model, effort), supporters at a time, workspaces (`shared`, `worktree`, `remote` with Hosts and repositories), the approval mode and an optional budget. Models are entered as text.

A session may call for the profiles of its explicit enablement entry (`POST …/enablement`), or, without one, for the profiles enabled by default. Entries follow a session through its handoffs by role routing. Controllers read enablement for their sessions with the `support_enablement` host call.

### A call

1. The worker calls `call_for_support` (or the user calls from the Team panel). The Relay checks enablement, then adds the call to the worker's active group for the profile, or creates one: the worker's seat binds first and reports its working directory, then a read-only coordinator starts there with the profile's configuration. `fresh` archives the previous group of the role. Calls are handled one at a time; later calls wait as `queued`.
2. The call reaches the coordinator as a framed Team message (`[Support call <id> · <role> · <deliverable> · from the worker]`).
3. The coordinator proposes a roster. The Relay refuses what no approval can fix (unknown or incapable Host, provider missing, `shared` without native read-only, `worktree`/`remote` without the call's commit, remote Host outside the mandate, member capacity) and marks what leaves the mandate. With `within_mandate` approval a roster inside the mandate is provisioned at once; otherwise it waits for the user. Releases happen before additions.
4. The coordinator briefs supporters through Team messages, collects their evidence and answers the call with one `report_support`. The Relay frames the report for the worker as advice (`[Support report · <role> · call <id> · <status>]`, summary, findings without evidence, resources, and how to read details or follow up) and opens the next waiting call.
5. Follow-ups name the role and the earlier call; the same coordinator and supporters continue with their context and the coordinator's ledger (`write_ledger`, revision-checked).

### Workspaces and patches

- `shared`: the worker's directory, read-only natively (Codex read-only sandbox; Claude `dontAsk`, edit and planning tools removed, and a required sandbox denying writes to the workspace). Read-only persists across resume and refuses permission changes.
- `worktree`: a detached worktree at the call's commit under `<repository>/.agent-remote/worktrees/<team>/<member>`, excluded through `info/exclude`.
- `remote`: the worker's Host bundles the commit (after the call's base when given) under a temporary ref and uploads it as the worker's seat; the Relay grants it to the supporter only; the supporter's Host fetches it to `refs/agent-remote/support/<team>/<member>` and adds the worktree.
- `collect_supporter_patch` asks the supporter's Host for one binary patch of everything changed since the commit (committed, uncommitted and new files), grants it to the coordinator, who attaches it to a report. The worker downloads it with `download_support_resource`; nothing is applied or executed for it.
- A worktree is reused, and a patch collected, only where the path is its own git top level: a stray directory there would resolve to the worker's repository.
- Worktrees and support refs are removed once the Controller sees the supporter released or its Team archiving, and at once when the supporter's creation fails. A ref is deleted even when its directory cannot be, and the removal is retried.

### Worker tools

The `agent_remote` namespace holds `call_for_support`, `support_status`, `read_support_report` and `download_support_resource`. Only sessions without a Team or TPM role get it.

- Codex fixes dynamic tools at thread start, so every Controller-started thread without a role declares the namespace: direct when the session is enabled at creation, deferred otherwise, found with `tool_search` by search-capable models. Attachments rebind its executors.
- Claude gets the namespace as its own MCP server while enabled; enablement changes use `setMcpServers` on the live session. Namespace tools, and a read-only session's `agent_host` tools, are allowed by flag-layer permission rules so they run without native approval.
- No separate note is sent on enablement; tool descriptions say when to call.

### Delivery, idle release and usage

- Support groups deliver between turns: to a busy session a message waits until it is idle (or queues for the next turn where the provider supports it). Workers receive reports exactly as the Relay framed them.
- A group member's runtime is held while a delivery to it is pending, until it reports idle, and while its Team archives; otherwise the Host releases it and the next delivery resumes the same session. Ordinary Teams keep every member held, because the user drives those sessions directly and only a held runtime reports their presence.
- While held, a coordinator's or supporter's live usage is accounted (`session` and `runtime` totals by their increase, a runtime decrease as a new runtime; `turn` on completion; `call` as reported) and sent as cumulative `report_usage`. Reaching a budget bound pauses the group: claims to the coordinator and supporters are refused, the open call is reported `needs_input` to the worker, and the user raises the budget and resumes.

### Retention

- An archived group can be restored from its view. The worker's seat and the coordinator are provisioned again: the coordinator resumes its own session with its context, or a new session when that one can no longer be opened. Supporters stay released, since their worktrees went with the archive; a roster still waiting is rejected; the open call reaches the coordinator again. A worker has one active role per profile, so a restore waits until the other role is archived. A restore counts as use for idle archiving and removal. A removed group cannot be restored.
- A group without an open or queued call for a week is archived automatically. A group that is archiving takes no calls: a call for its profile starts a new group, and the website offers only active roles.
- Groups are created automatically, so groups are removed when a new Team would exceed the 128-Team limit, and on every Team change while the account's Team state is above 1.5 MiB (its bound is 2 MiB). Archived groups go first, then groups without an open or queued call, least recently used first (by their last call or report). A group used within the last hour is never removed, so an operation retried in that window finds its group. Ordinary Teams are never removed.
- A removal sweeps stored files, keeping only those of Teams that still exist, so files an interrupted sweep left go with the next removal.
- Bundles and collected patches are checked against their stored bytes but not pinned: like other unattached uploads they expire 24 hours after their last use, and attaching an expired one tells the coordinator to collect or upload it again. A report pins the resources it attaches until its group is removed.
- Controllers ask about groups missing from their poll with `support_group_states`, at most every ten minutes each, and forget the seats of archived and removed groups, so their local seat capacity is not exhausted. A seat whose worktree cannot be removed yet stays until it can; a removal that left an empty directory is finished, and a directory with content is left alone.

## Invariants

- The worker is the only writer of its workspace; supporters read it or write their own worktree.
- Only `report_support` creates coordinator-to-worker messages, and every report has a call; the worker never uses `send`.
- A group has exactly one requester seat, never at index 0; `shared` members are read-only and on the worker's Host.
- Controllers without the `callForSupport` capability neither poll nor act on groups; the uplink refuses Call For Support calls locally until the Relay acknowledged it.
- Provider descriptors carry no Call For Support field: read-only providers travel only with the Call For Support request.
- A report is at most 24 KiB of JSON; a group's state is compacted to 64 KiB (evidence of older reports, then their findings, then the oldest reported calls). The account's Team state keeps its 2 MiB bound; up to 128 Teams and groups.

## Limits

- The website offers Call For Support in the Team panel; its suggestion appears while profiles exist and none is enabled for the session. It does not inspect file changes or git state.
- A Codex session enabled after creation needs a search-capable model to find the deferred tools; the website call path always works.
- Copilot and OpenCode do not enforce read-only sessions and cannot receive tools after creation; they may be supporters only in `worktree` and `remote` workspaces.
- A remote fetch fails when the repository lacks the call's base; call again without a base. A remote supporter starts from its bundle within 24 hours, since the bundle is not kept longer.
- Writing only to their own worktree is a supporter's instruction and its provider's permissions, not an enforced sandbox; `shared` supporters are read-only natively.
- Rolling the Relay back to a version before Call For Support is safe only until the first group exists: older Relays reject saved groups and more than 32 Teams. After that, fix forward.
- A removed group's calls and reports are gone from the Relay: the worker keeps the reports it received, and `read_support_report` no longer finds them.

## Verification

- Protocol, Relay, Controller and website unit suites cover schemas, invariants, profiles, enablement, groups, rosters, reports, ledger, usage, pauses, projection, capacity, retention, negotiation, requester seats, extensions, deliveries, idle release, worktrees, bundles, patches, worker tools and injection.
- Native provider tests: `agent-provider-codex/src/read-only.local.test.ts`, `tool-namespaces.local.test.ts`; `agent-provider-claude/src/read-only.local.test.ts`, `tool-namespaces.local.test.ts`.
- End to end: `packages/agent-host/src/call-for-support.local.test.ts` (Codex worker on a search-capable fixture model, Codex coordinator, read-only Claude and Codex reviewers, a worktree fixer whose patch applies, and a follow-up that reuses the sessions). Run with `AGENT_CLAUDE_TEST_EXECUTABLE` and `BORGEE_CODEX_TEST_EXECUTABLE`.
- Browser: `packages/agent-remote-lab/e2e/call-for-support.spec.ts`.
