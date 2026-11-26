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
- Document [native sharing separately from sharing through the Host](providers.md#native-sharing-and-sharing-through-the-host): identify whether external native tools can join the same live service/session or must use the Host protocol. A private SDK connection does not require exclusive Remote page access, and Remote `sessionControl: shared` does not prove native multi-client support.
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

## Behaviour declaration

Every adapter states how its CLI behaves as data, in `descriptor.behaviour` (`packages/agent-provider-sdk/src/behaviour.ts`): how the CLI treats other clients of a session (`concurrency.model`, its probe, whether another client's turns are seen, and how long the CLI keeps a session loaded after its last client), what a reread gives (`reread`), what a resume costs and its deadline (`resume`), what happens to input (`input`), how a usage limit is signalled (`limits`), which failures the adapter raises typed (`failures`: `AgentRuntimeError` codes such as `native_usage_limited` with `resetsAt`, and `AgentSessionInUseError` reasons such as `writer_elsewhere` with `retryAfterMs`), the live-only item kinds, and the CLI version a native check confirmed. The Controller applies one policy per field and never branches on the provider id; the CLI simulator (`agent-controller/src/test-utils/simulated-cli.ts`) plays the same declaration. A value no native check has settled is declared conservatively and marked "assumed" in the adapter's `behaviour.ts`. A declaration with any value the contract does not name is replaced whole by the undeclared behaviour, which is what the Controller assumed before declarations existed.

## Journal support

A provider joins Relay journals only through its adapter: it declares `journal: { itemIdentity: 1 }` once every timeline observation carries an `itemIdentity` and continuity fixtures pass (see the Provider Contract in `docs/blueprint/agent-remote-observation.md`). The fixture records a live session and the same session opened again against the real runtime (Copilot's are `packages/agent-provider-copilot/tests/fixtures/journal`), and `continuityOutcome` must show that the Relay's journal answers `unchanged` when the reread window is compared with the journal the live session built; a difference of content is counted as one replacement with its reason, a difference of keys is fixed in the adapter. Until then the provider's sessions stay on forwarding, which is always safe. The Controller asks for `journal=1` only when some provider declares the capability.

## Conformance kit

Every journal-capable adapter passes the provider conformance kit (`@orchardworks/agent-provider-sdk/conformance`, clauses in [the kit's component file](components/provider-conformance-kit.md)), run by `pnpm test:providers` on mock data in seconds. An adapter joins it by exporting a subject from its `./recordings` entry, and adding the subject to `agent-controller/src/provider-conformance.test.ts`:
- its declaration, as `resolveAgentProviderBehaviour` reads it;
- its recordings of the real CLI, which must include `settled` and `restart`;
- a native fake (`src/test-utils/native-fake.ts`) that drives the real adapter through its own native port: a turn over one finished turn of history, read again; the CLI's limit signal; the CLI's refusal of a second writer, when it has one.

The kit holds the adapter to its declaration: the reread order, item identity and continuity of every recording (part 1), each declared behaviour through the native fake (part 3), and each fault the CLI simulator plays from the declaration through the Controller (part 2). A finding names the declared field the adapter contradicts: fix the adapter, or the declaration when the recordings show the declaration was wrong.

## Native assumption checks

Each CLI has a native assumption check, run by hand or nightly with `pnpm test:native:<cli>` (`codex`, `claude`, `copilot`, `opencode`, `pi`). It runs the real CLI in a temporary home against a scripted model, so nothing signs in and no session of the person's own CLIs is touched, and re-verifies against the installed version what the adapter declares and what its recordings record:
- the installed version is the declaration's `verifiedVersion`, and the version every recording's header names;
- the recorder, run against the committed recordings, finds the same shape (`recordingShape`);
- each declared field it can provoke holds: the probe and the refusal of a second writer, the echoed input id, every error text the adapter matches as words;
- a normal turn sends no event of a kind the adapter does not know.

A difference fails loudly and names the declared field. Update the adapter, the declaration or its lists, or record again and review the diff; then set `verifiedVersion` to the version the checks passed on.

## Verification and release record

Run existing relevant behavior tests with both per-test and outer deadlines. Root `pnpm test`, `pnpm test:e2e:flows` and `pnpm test:conformance` enforce outer deadlines; custom invocations need their own bounded wrapper. Select pinned native executables explicitly. Build before native tests that import `dist`. Use free test ports and preserve running user Hosts.

Record the exact tests, native versions, environment mode and result. A green fixture suite proves normalization against that fixture; a native CLI against a loopback model service proves process integration; neither proves an online model workflow or the deployed DSH plugin. Skipped live tests must remain unverified. Do not rerun unrelated suites solely to turn a documentation edit into a release claim.

Edit the hand-written parts of `compatibility.json` (native versions and degradation reasons) in the task; its implementation digest is regenerated and checked on `main` after the merge (`pnpm postmerge`). If implementation behavior changed, run build/typecheck and affected suites plus protocol/transport tests appropriate to the boundary. For a documentation-only audit, validate facts, row coverage, links and compatibility metadata; preserve prior runtime evidence with its actual revision.

Finish with a reviewable record containing supported behavior, conditional prerequisites, accepted losses, unavailable features, workarounds, verification limits and outstanding gaps. Publishing, merging and deployment are separate actions; the checklist is not authorization for them.
