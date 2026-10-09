# TPM Delivery Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for inline execution. Read the spec before implementation. This plan does not authorize deployment or publishing.

**Goal:** Deliver work-scoped TPM sessions that continue coordinating and checking progress without an open browser, with a global list and ordinary floating Session View workspace.

**Architecture:** A Controller-owned coordinator persists work records and consumes the existing session managers. Provider adapters bind role instructions and tools; public session observation and settlement remain authoritative. A capability-negotiated Host management API supplies both the product and ARDB.

**Tech Stack:** TypeScript, Node.js, TypeBox public schemas, current provider SDKs, React Session View, Vitest, existing real-transport and browser test harnesses.

**Spec:** [TPM Delivery Sessions](../specs/2026-10-09-tpm-delivery.md)

## Global constraints

- Target Codex, Claude Code, and Copilot without modifying their native programs. Advertise only verified supported combinations.
- A work item binds one TPM to one main session on the same Controller. Multiple work items may share a main session.
- A provider observation is consumed once, by the existing AgentManager.
- Background leases and scheduled checks do not depend on browser or Relay connectivity.
- Never automatically replay an uncertain native operation after a process restart.
- User pause, native ownership, Host workspace policy, and native permission rules remain authoritative.
- Ordinary Session View handles TPM conversation rendering, input, recovery, and drafts.
- No credentials, native persistence opaque payloads, or executable callbacks are exposed in public work records.
- Use isolated worktrees, test state roots, ports, and native sessions. Preserve running user services.
- Every test run has per-test and outer process deadlines. Root test runners already provide both.
- Update fixtures, replay behavior, and compatibility metadata with reviewed public contract changes.

## Task 1: Establish uniform role-extension capabilities

**Files:**
- Modify `packages/agent-provider-sdk/src/provider.ts` and the existing provider capability schema identified during implementation.
- Modify `packages/agent-provider-codex/src/session.ts` only for proven extension gaps.
- Modify `packages/agent-provider-claude/src/provider.ts` and `session.ts`.
- Modify `packages/agent-provider-copilot/src/provider.ts` and `session.ts`.
- Add `session-extensions.test.ts` to the Claude and Copilot adapter source directories; extend Codex `session-tools.test.ts`.

**Consumes:** Existing `AgentSessionExtensions`, `AgentSessionConfig`, and `AgentSessionTool`.
**Produces:** Explicit capability evidence for appended instructions, callable Host tools, and extension reattachment on resume. Keep callbacks in process; persist a named extension binding with the work record rather than serializing functions.

- [ ] Write adapter tests recording native create/resume arguments and invoking a bound Host callback. Cover instructions remaining present after resume, callback errors, and disposal.
- [ ] Prove a custom Claude role preserves the `claude_code` preset and uses its `append` field. Preserve existing non-TPM semantics by introducing an explicit append form rather than silently changing every existing string prompt.
- [ ] Map Copilot Host tools to SDK tools; validate arguments against the existing tool schema. Rebind tools and role data on resume, including a newly created adapter instance.
- [ ] Bind Claude Host tools through an in-process SDK MCP server with argument validation. Restore the same named binding when opening persisted work.
- [ ] Reject unsupported extension combinations before native creation. Test that the rejection does not create an orphan session.
- [ ] Run adapter suites with deadlines; retain native execution tests for Task 8. Commit the adapter change independently.

## Task 2: Persist work records and operation intent

**Files:**
- Create `packages/agent-remote-protocol/src/tpm.ts` and `tpm.test.ts`; export from `src/index.ts`.
- Create `packages/agent-host/src/tpm/store.ts`, `store.test.ts`, `artifacts.ts`, and `artifacts.test.ts`.

**Consumes:** The spec's durable work record and existing session identity/cursor schemas.
**Produces:** Public redacted work summaries, Host-only records, atomic revision-checked storage, and scoped document storage.

The mutation boundary must express conflicts and uncertainty explicitly:

```ts
type DeliveryPhase = 'clarifying' | 'ready' | 'implementing' | 'validating' | 'completed';
type DeliveryWaiting = 'none' | 'user' | 'main_session';
type IntentState = 'prepared' | 'dispatching' | 'accepted' | 'rejected' | 'unknown';
type WorkDocumentName = 'spec' | 'acceptance';
```

- [ ] Define bounded schemas for titles, document content, evidence references, wake reasons, history watermarks, outbox entries, and public error details. Public records contain references, not callback definitions or opaque handles.
- [ ] Write tests for round-trip persistence, compare-and-swap conflict, invalid/corrupt files, invalid document names, and crash-safe replacement of the previous record.
- [ ] Implement serialized atomic writes per work ID and a bounded intent journal. Persist `dispatching` before invoking a native side effect; restore an unfinished `dispatching` entry as `unknown`.
- [ ] Make failed creation records visible and reconcilable without creating another native session automatically.
- [ ] Keep scheduler acknowledgement, operation receipts, and user unread acknowledgements as distinct fields and tests.
- [ ] Verify that malicious work IDs or document names cannot traverse outside the state root. Commit storage and schema changes.

