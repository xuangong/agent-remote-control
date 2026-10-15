# Session View Contracts Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Execute tasks in order and review each before the next implementation starts.

**Goal:** Remove implicit ownership and identity assumptions from standard Session View operations.

**Architecture:** Explicit UI action identity, Lab-owned composer restoration, complete SDK native-prefix capability, and explicit Hosted Team projection boundaries. Keep the existing transaction machinery and persistence formats.

**Tech Stack:** TypeScript, React, Vitest, Playwright, Node HTTP/WebSocket, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-15-session-view-contracts.md`

## Global Constraints

- Work only in `/Volumes/Projects/agent-remote-control/.worktrees/session-view-rewind` and preserve its existing changes.
- Provider-native interpretation stays in adapters; Host authority, Remote wire, browser persistence and Lab navigation stay separate.
- No commit, push, merge, publication, deployment, existing-service restart or real-session mutation.
- Keep public wire and persisted formats compatible; standalone has no Borgee/account/source-path dependency.
- Use behavioral tests with per-test/hook and outer process deadlines. Root records independent incremental review snapshots.
- Mounted browser tests on this Node 26 environment use process-local `env -u NO_COLOR -u FORCE_COLOR NODE_OPTIONS=--no-experimental-webstorage` so jsdom owns browser storage.
- Run compatibility update/check after reviewed changes. Code, comments and documentation are English.

### Task 1: D3 - Explicit dialog operation identity

**Files:** Create `packages/agent-remote-lab/src/session-succession-directory.ts` and focused behavioral tests. Modify `components/SessionSuccessionDialog.tsx`, its tests, `session-view-operations.ts`, `App.tsx`, `packages/agent-remote-debugger/web/session-operations.ts`, `web/index.tsx`, and their test fixtures as required.

**Interfaces:** Introduce a dialog-specific port instead of Pick of the HTTP client:

```ts
interface SessionSuccessionDirectory {
  describeSuccession(providerId: string, nativeSessionId: string, preparation?: NativePrefixSelection): Promise<SuccessionDescription>;
  prepareSuccession(input: SuccessionPrepareInput): Promise<SuccessionActionResult>;
  actOnSuccession(action: 'commit' | 'cancel' | 'status' | 'reconcile', retained: Readonly<SuccessionPrepareInput>): Promise<SuccessionActionResult>;
}
```

- [ ] Add a behavioral test that a fresh ARDB adapter can act from supplied identity without a prepare or recovery-storage read; exercise status, reconcile and commit. Use isolated HTTP where feasible and assert observed bodies contain the supplied operationId/expectedRevision. Capture the expected failing result before implementing.
- [ ] Add/retain tests of Lab facade encoding: cancel sends the complete original payload, ordinary actions send only operation ID, independent includeContext query remains available. Assert actual requests rather than implementation source.
- [ ] Implement the facade and change all Dialog actions, including automatic commit/status, to pass pending/current retained request. Keep source checks only where already needed.
- [ ] Remove ARDB storage import, scope/viewId constructor arguments and prepared fallback. Preserve source/revision validation for prepare.
- [ ] Run focused Dialog, directory, prompt-operation and ARDB tests plus affected typechecks with explicit deadlines; self-review and write the report. Do not commit.

### Task 2: D2 - Composer draft owner and actual mutation receipts

**Files:** Create `packages/agent-remote-lab/src/composer-draft-owner.ts` and behavior tests. Modify `packages/agent-remote-web/src/image-drafts.ts`, `react/useImageDraft.ts`, exports/tests, `packages/agent-remote-lab/src/hooks/usePromptEditOperation.tsx` and owner-aware fixtures as required.

**Interfaces:** The Lab owner combines DraftBinding and ImageDraftStorageHandle. Its capture/restore API consumes expected ownership and replacement, returning an opaque owner token plus separate text/image persistence state. Web exposes actual local image application before asynchronous save completion. Conceptual receipt:

```ts
type Application = { status: 'not-applied'; reason: 'changed' | 'unavailable' | 'retired' }
  | { status: 'applied'; token: DraftOwnerToken };
