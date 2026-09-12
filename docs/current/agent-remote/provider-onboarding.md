# New Provider comparison and acceptance checklist

Use the stable row IDs in [Provider support baseline](provider-support.md) before adding a Provider. The target is faithful normalization plus explicit gaps, not a clone of another runtime's CLI. [Claude's audit](claude-support-audit.md) and [Copilot's core admission audit](copilot-support-audit.md) provide examples at different implementation scopes. Do not change public semantics to make a support cell look complete.

## Admission contract

A Provider is ready for basic integration only when these invariants have evidence:

- Native identity, workspace/configuration ownership and supported create/resume behavior are explicit. Unsupported resume must fail explicitly; do not fabricate history or a new native identity under an old handle.
- History precedes exactly one `history_boundary`; live events carry stable source identity. Duplicate/overlapping observations cannot duplicate text or tools. Failures, unavailable history and unknown values stay visible.
- Text, reasoning, tools and lifecycle project only what the native runtime supplies. `callId` owns tool completion/result replacement; missing results and empty results remain distinct.
- Each advertised capability has a working adapter method and a native mapping. Missing/false capability disables the shared control. Re-evaluate live/saved child capabilities when native state changes.
- Input acceptance, native consumption, turn completion and process lifetime remain distinct. No blind retry after uncertain submission and no synthetic queue in Host, Relay or browser.
- Answers are validated against the exact outstanding request, allowed choices and scope; stale answers are rejected. Native sensitivity must be mapped so shared receipt/trace redaction can work.
- Read authority comes from a session-owned resource reference, never a user-supplied path. Bounded/truncated/unavailable outcomes are explicit.
- Root, child and observer ownership are separate. Dispose only owned native work; reject cross-provider and cross-parent attachment. Reconnect must not duplicate an owned process.
- Runtime configuration/authentication stays in the native profile/environment. No hidden Borgee dependency or credentials in source, fixtures, committed reports or browser state.

Prefer the corresponding public native client or service directly. Do not use private methods, Query replacement, synthetic queues or inferred metadata to turn a missing capability into apparent support. Record the gap and keep its flag disabled when native semantics differ.

## Fill the capability record before implementation

Copy this record once per root integration and once for materially different child/saved-view behavior. Link evidence; do not mark an unchecked row as supported.

| Field | Required content |
| --- | --- |
| Provider / integration | Provider ID; executable Host or in-process plugin; owning directory implementation. |
| Revision / compatibility | Audited implementation SHA, protocol/uplink version, native executable/library versions and optional service requirements. |
| Row ID / degree | Every S/I/T/X/C/R/A/H row from the baseline; S/C/P/N/U with the same definitions. N/A only when the behavior cannot apply, with a reason. |
| Native mapping | Native API/event/tool and its ownership/state prerequisite. Keep RPC names out of the public protocol. |
| Exposed path | SDK method/event → Host/plugin path → public operation → client/renderer/CLI surface. Name any missing endpoint. |
| Capability / descriptor | Actual flag, runtime setting or directory field. Child discovery has no invented `subagents: true` flag. |
| Scope / loss | Exact behavior, unsupported variants, provenance loss, size/type limits, mutation scope and restart boundary. |
| Workaround | Existing route, prerequisites, information/control lost, side effects, failure behavior; explicitly state if none exists. |
| Verification | Source link, test and command, deadline, native/fixture mode, observed result/date, skipped scenarios. |
| Gap cause / path | Adapter gap, conditional native capability, cross-layer change or evidence gap; name the native operation, affected endpoints and acceptance gate. Link the [gap ledger](provider-gap-analysis.md) where applicable. |
| Reference evidence | Distinguish a Paseo implementation from a native SDK declaration and from an Agent Remote test; record immutable revision/package version. |
| Disposition | Implemented, accepted bounded limitation, candidate gap, or blocked by missing native evidence. A candidate is not a promised feature. |

## Comparison groups and required probes

| Rows | Probe before claiming parity |
| --- | --- |
| S1–S5 | Create in a configured workspace; list/resume exact identity; duplicate concurrent loads; invalid handle/config; shared versus owned disposal; creation overrides versus native defaults. |
| I1–I5 | Idle send, busy immediate, explicit next-turn, cancellation and turn-boundary races. Record native acceptance/Inbox/turn evidence, not only UI text or an ACK. Confirm timeout does not duplicate submission. |
| T1–T6 | Saved/live overlap, split streaming/final messages, ordered multi-block messages, tool start/result/cancel, missing/empty/oversized output, todo/compaction, usage and absent metadata. |
| X1–X7 | For each supported interaction kind: allowed answer, invalid answer, stale ID, native cancellation, competing client, disconnect/reconnect, owner restart. Verify sensitive values reach native code but not public receipts/trace. |
| C1–C6 | Optional service absent, stale model/command/skill, discovery error, unchanged args, command/input/settings serialization, confirmed native setting state, scope side effects, document authority and read bounds. |
| R1–R2 | Referenced versus unreferenced resources, traversal/symlink replacement, unavailable/oversized media, immutable materialization and replay; text preview never silently becomes full download. |
| A1–A6 | Direct child versus grandchild/unrelated task, parent namespace, early notifications, same-runtime reuse, live/saved transition, independent history, per-child permissions, dispose, background lifetime and owner failure. Do not use a second standalone native session as a substitute for a native child. |
| H1–H3 | Real HTTP/WebSocket negotiation, exact protocol, snapshot/timeline recovery, reconnect and re-pair, duplicated create/attach, native owner loss, persisted versus transient state. |

## Endpoint acceptance

1. **Adapter:** implement native interpretation and report limits. Public schemas, Relay state and renderer must not need to recognize native event names.
2. **Host/plugin:** register the directory, workspace/model inputs and optional child path. A DSH-style shared runtime may need a plugin, not an executable in Agent Host. Keep temporary pairing and lifetime separate from credentials.
3. **Relay/protocol:** reuse existing command/event/resource/interaction semantics. If a real contract gap remains, document why an existing rail cannot express it before proposing a versioned change; synchronize strict schemas, fixtures and all participants together.
4. **Web/Lab:** use capability-driven controls, exact interaction types, opaque values and confirmed runtime state. Verify desktop/mobile through a real transport. Read-only and unavailable views must remain visibly constrained.
5. **Debugger:** check its actual command switch independently of headless-client support. Record missing entry points; do not claim CLI parity from shared types.
6. **Evidence/docs:** update the baseline row cells, Provider audit, runbook and `compatibility.json` degradation reasons. Retain native/fixture/deployment distinctions.

## Verification and release record

Run existing relevant behavior tests with both per-test and outer deadlines. Root `pnpm test`, `pnpm test:e2e` and `pnpm test:conformance` enforce outer deadlines; custom invocations need their own bounded wrapper. Select pinned native executables explicitly. Build before native tests that import `dist`. Use free test ports and preserve running user Hosts.

Record the exact tests, native versions, environment mode and result. A green fixture suite proves normalization against that fixture; a native CLI against a loopback model service proves process integration; neither proves an online model workflow or the deployed DSH plugin. Skipped live tests must remain unverified. Do not rerun unrelated suites solely to turn a documentation edit into a release claim.

Run `pnpm compatibility:update`, then independently `pnpm compatibility:check`. If implementation behavior changed, run build/typecheck and affected suites plus protocol/transport tests appropriate to the boundary. For a documentation-only audit, validate facts, row coverage, links and compatibility metadata; preserve prior runtime evidence with its actual revision.

Finish with a reviewable record containing supported behavior, conditional prerequisites, accepted losses, unavailable features, workarounds, verification limits and outstanding gaps. Publishing, merging and deployment are separate actions; the checklist is not authorization for them.