## Task 3: Attach local sessions and bind TPM tools

**Files:**
- Create `packages/agent-host/src/tpm/session-access.ts`, `tools.ts`, `role.ts`, and corresponding tests.
- Modify `packages/agent-host/src/host.ts`, `stdio-directory.ts`, and `idle-sessions.test.ts` where necessary.
- Read and reuse `packages/agent-host/src/session-reference.ts` and `packages/agent-remote-relay/src/session-wire.ts`.

**Consumes:** Work identity, extension capability from Task 1, persisted intent from Task 2, and existing runtime `acquireSession`, `resolveSession`, and `executeOperation`.
**Produces:** Work-bound read/send/artifact/scheduling tools and independent background session leases.

- [ ] Add a test that two background clients and two browser clients share one native `observe()` consumer and one binding.
- [ ] Provide a stable native-identity resolver for local attachment, applying the same workspace and provider-enabled checks as normal session access. Do not manufacture a fake remote credential or bypass directory admission.
- [ ] Implement paginated reads through the common manager's history interface. Return gap/reset/truncation information instead of silently reading only the visible tail.
- [ ] Implement `read_main_session`, `send_main_message`, `read_work`, `update_work`, `write_work_document`, and `schedule_check` with session/work binding established by the Host.
- [ ] Use ordinary input with native queue capability where available. Otherwise persist and defer until authoritative admission permits sending. Never convert a normal work message into cancel/steer.
- [ ] Dispatch through the existing operation executor using a stable work scope and operation ID. Persist the precise returned acceptance without claiming completion.
- [ ] Verify that releasing every browser and replacing the uplink leaves background leases intact; completing/pausing one TPM does not release another TPM's lease.
- [ ] Add takeover and disabled-provider tests proving no automatic reacquisition of an unmanaged CLI. Commit the session integration.

## Task 4: Observe content and schedule heartbeat reviews

**Files:**
- Create `packages/agent-host/src/tpm/attention.ts`, `scheduler.ts`, `coordinator.ts`, and corresponding tests.
- Reuse `packages/agent-remote-relay/src/agent-manager-events.ts` and existing content-attention semantics.
- Modify `packages/agent-host/src/host.ts` for coordinator lifetime and shutdown.

**Consumes:** Committed manager events, native readiness, work tools, durable watermarks, and Host leases.
**Produces:** One coalesced automatic review at a time per TPM, persistent due checks, and health diagnostics independent of task phase.

The scheduling decision should be a pure function exercised with an injected clock:

```ts
interface ReviewReadiness {
  now: number;
  dueAt: number;
  earliestAutomaticStart: number;
  paused: boolean;
  completed: boolean;
  busy: boolean;
  pendingInteraction: boolean;
  hasUncertainDispatch: boolean;
  inputAdmitted: boolean;
}

function canStartReview(s: ReviewReadiness): boolean {
  return !s.paused && !s.completed && !s.busy && !s.pendingInteraction
    && !s.hasUncertainDispatch && s.inputAdmitted
    && s.now >= Math.max(s.dueAt, s.earliestAutomaticStart);
}
```

- [ ] Test each blocking condition independently, including a busy TPM becoming idle while a user question remains pending.
- [ ] Test token-delta bursts, committed messages with resources, runtime failures, history replay, epoch replacement, known outbound echoes, and events arriving during a review.
- [ ] Implement a content watermark and coalesced wake reasons. Do not advance the consumed watermark when only native input acceptance has arrived.
- [ ] Use the spec's proposed five-minute/ thirty-minute heartbeat defaults, two-second coalescing, thirty-second minimum automatic interval, and two-review Host concurrency limit.
- [ ] Build review input from persisted work facts and wake reasons. Instruct the TPM to query evidence and record an action or justified waiting; avoid automatic user-visible heartbeat chatter.
- [ ] Persist deadlines and reconcile overdue work once after restart/sleep. Verify clock jumps do not cause a catch-up burst.
- [ ] Separate native health-read deadlines from reflection deadlines. Unknown runtime health must not trigger blind process termination or message replay.
- [ ] Test pause, completion, explicit reopen, event storms, fairness across work items, and controller-shutdown races. Commit the coordinator.

## Task 5: Expose authorized work management

**Files:**
- Create `packages/agent-host/src/tpm/control.ts` and `control.test.ts`.
- Modify `packages/agent-host/src/host.ts` and `packages/agent-remote-protocol/src/host-providers.ts`.
- Extend the existing Host proxy allowlists/validators in the actual relay and hosted broker paths; do not install a separate unauthenticated server.
- Modify `packages/agent-remote-lab/src/directory-client.ts` or extract its reusable Host-control request transport into the existing public client layer.
- Extend ARDB using its existing authenticated session/Host resolution and command conventions.

**Consumes:** Coordinator actions and redacted schemas from Tasks 2–4.
**Produces:** Capability-negotiated catalog, create/read, document read, revision-checked changes, pause/resume/reopen/check-now, and explicit uncertain-delivery resolution.

