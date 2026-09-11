# Native Provider parity implementation

Date: 2026-09-11. Branch: `feat/claude-provider`, following gap-ledger commit `821d1c6`. Targets: Claude Code 2.1.247 / Agent SDK 0.3.247, DSH 0.1.2-rc.1 at native revision `a66e4702047846cdaa10c66c9d3df3951f5ea70d`. This is a feature-worktree implementation record, not a deployed-release claim.

The [support matrix](provider-support.md) remains the per-endpoint comparison target. The [gap ledger](provider-gap-analysis.md) retains the Paseo evidence and outstanding admission gates.

## Native implementation policy

Use the Provider's public client or installed native service directly. The adapter translates native facts into existing Remote rails. Bounded projection, identity checks and storage of native-provided output bytes belong in that adapter. A hidden scheduler, Query restart, private SDK method, inferred filesystem authority or text impersonating a typed interaction does not establish support. Workarounds remain outside the supported capability scope.

No public protocol expansion was required: Remote 1.4.0 and Host uplink 2 are unchanged. Codex behavior is unchanged.

## Implemented native paths

| Provider / gap | Native entry point | Adapter / consumer scope |
| --- | --- | --- |
| Claude G1 | `Query.supportedModels`, `setModel`, `setPermissionMode` | Existing session-setting descriptors and Web controls. Model changes and default/acceptEdits/dontAsk/plan permissions require idle state and native confirmation. Planning restores the selected permission mode. No live effort setter or bypass-permission option. |
| Claude G5 | `CanUseTool` for `ExitPlanMode` with actual `input.plan` | Typed plan approval with approve-and-resume/reject. Native permission transition completes before callback allowance. Rejection returns feedback. Pending setting changes block new work even if the original turn is canceled. |
| Claude G8 | `SDKUserMessage.tool_use_result`, result `usage` / `modelUsage` / `total_cost_usd`, assistant `context_usage` | Bounded JSON when one tool result establishes ownership. Tokens cover the native per-turn main loop; cost is the increment of the Query cumulative value. Exact-model context capacity and native `/context` occupancy only. |
| Claude G9 | Native `tool_result.content` embedded base64 image sources | Root-session image references and `readResource` only. PNG/JPEG/GIF/WebP with matching media type/signature, 16 MiB/image, 64 MiB/session, 1,024 images; immutable bytes and explicit failures. No path/URL reads, upload or child resources. |
| DSH G13 | `subagents.listChildren`, `sessionQuery.observeSession`, native lifecycle events | Direct-child descriptors and ordinary Remote child bindings. Live or prepared immutable observations never activate a new Agent. Parent and child Timelines remain independent. Native origin, own descriptor, parent address and lifecycle must agree. |
| DSH G14 | `subagents.interruptByParent(childId, parentId, 'continuable')` | Cancel-only for live continuable children with a matching resident lifecycle; synchronous native admission, including parent-offline state. Saved/one-shot children and other direct controls remain disabled. |
| DSH G15 | `sessionController.modelCatalog` / `selectModel` | Model-specific effort choices with opaque provider/model/effort identity. Stale cross-model choices reject. The selected session value is native-owned; selection also attempts to save deployment defaults. |
| DSH G16 | `compaction/start` / `compaction/end` | Pair native compaction ID, turn and source command. Emit completion only on success. Failure/interruption emits a nonfatal error; no fabricated history replacement or successful completion. |

DSH child lookup has one overall deadline, including all catalog reads. Subscribe-before-cut buffering retains lifecycle witnesses and deduplicates exact native sequences; gaps, mutated prefixes and recreated identities fail explicitly. Optional child-discovery failure produces a diagnostic without stopping parent input or history. Closing a view releases subscriptions and observation leases, never native work.

The plugin now registers `providers: [dsh]` on the existing modern uplink. Root attachment, child attachment, provider-scoped discovery and creation remain separate paths. Canonical reattachment refreshes replaced native root Agents. Creation request identity survives transport/settings re-pairing in a process-local registry tied to the native context. Pending borrowed projections are released during shutdown so re-pairing does not fail on active observer ownership. This registry is not durable across process restart.

Cancel acknowledges native signal admission, not completion of the previously displayed turn. The native service acts on current work, preserves parked FIFO inputs and descendants, and may accept a natural-completion race as a no-op. Only native events confirm the outcome. No synthetic `turn_canceled`, queue flush or automatic waking input is emitted.

## Proven native gaps

- **Claude steer / queue:** a real `priority: next` message can be consumed after the original result, starting another native turn. Public `interrupt()` can return that message in `still_queued`, and it later executes. The adapter therefore advertises neither steer nor next-turn queue. Private bundled queue cancellation functions are not used.
- **Claude forms:** a real stdio MCP server can request primitive forms and receive submit/decline/cancel through `onElicitation`. However, the native client removes `pattern`, `multipleOf`, `writeOnly`, `sensitive` and `isSecret` before that callback while retaining defaults and some other constraints. The adapter cannot distinguish a stripped sensitive default from ordinary content. Form support stays disabled; no partial-schema workaround is advertised.
- **Claude external actions:** a URL callback is not proof of explicit user completion. The completion mapping remains unverified and disabled.
- **DSH child input:** native human `prompt` accepts the independent next-turn FIFO. An idle precheck cannot make it immediate because native admission includes asynchronous locking/recovery. Queue-only input needs an explicit shared capability/client admission design; send and steer remain disabled.
- **DSH compaction failure:** public compaction items have no native compaction ID or failed terminal state. An error is truthful but cannot replace the earlier loading item with a failed card. This is partial rendering support, not complete compaction UI parity.
- **DSH defaults:** native `selectModel` can confirm session selection while logging and suppressing a default-save failure. Remote cannot claim that deployment defaults were durably saved; the setting description states this limit.

