# Public Session Boundaries Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans after design approval. Execute tasks in sequence and review each independently; implementation is authorized by the user; publishing and deployment are not included.

**Goal:** Give Host, DSH and standalone ARDB the same bounded session-operation guarantees while keeping native lifecycle and product policies explicit.

**Architecture:** Expose a consumer boundary for the logical Session View module and a separate typed implementation-extension boundary. Put reusable settlement and binding mechanisms in `agent-remote-relay`, native meaning in the Provider SDK/adapters, and client state/rendering in `agent-remote-web`. Host/DSH implement trusted scope, admission and lifecycle extensions; product/ARDB consume session state/actions and compose their surroundings. Headless use is a first-class consumer.

**Tech Stack:** TypeScript, Node.js 22+, pnpm 10, Vitest, real WebSocket transports and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-public-session-boundaries-design.md` (approved for implementation with unified session lifecycle maintenance).

## Execution status

All four implementation stages are complete in the dedicated worktree. Implementation reviews and regression verification are complete, with the baseline/environment limitations below; no commit, merge, push or deployment is included.

| Stage | Implemented result | Execution adjustment |
| --- | --- | --- |
| 1 | Relay-owned settlement across Host, DSH uplink, standalone WebSocket, HTTP and plugin entry points | Creation/resume ownership begins before metadata/history readiness; native disposal runs concurrently with settlement draining. |
| 2 | Shared state reducer, operation availability, authoritative server admission and explicit no-effect rejection | Observation failure preserves activity and marks native connection unavailable. Native-control synchronization belongs to the public client, with an endpoint extension. |
| 3 | Shared binding registry, native-create retention and conservative unknown-creation handling | Extended existing Host/DSH integration tests plus the three-host socket suite instead of creating a separate session-binding transport file. |
| 4 | Public session lease hook/actions, product wrapper and shared live/replay renderer | Extracted the neutral hook into Web; kept the renderer and its presentation dependencies in Lab. Package location is not the abstraction boundary. |

Checkboxes below describe the original execution checklist. Detailed completion, rulings, review findings and verification evidence are recorded in `.superpowers/sdd/2026-09-26-public-session-boundaries/progress.md`. The maintained consumer and extension contracts are documented in `docs/current/agent-remote/session-boundaries.md`.

## Global Constraints

- Source baseline: `eef85749c988475098e1b49619ca7a952f9fea8a`; recheck the actual execution baseline.
- Use dedicated `.worktrees/` checkouts; preserve running services and user material.
- Code, comments and documentation are English; user communication is Chinese.
- No hidden account or Borgee dependency in standalone ARDB. Pairing remains process-local.
- No persistent operation ledger, automatic uncertain-mutation replay, universal native reconnect or invented capability.
- Retain current settlement defaults: 10-minute terminal retention, 1,000 entries, 8 MiB; retain in-flight entries.
- Every test run has a per-test deadline and an outer process deadline. Build before tests importing `dist`.
- Synchronize fixtures and compatibility metadata; run `pnpm compatibility:update` and `pnpm compatibility:check` after reviewed implementation.
- Publishing, pushing, merging and deployment require their own user instruction.

## Boundary map before implementation

- [x] For every affected behavior, record its consumer state/actions, core invariant, implementation extension, authoritative fact source and side-effect executor. Use the design's four-column table as the starting map.
- [x] Inventory existing contracts before adding interfaces. Provider SDK extensions own native meaning; Host/runtime extensions own environment admission and resource handling. Public consumer APIs expose normalized capabilities and outcomes, never raw process handles.
- [x] Distinguish surrounding policy from implementation variation: Tracked decides what to retain; the framework manages subscription lifetime; native extensions decide what detach/release means. Controller upgrade orchestration consumes lifecycle facts rather than defining settlement rules.
- [x] Trace takeover end to end: common UI/headless action, server authority/settlement, then native ownership extension when needed. Preserve shared operation, browser-only transfer and native process handoff as distinct supported behaviors. Do not prescribe new wire fields until the existing contracts prove insufficient.
- [x] Record missing contracts within the corresponding task below. This map does not authorize a universal plugin framework or require all extensions to be introduced in Task 1.

## Task 1: Shared operation settlement across all writable entry points

**Files:**
- Move implementation/tests: `packages/agent-host/src/operation-cache.ts` and `.test.ts` to `packages/agent-remote-relay/src/operation-cache.ts` and `.test.ts`.
- Modify: `packages/agent-remote-relay/src/index.ts`, `relay.ts`, `session-wire.ts`, `transport/websocket-stream.ts`, `transport/plugin-host.ts`, `transport/remote-host-plugin.ts`, `transport/remote-host-uplink-client.ts`.
- Modify integrations: `packages/agent-host/src/host.ts`, `packages/agent-remote-dsh/src/agent-remote.ts`, `packages/agent-remote-debugger/src/server.ts` as needed for service ownership.
- Add conformance suite: `packages/agent-remote-lab/src/operation-settlement.transport.test.ts`.
- Update: `docs/current/agent-remote/protocol.md`, `packages/agent-remote-lab/compatibility.json`.

**Interfaces:** Preserve `OperationDescriptor`, `OperationWork`, `OperationCache`, `OperationCacheOptions`, `SessionWireOperation` and `SessionWireOperationExecutor`. Use a runtime-owned cache/executor in all composition paths; the public wire cannot silently choose direct dispatch. Define narrow typed lifecycle extension contracts for retention/draining/uncertainty integration outside the generic cache. Implementations supply native behavior and facts, not alternative settlement rules. Resolve scope and native target from trusted integration state.

- [x] Add a real-transport conformance fixture with `host`, `dsh` and `standalone` variants. Each exposes connect/disconnect, sending the existing operation envelope, collecting receipts, and reading the native dispatch counter. A DSH fixture must use its actual integration entry point, not an injected Host executor.
- [x] Demonstrate current failures: repeat one `send_message` operation on a fresh socket after dropping its first receipt; assert one native dispatch and the original terminal result. Run the same case concurrently from two authorized connections.
- [x] Add intent and authority cases: changed text/kind/native target conflicts; a new public binding to the same native target reuses the retained outcome; foreign scope does not retrieve another scope's receipt; revoked control cannot obtain a write receipt or dispatch through a cache hit.
- [x] Move the cache, preserving its behavioral tests. Remove Codex-specific wording/classification from the generic mechanism; keep uncertainty classification conservative until Task 2 supplies explicit rejection evidence.
- [x] Separate Controller update policy from runtime lifecycle participation. Verify lifecycle extensions can reject before dispatch or retain uncertain native resources without changing cached outcome semantics or replaying native work.
- [x] Make Relay own the default service instance; allow Host to supply one shared with native creation/rename. Wire DSH and both standalone transports to it. Verify uplink/browser reconnects do not replace it. Shutdown closes it exactly once; native work is not canceled by socket teardown.
- [x] Verify capacity rejection, no in-flight eviction, terminal TTL and explicit service replacement behavior. Service replacement is a new guarantee scope, not a promise that old operations remain deduplicated.
- [x] Run affected Host, DSH, Relay and ARDB tests, followed by conformance with real sockets. Update documentation and compatibility metadata; review the full entry-point inventory before committing this phase.

An extraction-preservation test can start from this existing API:

```ts
const cache = createOperationCache();
const intent = {
  operationId: '00000000-0000-4000-8000-000000000001',
  scope: 'trusted-authority-and-service', kind: 'send_message',
  target: JSON.stringify(['provider', 'native-session']),
  parameters: { text: 'hello' },
};
const dispatch = vi.fn(async () => ({ accepted: true }));
try {
  await Promise.all([
    cache.execute(intent, { dispatch }),
    cache.execute(intent, { dispatch }),
  ]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(cache.execute({ ...intent, parameters: { text: 'changed' } }, { dispatch }))
    .rejects.toMatchObject({ code: 'operation_conflict' });
} finally { await cache.close(); }
```

This unit case does not replace the three integration variants above.

## Task 2: Shared session lifecycle, operation eligibility and trustworthy rejection

**Files:**
- Modify: `packages/agent-provider-sdk/src/provider.ts`, `provider.test.ts` for a typed adapter-confirmed rejection signal.
- Modify: `packages/agent-remote-relay/src/agent-manager.ts`, `session-wire.ts`, shared operation cache and associated tests.
- Modify: `packages/agent-remote-web/src/client/remote-session-client.ts` and `.test.ts` only where headless eligibility differs from the public contract.
- Modify proven native mappings in the corresponding `agent-provider-*` packages; do not classify arbitrary exceptions by message text.
- Extend Task 1's transport conformance suite and `packages/agent-remote-lab/src/session-control-transport.test.ts`.

**Interfaces:** Maintain native-derived session state in a shared lifecycle reducer used by server and client projection; expose common eligibility to headless and rendered consumers. Retain `AgentRuntimeConnection`, `AgentCapabilities`, existing control state and pending interactions. Add only a narrow SDK rejection type whose documented meaning is that the requested effect was not applied. Keep transport synchronization status distinct from operation-specific authority. An execution timeout remains uncertain.

- [x] Write an operation matrix for send, next-turn input, steer, cancel, settings, command execution and interaction response using existing capabilities and authoritative native state. Cover shared/exclusive control separately; shared sessions must not acquire exclusive takeover semantics.
- [x] Map each availability reason to an authoritative extension or core fact and a normalized consumer representation. Exercise the same headless/UI control actions against shared and exclusive fixtures without Provider-name branches. A missing extension must yield explicit unsupported behavior, never a simulated implementation.
- [x] Add failing cases for native restoring/unavailable, control revoked during asynchronous validation, stale interaction, still-valid interaction after browser reconnect, and observation-ready/read-only sessions.
- [x] Add classification cases: local validation rejection; typed native rejection; generic native exception; lost native response; native success with an unretainable result. Assert receipts and dispatch counts, including repeated requests.
- [x] Place common admission in server dispatch paths and reuse eligibility reasons on clients. Recheck native conditions in adapters; a client-side readiness helper is not enforcement. Do not reject all operations merely because the agent is working.
- [x] Preserve distinct identities: connection generation retires callbacks, control revision retires authority, native interaction identity follows adapter validity, and operation ID retains intent across reconnect. Keep cached history visible and ordinary unsent input queued; never auto-flush uncertain sends.
- [x] Validate headless ARDB and the browser against the same recovering session. If external schema fields become necessary, stop to review schema/version negotiation and old-client behavior before implementation.
- [x] Run public contract, adapter fixture, client and real-transport tests; document the matrix, update compatibility; leave the reviewed changes uncommitted.

## Task 3: Binding invariants and creation recovery

**Files:**
- Add: `packages/agent-remote-relay/src/session-bindings.ts` and `.test.ts` as an internal shared service.
- Modify: `packages/agent-host/src/host.ts`, `packages/agent-remote-dsh/src/agent-remote.ts` and their existing tests.
- Preserve: `packages/agent-remote-relay/src/remote-host-catalog.ts` and Provider-native directory implementations.
- Add: `packages/agent-remote-lab/src/session-binding.transport.test.ts` for paired integration cases.

**Interfaces:** Binding identity consists of service namespace, provider, native session, public agent and optional native parent. Registry transitions reserve, publish or release a binding. Native open/admission/dispose use typed integration extension contracts with explicit ownership and release semantics; the registry cannot terminate native processes. The public consumer sees binding/capability/outcome state rather than choosing native disposal algorithms.

- [x] Add races: concurrent identical native opens, same public agent with different native targets, same native target with incompatible parents, open failure before publication, and close/dispose during pending open.
- [x] Add create-success/attach-failure recovery: a repeated creation intent must attach the known native ID without another create. Also cover changed creation parameters and operation scope.
- [x] Extract the actual duplicated identity checks and reservation transitions from both integrations. Keep native ownership validation and workspace policy implemented by their integrations behind explicit extension contracts; preserve common enforcement before publication.
- [x] Preserve DSH native-ID allocation across transport replacement and its rejection of unsupported settings. Do not replace its native creation registry with an expiring receipt cache.
- [x] Keep `RemoteHostCatalog` unchanged unless a demonstrated defect requires a separate fix. Preserve exact-ID opening independent of catalog enumeration and all Host workspace admission checks.
- [x] Run binding/catalog/create tests and real-transport conformance, verify borrowed DSH sessions are not stopped on view disposal, update compatibility; leave the reviewed changes uncommitted.

## Task 4: Explicit session-view composition

**Files:**
- Refactor: `packages/agent-remote-lab/src/hooks/useConversationSession.ts`, `conversation-connections.ts`, `components/LabWorkbench.tsx`.
- Adapt: `packages/agent-remote-debugger/web/index.tsx`, `session-view.tsx`, `replay.tsx`.
- Create after isolation: `packages/agent-remote-web/src/react/SessionView.tsx` and its behavioral tests; export through the existing React entry point.
- Extend: `packages/agent-remote-debugger/src/cli-process.test.ts` and existing Lab browser tests.

**Interfaces:** Reuse `AgentReplicaState`, `RemoteSessionStatus` and the session-only actions currently represented by `LabWorkbenchActions` for the logical module's headless and rendered consumers. Supply account gating/error presentation and optional product content through composition. Takeover is a common control action backed by the core and native extensions, not a product-owned native handler. Retention policy and persistence storage belong to the product owner; expose subscription retention/release and lifecycle notifications sufficient to implement that policy.

- [x] Record current behavior: identical normalized input yields the same timeline/composer in product and ARDB; standalone does not call account endpoints; replay remains read-only and cannot restore control tokens.
- [x] Separate product contexts from the reusable hook/component without changing package location or visible behavior. Supply neutral standalone defaults rather than simulated authentication.
- [x] Verify both dependency directions: product/ARDB consume the session interface; runtime/adapters implement extension interfaces. Core code must not import consumer contexts; consumer code must not inspect PID/socket/SDK details to decide session behavior.
- [x] Move only the dependency-clean view/hook to the existing Web package. Leave Tracked/Favorites/navigation/security and ARDB recording/file access with their shells. Preserve styles by responsibility, not by importing the whole product stylesheet.
- [x] Verify live input, approvals, pending input, reconnect, draft preservation, replay, mobile layout and collapsed debug overlay. Inspect the dependency graph as well as observable behavior.
- [x] Run browser tests after build, update compatibility; leave the reviewed changes uncommitted. Skip package moves for components still requiring a product policy; keep explicit adapters instead.

## Verification and rollout

Use repository test runners when their suites match the phase. For narrower Vitest execution, enforce an outer deadline, for example:

```sh
python3 - <<'PY'
import os, subprocess
env = dict(os.environ, NODE_OPTIONS='--no-experimental-webstorage')
subprocess.run([
    'pnpm', '--filter', '@orchardworks/agent-remote-relay', 'exec', 'vitest', 'run',
    '--testTimeout=30000', '--hookTimeout=30000', '--maxWorkers=2',
], env=env, check=True, timeout=240)
PY
```

After each phase: review diff, run affected tests/typechecks, build, run any packaged/browser tests sequentially after build, then compatibility update/check. Real Provider tests require isolated native sessions and explicit runtime availability; report them separately from contract fixtures.

Runtime phases require Controller and DSH integration releases and a rebuilt ARDB; UI changes require website deployment. Internal TypeScript signature changes require package API review even if the wire is unchanged. Public schema changes require synchronized fixtures, version/negotiation review and a mixed-version test. Do not claim deployment parity until the relevant integrations are updated.

Implement all four tasks as reviewed stages. Task 2's contract decisions must be considered while extracting but must not become an unreviewed native lifecycle rewrite. Tasks 3 and 4 remain separate reviewable changes.

## Verification record

- Repository build, typecheck and compatibility check passed. Compatibility metadata was regenerated after the reviewed changes.
- Affected packages: Relay 291, Host 442, DSH 81, Web 432, Lab 730, ARDB 102 and Hosted 185 tests passed. All runs used per-test and outer deadlines.
- Additional non-native suites passed: SDK 41, protocol 170, Codex 311, Claude 85, Copilot 89 and OpenCode 103.
- The product browser subset on both this worktree and pristine `eef85749` produced the same 19 passed, 15 skipped and 8 failed cases. Existing failures concern multiline recorded rendering, mobile viewport/scroll behavior and Settings fixtures. They remain baseline limitations, not passing results.
- Live Provider certification is incomplete: the local Codex executable is 0.46 while the fixture requires 0.148; Claude and independent native Host tests need their configured native environment. Existing daemons were not restarted.
- Root `pnpm test` currently supplies conflicting hookTimeout arguments, so equivalent package Vitest runs were used with explicit deadlines.
- A final hook/Composer regression verifies local queuing during access restoration and exactly one dispatch after access returns. Read-only recording behavior is separately covered.
- No commit, merge, push, release or deployment was performed.


## Abstraction review follow-up

- [x] Carry authority through Manager queues and asynchronous preparation, with a final synchronous guard immediately before native mutation. Fence queued exclusive writes after takeover; preserve shared writers.
- [x] Classify local preparation failures as definite rejection. Keep uncertain native calls and failures after successful native dispatch uncertain, including metadata refresh failures.
- [x] Move native handoff progress and unknown-result retry policy into the public client. Reuse the same coordinator for pre-attachment targets, retaining each target/owner identity across navigation.
- [x] Subscribe product, side views and ARDB to public handoff state. Keep the notice limited to presentation and user intent.
- [x] Add regression coverage for queued authority changes over real WebSockets, preparation/dispatch outcomes, headless retries, view remounts, target switching and aborted endpoint requests.
- [x] Complete affected-package regression runs and final compatibility validation after review.

Follow-up validation: build, typecheck and compatibility check passed. The seven affected packages passed 2,273 non-native tests (Relay 297, Host 442, DSH 81, Web 436, Lab 730, ARDB 102, Hosted 185). Local native suites were excluded; the separately discovered Lab Codex Host process test could not run because `BORGEE_CODEX_TEST_EXECUTABLE` is not configured. Real WebSocket tests cover both exclusive transfer fencing and shared concurrent writers. Independent review confirmed retained handoff state across A/B/A target switching. No commit or deployment was performed.

## Handoff lifetime and extension result review

The earlier remount validation reused the same coordinator and did not cover client collection. Two failing regressions confirmed that client recreation and unrecognized transport error codes could each permit another interruption for an unconfirmed owner.

- [x] Introduce public `SessionHandoffScope`, separate from connection leases. Default to the transport authority lifetime; allow explicit reuse across transport/binding replacement and stable native target identities.
- [x] Use the same host/provider/native target scope for product pre-attachment and bound clients. Connection collection no longer removes unconfirmed intent.
- [x] Replace error-code guessing with `SessionHandoffRejectedError`, an explicit no-interruption guarantee. All other failures remain unknown, as do failures after restoration started and failed checks of previously unknown operations.
- [x] Cover recreated headless clients, transport/binding replacement, authority/target isolation, concurrent consumers and both real WebSocket transport modes with untracked connection collection.
- [x] Independently review the increment and update the public boundary documentation.

Validation: repository build and typecheck passed; final Web typecheck and compatibility check passed. Web 443 and ARDB 102 tests passed. Lab passed 732 tests in aggregate, with 6 skipped: its initial run had 9 failures because a test added after build made the compatibility digest stale; after regenerating metadata, both affected files passed all 14 tests. No production behavior changed to address that validation ordering error. Native local suites and the unconfigured Codex Host process suite were excluded. This increment did not perform live Provider fault injection, commit, merge, push or deployment.
