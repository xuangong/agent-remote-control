# Copilot support audit

This records core admission on `feat/copilot-provider`, with final native integration and launcher lifecycle validation through `2fd9c1a`. It is not a full-parity or published-release claim. The [baseline](provider-support.md) includes all 40 Copilot S/I/T/X/C/R/A/H cells. Public protocol remains 1.5.0 and Host uplink remains 2.

## Native boundary and comparison

Agent Remote pins official `@github/copilot-sdk` **1.0.11** and `@github/copilot` CLI **1.0.83**. `CopilotClient` with `RuntimeConnection.forStdio` owns the transport. The default executable resolves the declared CLI package bin; an explicit executable is supported. Host preflight requires CLI 1.0.83 or newer; newer releases have not automatically passed this audit.

Borgee's separately inspected agents-host integration also uses official SDK 1.0.11 with `CopilotClient` and `RuntimeConnection.forStdio`. Matching the SDK choice does not create a source, package, service, workspace or credential dependency on Borgee.

Paseo at immutable revision [`f22a37e613e965c8ebc02e1f5565e21fd72eaf2f`](https://github.com/getpaseo/paseo/blob/f22a37e613e965c8ebc02e1f5565e21fd72eaf2f/packages/server/src/server/agent/providers/copilot-acp-agent.ts) launches `copilot --acp` with the ACP SDK. Its [base ACP client](https://github.com/getpaseo/paseo/blob/f22a37e613e965c8ebc02e1f5565e21fd72eaf2f/packages/server/src/server/agent/providers/acp-agent.ts) and Copilot mode adapter expose model/Agent/Plan/Allow All/custom-agent selection. These are comparison evidence, not proof of official Copilot SDK behavior here. Agent Remote explicitly uses the official Copilot SDK, not ACP, and does not copy those mode controls into unsupported capability flags.

Public `session.rpc.model`, `skills`, `commands`, `tasks`, `metadata`, `permissions`, `interruptMainTurn`, `eventLog`, and client skill discovery methods are **experimental SDK APIs**. Tests exercise public native calls directly; there are no private RPC or filesystem-history fallbacks. CLI 1.0.39 lacks the required event-log method and is outside this acceptance target.

## Implemented scope

- Root creation, native identity/catalog, saved resume, event history followed by exactly one boundary, append-only deltas and final suffix reconciliation, reasoning, tool identity/results and token counts use existing Provider SDK observations. Host owns directory loading, workspace selection and executable preflight; Relay and renderer interpret only existing public events.
- Native enqueue preserves distinct interactions. Native immediate input can steer within the same interaction during tool steps, or become queued delivery if the interaction has ended. Reused native `turnId: 0` and a single final `assistant.idle` are insufficient to count public turns; authoritative interaction/delivery fields group both live and historical events. The adapter adds no synthetic input queue.
- Native single-choice/freeform questions and one-time/session-scoped tool approval use validated public interactions. Main cancellation targets the foreground, preserving child-owned requests. Native question callbacks omit request/agent IDs; only unique complete-payload matches bind. Identical concurrent unbound questions fail explicitly instead of guessing an owner. No sensitivity marker is invented.
- Model choices require a successful native catalog. Writes require native idle state; deferred native writes report unconfirmed application and actual model-change events refresh state. Authenticated ARDB catalog switching was separately exercised on 2026-09-24. Runtime effort choices now use native model metadata and readback; planning mode and typed plan review are mapped. The tool-approval setting is described below; it is not a filesystem/network bypass mode.
- Enabled user-invocable skills come from native discovery. `commands.invoke` resolves body/arguments and native display text. Documentation revalidates the current locator and reads a regular file without following a final symlink, at most 256 KiB. Markdown bytes use existing `text/plain` resource semantics. It is a current document read, not an immutable output attachment. Tool previews use the common 65,536-character/128-block bound.
- Parent task discovery and filtered paginated event-log history expose independent child views and repeated native task input/cancel. Parent owns child questions/approvals. Closing a child view does not cancel work. Children have no standalone queue, settings, resources, cold root resume or external spawn API. Parent disposal closes views and owned runtime lifetime.
- Compaction start/success is projected; failed compaction emits an error rather than a false completion. No failed compaction-card replacement rail is invented.

## Evidence and limits

[`src/provider.test.ts`](../../../packages/agent-provider-copilot/src/provider.test.ts) and [`src/projector.test.ts`](../../../packages/agent-provider-copilot/src/projector.test.ts) cover lifecycle, overlap, unique callback routing, cancellation ownership, settings, repeated child events, compaction failure and bounded/current/no-final-symlink skill reads.

[`tests/native.test.ts`](../../../packages/agent-provider-copilot/tests/native.test.ts) uses the real official SDK and pinned CLI over stdio against a deterministic loopback OpenAI-compatible model fixture. Four maintained tests verify:

1. Queued root interactions create two public turns and reconstruct them on exact saved resume; native catalog contains the saved identity.
2. Immediate input through a real tool/approval step stays in one interaction, including resumed history.
3. Native skill body and arguments reach the model request; question answer and successful shell approval span multiple model steps within one public turn.
4. Root cancel leaves child approval answerable; the approved child bash tool actually succeeds; repeated child input yields distinct turns and reopened child history preserves both.

Run `NODE_OPTIONS=--no-experimental-webstorage pnpm test:copilot`. Unit cases have 10-second deadlines, native cases 45 seconds, hooks 30 seconds; the root runner imposes a 540-second outer process deadline. Each fixture uses isolated native profile/workspace, a free local port and owned-process cleanup. The native observation fixture also uses the actual Relay TimelineStore/projector to assert exact-once root/child text and retained tool results in live and saved history. Skill reads use the actual ResourceIngestor and verify the resulting plain-text bytes. No cloud prompts are sent. Authentication status was inspected read-only during preparation; it does not certify a paid/account model workflow.

Host registration/directory/launcher behavior is covered in their existing Copilot tests. Generic `host-provider.spec.ts` additionally selects Copilot over a real Host uplink using Recorded responses: this verifies provider-neutral UI routing, not native model behavior. Whole-branch build, full suite and browser acceptance are recorded separately by the branch controller.

Remaining limits include granular grants, output-image rendering, a USD cost meter, PTY control, and native modes without an exact normalized counterpart. Forms, plan review, URL elicitation, todos, input-image history resources and context capacity now have mappings; see the current adapter inventory below. Native saved history does not resurrect process-local callbacks, running task ownership or broker bindings after a cold restart. An external native terminal remains a separate runtime. Debugger lacks the same Host/command/settings/queue entry points documented in the baseline; use existing Lab/headless paths where supported, without treating manual native operation as Remote parity.


## Branch acceptance (2026-09-12)

- Whole-repository `pnpm test` at `9714aea`: **1,384 passed, 7 skipped**, with Codex CLI 0.148.0 and Claude Code 2.1.247 selected explicitly. Copilot **37/37** includes the four real SDK/CLI loopback scenarios. Whole-repository typecheck and build passed.
- `pnpm test:e2e host-provider.spec.ts`: **6/6**, covering Codex, Claude and Copilot selection on desktop and mobile over the real Host uplink with Recorded responses.
- A separate browser exercise used real Copilot SDK/CLI, Host, Broker and built Web with an isolated loopback model. Root responses appeared exactly once; skill documentation opened and native invocation executed; the native child view showed its initial history and second input before its second answer, each exactly once. The temporary model/profile were removed afterward. No cloud-account model prompt was submitted.
- Final launcher fixes at `2fd9c1a`: Host executable tests **8/8**, setup tests **24/24**, followed by **4/4** focused process-order checks after the final fallback adjustment. Host typecheck and compatibility checks passed. The complete earlier suite is separate evidence from these final covering checks.
- Real rebuilt Copilot launcher startup and PID-only SIGTERM passed: exit 0, no SDK stream/forced-shutdown error, all ten recorded owned processes exited, both listeners were released, and readiness/lock files were removed. The controller was started again for manual testing. Existing unrelated services were preserved.
- Independent task reviews, whole-branch review and the final scoped fix review are complete with no remaining code-review blockers. Public Remote protocol and Host uplink versions remain unchanged.

The callback ambiguity limitation above is intentional: SDK 1.0.11 does not provide enough callback identity to safely route identical simultaneous unbound questions. Those requests fail explicitly; independent child controls, cloud authentication/model switching and the other unavailable capabilities above are not implied by these passing checks.

## Normalized adapter coverage (2026-09-24)

This work changes the Copilot adapter and tests, without adding public wire variants or changing Relay/renderer behavior. The installed SDK is 1.0.11; the package manifest pins CLI 1.0.83 but the resolved local executable reports 1.0.84-5. Runtime results apply to that executable.

- Restores completed permission records from durable request/completion pairs, without reopening them. Parent-owned child interactions stay on the parent. A reset native model-step counter identifies a completed run followed by a background-triggered run, preserving public turn IDs across history/live projection.
- Streams reasoning with final-suffix reconciliation, suppresses empty rows, publishes bounded partial tool snapshots and structured JSON results, and maps context usage plus compaction trigger/pre-token metadata. Native cost is a billing multiplier, not USD.
- Reads native todos on open and notification, publishing serialized changed snapshots including clear. Historical snapshots are not invented from current SQL state.
- Maps plan mode, exit-only approval, interactive approval/continuation and rejection. Native autopilot options are not mislabeled as these actions. Mode readback is authoritative.
- Maps MCP forms and URL elicitation using unique callback/event identity, strict supported schemas, validation, sensitive receipt redaction, and explicit invalidation on cancellation. Real MCP testing verifies a native writeOnly marker survives this runtime and is normalized as sensitive; Claude's separate native limitation is not assumed to apply here.
- Exposes selected-model effort from native metadata (including session RPC snake_case fields), with session-scoped updates. Image limits use the same metadata. Root input images use blob attachments and session-owned resource references; native binary asset events restore saved image bytes. No arbitrary path/URL resource read is introduced.

Native loopback fixtures cover the SDK, stdio CLI, local model server and Relay projection. Unit fixtures cover live/history comparisons, unsupported controls, stale interaction cancellation and resource bounds. Cloud ARDB checks and browser validation are recorded separately from this deterministic suite. A normalized JSONL replay preserves observed transient events; native resume cannot restore question/reasoning/plan/form events omitted by the native journal.

Current validation: **55 Copilot tests in 4 files**, including **8 real SDK/CLI scenarios**; **98 ARDB tests**; repository typecheck; Copilot/ARDB builds; compatibility update/check. Reprojecting the previously captured native journal preserves all 16 message IDs, texts and public turn IDs and restores both durable approvals. In a separate authenticated ARDB instance, effort changed to low with public readback, plan mode toggled on/off, and the unmodified Session View uploaded a red image, received the correct native answer, retained it after reload, and loaded the image preview. These are local worktree results, not a merge, deployment or release claim.


## Approval usability follow-up

- Human permission intent is rendered once, with the structured command or path; native warnings remain visible. Path access and read-tool approval carry distinct labels because they are separate native checks, not duplicate delivery of one request.
- Session grants follow native prompt eligibility. Live receipts preserve the selected scope even when native completion arrives before the permission RPC response.
- The native stdio runtime supports `permissions.setApproveAll` and `configure`, but rejects SDK-declared `getAllowAll/setAllowAll` as unhandled methods. The Permissions setting therefore controls tool approvals only; it does not claim full filesystem/network bypass or Auto mode. Existing native session grants remain effective when returning to asking. Restored policy is not guessed.
- Disconnected Session Views retain pending approval contents and disabled controls with a reconnect message instead of falsely claiming that the Host cannot handle the interaction.
- Native durable permission completions do not identify the selected approval scope. Historical reconstruction currently retains the existing once-scoped receipt representation; live JSONL receipts preserve the actual scope. This historical limitation remains separate from native grant enforcement.

Follow-up validation: 66 Copilot tests (10 real SDK/stdio scenarios), 98 ARDB tests, 42 shared interaction/timeline tests, 28 workbench tests, repository typecheck and builds, and a 402-pixel browser test using the real native provider. The browser test covers path/read session grants, interrupted WebSocket recovery, permission changes, and a shell command rendered once with successful Allow once. Compatibility checks pass.


## File diff and complete event inventory follow-up

Native `apply_patch` detailed output now maps to the existing versioned `file_changes` result, retaining file identity, add/edit/delete/rename metadata and diff hunks in live observations and resumed history. Input patch headers describe intent only. Unknown diff formats remain bounded raw output. No public schema, protocol version or renderer changes are required.

The [complete normalized event inventory](copilot-normalized-events.md) checks all 11 stream event variants, eight timeline items, seven tool detail variants, six interaction kinds and three stream envelopes. It explicitly distinguishes implemented mappings, native/unit/browser verification and remaining adapter/contract gaps.