## Endpoint and workaround boundaries

| Endpoint | Delivered responsibility | Still outside this scope |
| --- | --- | --- |
| Native adapters | Query settings/plan/result/usage mapping; DSH native child observation, effort and compaction. | No synthetic queue, inferred permission grants, guessed skill body or imported child runtime. |
| Agent Host / DSH plugin | Existing provider-scoped directory and binding rails; canonical native identity and observer ownership. | Native creation overrides still unavailable on DSH; no arbitrary native process attachment. |
| Protocol / Relay | Existing setting, interaction, child, resource, usage and Timeline contracts. | No new failed-compaction replacement, native history prepend or durable callback contract. |
| Shared Web / Lab | Capability-driven settings, plan cards and native child navigation. | A shared widget cannot create unsupported native semantics. |
| Debugger CLI | Existing public session inspection and controls. | G19 remains separate: no Host child-attach, settings, provider-command or queue entry point. Lab/headless use is a client-surface workaround only. |

Other gap-ledger work remains explicit: native effort setters, richer permission authority, skill provenance, child history rebase, atomic DSH creation overrides and debugger affordances have independent owners/gates. Existing `/fork` and side-conversation features remain context-transfer workarounds, not native forks or subagents.

## Validation evidence

- Claude `native-controls.local.test.ts`: real pinned CLI plus loopback model fixture; model/permission selection, exact plan approval/rejection, and negative priority/interrupt behavior. Unit tests also exercise delayed permission confirmation across cancellation.
- Claude `native-elicitation.local.test.ts`: real stdio MCP server and pinned CLI; ordinary submit/decline/cancel and direct capture of schema loss before the public callback. No production form mapper remains.
- Claude `native-usage.local.test.ts`: real Write output, two native turns and Query cost increments, plus native `/context` occupancy.
- Claude `native-images.local.test.ts`: pinned CLI Read tool returns exact native PNG bytes; root resource reads and native transcript resume retain identity/bytes; disposal revokes reads.
- DSH adapter tests: native service fixtures for exact child lineage, immutable cuts, snapshot races, lifecycle replacement, total deadlines, sequence gaps, parent failure isolation, effort and compaction. These fixtures do not certify the user's deployed native service.
- DSH `native-child-cancel.local.test.ts`: opt-in source probe uses native AgentLoop, persistence and a scripted model. It copies selected upstream test fixtures into a temporary directory, adds the actual child-adapter/service path, and never edits upstream. Exact native cancel/parked-input/parent authority behavior is checked without an online model. Set `DSH_NATIVE_TEST_REPO` explicitly; absent configuration is a skip.
- `dsh-host-broker.test.ts`: production plugin, uplink, broker, Relay and headless HTTP/WebSocket client; native services are fixtures. Parent input, child history/live/read-only rejection, parent isolation, provider discovery, re-pair, canonical bindings and concurrent create identity are covered.
- `agent-remote.test.ts`: transport and pending-binding shutdown regressions preserve native Agent ownership and subsequent pairing.
- `claude-discovery.spec.ts`: deterministic Query with production Host/uplink/Relay/Web on desktop/mobile; model/permission controls, plan review, skills and child navigation. This is browser integration evidence, distinct from the real CLI probes.

Tests use per-test and outer deadlines. Validation starts separate services on configurable free ports and preserves existing local Hosts and consoles. No deployed DSH or online model-service acceptance is inferred from these checks.

### Final verification, 2026-09-11

- Workspace build and typecheck passed. After the compatibility validator/fixture updates, Lab build and typecheck passed again.
- Root package tests passed for SDK (37), protocol (61), Codex (188), Claude (66), DSH (187), Web (139), Relay (179), Host (37), DSH plugin (79), and debugger (80): 1,053 passing tests outside Lab.
- The first combined run exposed stale Lab degradation lists and a full-module mock missing the new child export. After synchronizing the lists and retaining real exports in that mock, the complete Lab suite passed: 256 passed, 6 skipped. Combined package coverage is 1,309 passed and 6 skipped across the root run and affected-suite rerun; this is not a claim that the original root command exited successfully.
- Relay conformance passed all 13 tests. The final desktop/mobile browser rerun passed all 6 Claude discovery and Host provider tests, using separate free ports.
- Native-process validation used Codex 0.148.0 and Claude Code 2.1.247. The opt-in DSH probe passed 9 selected native cases; 107 unrelated upstream cases were deselected. Its parent-offline check controls registry visibility, not a complete parent-process exit.
- Compatibility metadata regeneration/check and whitespace validation passed before the local commit. Existing running consoles were preserved; they are not claimed to have loaded this implementation.