interface DraftRestoreReceipt {
  application: Application;
  persistence: { text: 'pending' | 'saved' | 'failed' | 'cancelled'; image: 'pending' | 'saved' | 'failed' | 'cancelled'; imageRetention: 'page' | 'local' };
}
```

- [ ] Read existing partial-restoration, same-content ABA, remount and owner/recipient replacement regressions. Add a failing test for actual applied receipt remaining attributable after failed save or subsequent edit; do not assert a hard-coded revision increment.
- [ ] Make the Web writer publish the actual application token at mutation time, separately from completion or in failure-aware results. Preserve existing inspect/flush semantics and normal input behavior.
- [ ] Implement a Lab composition owner that compares expected snapshots, records actual text/image application, and handles retryable persistence. Do not introduce a Web dependency on Lab or a general composer-controller framework.
- [ ] Integrate the owner into prompt restoration; remove hook revision arithmetic and callback-internal inference. Keep operation persistence, cleanup, target wait, authorization and reload policy in the hook.
- [ ] Verify newer same-content edits, text/image partial save failures, retry without another native operation, reload and retired recipient behavior. Run relevant Web/Lab tests and typechecks with explicit deadlines; report and do not commit.

### Task 3: D1 - Complete SDK native-prefix capability

**Files:** SDK `src/provider.ts`, native evidence/exports as needed; Codex/OpenCode providers and their prefix tests; Host `directory.ts`, `opencode-directory.ts`, `local-session-runtime.ts`, `host.ts`, `execution-policy.ts`, related fixtures; ARDB declaration bundling as needed.

**Interfaces:** Add one optional complete capability object to AgentProviderAdapter. Its native target has nativeSessionId/turnId/messageId. Supported capability includes candidate ID bound, validate, create with a required checkpoint callback, and verify. Host's directory durable port also requires its checkpoint. Legacy convenience fork APIs remain separate.

```ts
interface AgentNativePrefixCapability {
  readonly createdSessionIdMaxLength: number;
  validate(target: AgentNativePrefixTarget): Promise<void>;
  create(target: AgentNativePrefixTarget, extensions: AgentSessionExtensions,
    checkpoint: (handle: AgentPersistenceHandle) => Promise<void>): Promise<AgentSession>;
  verify(target: AgentNativePrefixTarget, handle: AgentPersistenceHandle): Promise<void>;
}
```

- [ ] Add failing contract tests for absent/incomplete capability rejection and required checkpoint ordering, using a held/rejected callback before bootstrap. Keep real fixture transport coverage for provider operations.
- [ ] Implement the SDK contract and adapter-owned capability objects, with native-only types. Migrate Host/local discovery and forwarding wrappers to the complete contract; remove duplicated structural prompt capability definitions.
- [ ] Preserve source/epoch/role checks and exact checkpoint handle retention; retain unknown recovery without repeat fork. Keep non-durable convenience entry points explicit and avoid no-op callbacks pretending to provide durability.
- [ ] Verify Codex/OpenCode, main Host/local and wrapper paths, then affected types and ARDB declaration/package closure. Use per-test/hook and outer deadlines. Report and do not commit.

### Task 4: D4 - Stored Team anchor and projected recipient API clarity

**Files:** `packages/agent-remote-hosted/src/team-delivery.ts`, `teams.ts`, `broker.ts`, Team/negotiation tests and only directly required consumers.

**Interfaces:** Replace `forClient(team, recipientAware)` with `readForClient(teamId, recipientAware)`. Name recipient resolution with explicit anchor inputs. Keep one projection function and the existing JSON shape.

- [ ] Verify existing tests cover stored anchor preservation and frozen B delivery after projection moves to C. Add a focused behavior regression only for a missing boundary (for example visibility filtering before legacy rejection).
- [ ] Make stored/projection helper contracts explicit; exclude projection-only evidence from stored types where practical. Rename the private-evidence stripping helper accurately.
- [ ] Make provisioning read stored records instead of consuming list projections. Preserve fresh reread after mutation, permission filter order and compatibility negotiation.
- [ ] Run scoped Hosted Team/negotiation and relevant Host role tests with explicit deadlines; report and do not commit.

### Task 5: Integrated verification and final review

- [ ] Independently review each incremental task diff before proceeding; resolve substantive findings through the implementer and re-review the fix.
- [ ] Run affected/full workspace typechecks, final rebuilt browser smoke, and package/declaration checks justified by D1. Preserve isolated ports, credentials and existing services.
- [ ] Run `pnpm compatibility:update`, `pnpm compatibility:check` and `git diff --check` after reviewed changes.
- [ ] Produce a final independent review of the cleanup diff against its starting snapshot, reconcile remaining findings, and report completed items, verified scope and limits. Leave changes uncommitted.
