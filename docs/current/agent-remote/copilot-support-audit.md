# Copilot support audit

This records core admission on `feat/copilot-provider`, following native adapter and Host commits through `1748d4d`. It is not a full-parity or published-release claim. The [baseline](provider-support.md) includes all 40 Copilot S/I/T/X/C/R/A/H cells. Public protocol remains 1.4.0 and Host uplink remains 2.

## Native boundary and comparison

Agent Remote pins official `@github/copilot-sdk` **1.0.11** and `@github/copilot` CLI **1.0.83**. `CopilotClient` with `RuntimeConnection.forStdio` owns the transport. The default executable resolves the declared CLI package bin; an explicit executable is supported. Host preflight requires CLI 1.0.83 or newer; newer releases have not automatically passed this audit.

Borgee's separately inspected agents-host integration also uses official SDK 1.0.11 with `CopilotClient` and `RuntimeConnection.forStdio`. Matching the SDK choice does not create a source, package, service, workspace or credential dependency on Borgee.

Paseo at immutable revision [`f22a37e613e965c8ebc02e1f5565e21fd72eaf2f`](https://github.com/getpaseo/paseo/blob/f22a37e613e965c8ebc02e1f5565e21fd72eaf2f/packages/server/src/server/agent/providers/copilot-acp-agent.ts) launches `copilot --acp` with the ACP SDK. Its [base ACP client](https://github.com/getpaseo/paseo/blob/f22a37e613e965c8ebc02e1f5565e21fd72eaf2f/packages/server/src/server/agent/providers/acp-agent.ts) and Copilot mode adapter expose model/Agent/Plan/Allow All/custom-agent selection. These are comparison evidence, not proof of official Copilot SDK behavior here. Agent Remote explicitly uses the official Copilot SDK, not ACP, and does not copy those mode controls into unsupported capability flags.

Public `session.rpc.model`, `skills`, `commands`, `tasks`, `metadata`, `permissions`, `interruptMainTurn`, `eventLog`, and client skill discovery methods are **experimental SDK APIs**. Tests exercise public native calls directly; there are no private RPC or filesystem-history fallbacks. CLI 1.0.39 lacks the required event-log method and is outside this acceptance target.

## Implemented scope

- Root creation, native identity/catalog, saved resume, event history followed by exactly one boundary, append-only deltas and final suffix reconciliation, reasoning, tool identity/results and token counts use existing Provider SDK observations. Host owns directory loading, workspace selection and executable preflight; Relay and renderer interpret only existing public events.
- Native enqueue preserves distinct interactions. Native immediate input can steer within the same interaction during tool steps, or become queued delivery if the interaction has ended. Reused native `turnId: 0` and a single final `assistant.idle` are insufficient to count public turns; authoritative interaction/delivery fields group both live and historical events. The adapter adds no synthetic input queue.
- Native single-choice/freeform questions and one-time tool approval use validated public interactions. Main cancellation targets the foreground, preserving child-owned requests. Native question callbacks omit request/agent IDs; only unique complete-payload matches bind. Identical concurrent unbound questions fail explicitly instead of guessing an owner. No sensitivity marker is invented.
- Model choices require a successful native catalog. Writes require native idle state; deferred native writes report unconfirmed application and actual model-change events refresh state. Real authenticated catalog switching remains unverified. Effort is creation-only; planning and permission-mode selection are unavailable.
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

Accepted limits include no MCP forms, typed plan review, granular grants, external-action completion, output-image resource registry, todo mapping, context capacity/cost meter or PTY control. Native saved history does not resurrect process-local callbacks, running task ownership or broker bindings after a cold restart. An external native terminal remains a separate runtime. Debugger lacks the same Host/command/settings/queue entry points documented in the baseline; use existing Lab/headless paths where supported, without treating manual native operation as Remote parity.