- [ ] Add real-transport tests for two clients mutating the same work revision, a denied Host scope, an old Controller, and reconnection during a mutation.
- [ ] Route actions through existing Host authorization, diagnostics, and settlement. Check bound sessions on create and before later side effects after policy changes.
- [ ] Return unavailable capability before session creation when provider extensions cannot be honored.
- [ ] Support catalog revision refresh so multiple pages can observe the same work record without creating duplicate TPMs.
- [ ] Add ARDB commands for creation, inspection, pause/resume, and check-now. Ordinary TPM conversation messages and observations continue using existing ARDB session commands.
- [ ] Record management changes alongside session recording metadata where needed for replay; never make playback execute a real timer or native operation. Commit the API and CLI integration.

## Task 6: Add the global TPM list and floating workspace

**Files:**
- Create `packages/agent-remote-lab/src/hooks/useTpmWork.ts`, `components/TpmMenu.tsx`, `components/TpmWorkspace.tsx`, and their tests.
- Modify `packages/agent-remote-lab/src/App.tsx` and relevant menu/command assembly.
- Reuse or extract the floating shell from `components/AskConversation.tsx`, `AskResize.tsx`, and existing positioning hooks without coupling TPM state to Ask records.
- Add scoped TPM styles, reusing existing tokens and responsive behavior.

**Consumes:** Global authorized Host work catalogs and normal session bindings.
**Produces:** A Track-like work list and an Ask-like ordinary Session View workspace.

- [ ] Test list loading, empty/unavailable states, work creation from the current main session, and selection without accidental dismissal.
- [ ] Render work phase and waiting/health state distinctly from native session execution status.
- [ ] Reuse `useConversationSession` and `LabWorkbench`; retain full chatbox functions, pending input behavior, settings, resources, search, and view modes.
- [ ] Add specification access, main-session navigation, explicit pause/resume, minimize, and return-to-list controls. Hiding a panel must only change presentation state.
- [ ] Persist draft and scroll selection using existing session-view mechanisms. Aggregate catalogs across authorized Hosts while retaining host/provider identity in every key.
- [ ] Verify desktop resizing, narrow-screen overlay, keyboard focus restoration, touch interactions, and header overflow behavior.
- [ ] Feed meaningful TPM updates into existing attention behavior; do not generate notifications for silent heartbeat checks. Commit UI integration.

## Task 7: Prove closed-browser execution and failure recovery

**Files:**
- Add `packages/agent-host/src/tpm/coordinator.integration.test.ts` using existing local relay/Host transport fixtures.
- Extend affected lease, shared-session, public operation, hosted authorization, and ARDB replay tests.
- Add browser tests beside existing Ask/Track and multi-tab tests.

- [ ] Close all websocket/browser clients while the Controller remains running; emit main content and verify one TPM review and its persisted result.
- [ ] Disconnect the Relay and repeat using two same-Controller sessions; then reconnect and read the accumulated work result from a fresh client.
- [ ] Inject failures before dispatch, after dispatch, and after receipt persistence. Verify no duplicate request and a visible unknown outcome where evidence is absent.
- [ ] Restart with pending user interaction, a paused work item, a completed work item, an overdue heartbeat, and a changed history epoch.
- [ ] Demonstrate that main-session unrelated completion does not complete the work item, and a known TPM message echo does not create a feedback loop.
- [ ] Assert bounded retained events, fair queueing, and a single native observer when many work items share one main session.
- [ ] Update the English operational documentation with exact controls and troubleshooting supported by the implemented CLI/API. Commit integration evidence and fixes.

## Task 8: Validate native providers and prepare delivery

**Files:**
- Add isolated native TPM smoke cases to the existing Codex, Claude, and Copilot native test suites.
- Update protocol fixtures, replay fixtures, and generated compatibility metadata together.
- Update package build inputs if new role-guide resources need bundling.

- [ ] For each advertised provider, create an isolated main session and TPM, prove a callable read/send tool, and resume the TPM with instructions/tools intact.
- [ ] Prove normal queued delivery while the main session is working, truthful admission failures, and preservation of native execution policy.
- [ ] Validate Controller restart and closed-browser behavior with real provider receipts. Keep mocked, native, and browser evidence separate in the report.
- [ ] Run relevant root test suites with their outer deadlines, package typechecks, `pnpm compatibility:update`, and `pnpm compatibility:check` after reviewed implementation changes.
- [ ] Build an isolated Controller package and verify its role resources, schemas, and CLI commands. Do not replace the user's running installation during validation.
- [ ] Report the exact commit, test results, native versions, and any unverified scope. Request merge/deployment/update authorization only if it has not already been provided for this feature.

## Completion criteria

Every numbered acceptance case in the spec must have evidence. A UI-only TPM, a timer that lives in a page, a non-resumable tool binding, or an automatic retry of uncertain operations is not completion. Features requiring an unavailable native capability remain explicitly unavailable rather than emulated with misleading semantics.
