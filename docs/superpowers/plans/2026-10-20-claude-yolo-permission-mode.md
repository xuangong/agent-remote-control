# Claude YOLO Permission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Claude adapter's four hand-maintained permission allowlists with one mode table, and stop the adapter from persisting a native mode its own readers would reject.

**Architecture:** A new `permission-modes.ts` owns one ordered table of permission modes, each carrying its label and whether a session may resume into it. The session's offered options and all three persistence validators derive from that table. `confirmPermissionMode` gains a guard so an unrecognized native mode is displayed but never written to the resume target.

**Tech Stack:** TypeScript, vitest, pnpm workspace, `@anthropic-ai/claude-agent-sdk` 0.3.247.

---

## Starting state

Work happens in the existing worktree `/Volumes/Projects/agent-remote-control/.worktrees/claude-yolo` on branch `feat/claude-yolo`.

The branch has one commit (`12aaf2b0`, the design spec) plus **uncommitted work in progress** that already implements the YOLO feature itself:

- `session.ts` passes `allowDangerouslySkipPermissions: true` to the native query and offers a `bypassPermissions` / "YOLO" option.
- `session.ts:96`, `provider.ts:157` and `native-evidence.ts:52` each gained `'bypassPermissions'` in their inline array.
- `agent-host/README.md` documents the mode.
- `settings.test.ts`, `provider.test.ts` and `native-evidence.test.ts` are parameterized over `bypassPermissions`.
- `yolo.local.test.ts` is a new native end-to-end test.
- `compatibility.json` is regenerated.

**Do not revert or rewrite any of it.** This plan adds the structural work the WIP did not do.

**Round-trip coverage already exists — do not add a third round-trip test.** `native-evidence.test.ts` ("retains confirmed empty-session settings with %s") covers the empty-descriptor path through `readClaudeEmptyDescriptor`, and `provider.test.ts` ("resumes %s and retains it across a saved planning session") covers the opaque path through `readConfig`. Both are parameterized over `bypassPermissions`. Together they satisfy the spec's "closes the loop" requirement. Their job in this plan is to stay green through the refactor.

---

## File structure

- **Create** `packages/agent-provider-claude/src/permission-modes.ts` — the single mode table and the two accessors derived from it. No session state, no I/O, no imports from `session.ts`.
- **Create** `packages/agent-provider-claude/src/permission-modes.test.ts` — unit tests for the table and accessors.
- **Modify** `packages/agent-provider-claude/src/session.ts` — three call sites consume the table.
- **Modify** `packages/agent-provider-claude/src/provider.ts` — one validator consumes the table.
- **Modify** `packages/agent-provider-claude/src/native-evidence.ts` — one validator consumes the table.
- **Modify** `packages/agent-provider-claude/src/settings.test.ts` — one new guard test.

`permission-modes.ts` imports only types (`PermissionMode` from the Claude SDK, `AgentSessionSettingOption` from the provider SDK), so it introduces no runtime dependency and no import cycle.

---

### Task 1: The permission mode table

**Files:**
- Create: `packages/agent-provider-claude/src/permission-modes.ts`
- Test: `packages/agent-provider-claude/src/permission-modes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-provider-claude/src/permission-modes.test.ts`:

```ts
import { expect, it } from 'vitest';
import { CLAUDE_PERMISSION_MODES, claudePermissionModeOptions, isResumableClaudePermissionMode } from './permission-modes.js';

it('offers every table mode in presentation order and labels the bypass mode YOLO', () => {
  const options = claudePermissionModeOptions('default');
  expect(options.map(option => option.value)).toEqual(['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']);
  expect(options.map(option => option.value)).toEqual(CLAUDE_PERMISSION_MODES.map(mode => mode.value));
  expect(options).toContainEqual(expect.objectContaining({ value: 'bypassPermissions', label: 'YOLO' }));
});

it('keeps an unrecognized current mode selectable so a selection always matches one option', () => {
  expect(claudePermissionModeOptions('auto')).toContainEqual({ value: 'auto', label: 'auto' });
  expect(claudePermissionModeOptions('default').filter(option => option.value === 'default')).toHaveLength(1);
});

it('resumes every known mode except planning', () => {
  expect(isResumableClaudePermissionMode('default')).toBe(true);
  expect(isResumableClaudePermissionMode('acceptEdits')).toBe(true);
  expect(isResumableClaudePermissionMode('dontAsk')).toBe(true);
  expect(isResumableClaudePermissionMode('bypassPermissions')).toBe(true);
  expect(isResumableClaudePermissionMode('plan')).toBe(false);
  expect(isResumableClaudePermissionMode('auto')).toBe(false);
  expect(isResumableClaudePermissionMode(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/permission-modes.test.ts --testTimeout=10000 --maxWorkers=1
```
Expected: FAIL — cannot resolve `./permission-modes.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/agent-provider-claude/src/permission-modes.ts`:

```ts
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSessionSettingOption } from '@orchardworks/agent-provider-sdk';

/** A permission mode this adapter knows, how it is offered, and whether a session may resume into it. */
export interface ClaudePermissionMode {
  readonly value: PermissionMode;
  readonly label: string;
  readonly description?: string;
  /** Planning is transient state carried by the planning flag, so it is never a resume target. */
  readonly resumable: boolean;
}

export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  { value: 'default', label: 'Ask for permissions', resumable: true },
  { value: 'acceptEdits', label: 'Accept edits', resumable: true },
  { value: 'dontAsk', label: 'Deny unapproved tools', resumable: true },
  { value: 'plan', label: 'Plan', resumable: false },
  { value: 'bypassPermissions', label: 'YOLO',
    description: 'Skip permission prompts. Existing sandbox restrictions still apply.', resumable: true },
];

/** Selectable permission modes. A current mode outside the table stays selectable so the selection always matches. */
export function claudePermissionModeOptions(current: PermissionMode): AgentSessionSettingOption[] {
  const options = CLAUDE_PERMISSION_MODES.map(mode => ({ value: mode.value, label: mode.label,
    ...(mode.description ? { description: mode.description } : {}) }));
  return options.some(option => option.value === current) ? options : [...options, { value: current, label: current }];
}

/** Modes a session may persist and resume into. */
export function isResumableClaudePermissionMode(value: unknown): value is PermissionMode {
  return CLAUDE_PERMISSION_MODES.some(mode => mode.resumable && mode.value === value);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/permission-modes.test.ts --testTimeout=10000 --maxWorkers=1
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-provider-claude/src/permission-modes.ts packages/agent-provider-claude/src/permission-modes.test.ts
git commit -m "feat(claude): define one permission mode table

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Offer and resume from the table

This is a refactor. The existing tests must stay green without being edited.

**Files:**
- Modify: `packages/agent-provider-claude/src/session.ts:96` (resume), `:335-338` (options), import block

- [ ] **Step 1: Record the current green baseline**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/settings.test.ts src/provider.test.ts src/native-evidence.test.ts --testTimeout=10000 --maxWorkers=1
```
Expected: PASS. Note the test count — the same count must pass after this task.

- [ ] **Step 2: Add the import**

In `packages/agent-provider-claude/src/session.ts`, below the existing `import { ClaudeNativeEvidence, claudeEmptyHandle } from './native-evidence.js';` line, add:

```ts
import { claudePermissionModeOptions, isResumableClaudePermissionMode } from './permission-modes.js';
```

- [ ] **Step 3: Derive the resume target from the table**

In `session.ts`, replace line 96:

```ts
    this.resumePermissionMode = !options.restrictedNative && ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'].includes(config.permissionMode ?? '') ? config.permissionMode! : 'default';
```

with:

```ts
    this.resumePermissionMode = !options.restrictedNative && isResumableClaudePermissionMode(config.permissionMode) ? config.permissionMode : 'default';
```

The `!` assertion is no longer needed: `isResumableClaudePermissionMode` is a type guard, so `config.permissionMode` is already narrowed to `PermissionMode`.

The `!options.restrictedNative &&` prefix stays. A restricted session still starts at `default` rather than resuming a saved elevated mode, which is the behavior `settings.test.ts` ("requires the native sandbox and resets saved %s") asserts.

- [ ] **Step 4: Derive the offered options from the table**

In `session.ts`, replace the options array inside `settings()` (lines 335-338):

```ts
      options: [{ value: 'default', label: 'Ask for permissions' }, { value: 'acceptEdits', label: 'Accept edits' },
        { value: 'dontAsk', label: 'Deny unapproved tools' }, { value: 'plan', label: 'Plan' },
        { value: 'bypassPermissions', label: 'YOLO', description: 'Skip permission prompts. Existing sandbox restrictions still apply.' }],
```

with:

```ts
      options: claudePermissionModeOptions(this.permissionMode),
```

- [ ] **Step 5: Verify the refactor changed no behavior**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/settings.test.ts src/provider.test.ts src/native-evidence.test.ts src/permission-modes.test.ts --testTimeout=10000 --maxWorkers=1
```
Expected: PASS, with the same count as Step 1 plus the 3 tests from Task 1.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude run typecheck
```
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-provider-claude/src/session.ts
git commit -m "refactor(claude): offer and resume permission modes from the table

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Validate persistence and evidence from the table

Also a refactor. Existing tests stay green unedited.

**Files:**
- Modify: `packages/agent-provider-claude/src/provider.ts:157`
- Modify: `packages/agent-provider-claude/src/native-evidence.ts:52`

- [ ] **Step 1: Route stored-configuration parsing through the table**

In `packages/agent-provider-claude/src/provider.ts`, add to the import block:

```ts
import { isResumableClaudePermissionMode } from './permission-modes.js';
```

Replace line 157:

```ts
  if (typeof value.permissionMode === 'string' && ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'].includes(value.permissionMode)) config.permissionMode = value.permissionMode as ClaudeSessionConfig['permissionMode'];
```

with:

```ts
  if (isResumableClaudePermissionMode(value.permissionMode)) config.permissionMode = value.permissionMode;
```

The `as` cast is no longer needed — the type guard narrows `value.permissionMode` to `PermissionMode`, and `ClaudeSessionConfig['permissionMode']` is `PermissionMode | undefined`. The separate `typeof value.permissionMode === 'string'` check is also no longer needed, because the guard only matches string values from the table.

- [ ] **Step 2: Route evidence admission through the table**

In `packages/agent-provider-claude/src/native-evidence.ts`, add to the import block:

```ts
import { isResumableClaudePermissionMode } from './permission-modes.js';
```

Replace line 52:

```ts
  if (value.config.permissionMode !== undefined && !['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'].includes(value.config.permissionMode)) claudeEvidenceReject('native_evidence_invalid');
```

with:

```ts
  if (value.config.permissionMode !== undefined && !isResumableClaudePermissionMode(value.config.permissionMode)) claudeEvidenceReject('native_evidence_invalid');
```

The `!== undefined` check stays: an absent mode is valid evidence, an unrecognized one is not.

- [ ] **Step 3: Verify the refactor changed no behavior**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run --testTimeout=10000 --hookTimeout=15000 --maxWorkers=1 --exclude 'src/**/*.local.test.ts'
```
Expected: PASS. This is the whole package except the native tests, which Task 5 covers.

- [ ] **Step 4: Confirm no inline permission allowlist survives**

Run:
```bash
grep -rn "'acceptEdits', 'dontAsk'" packages/agent-provider-claude/src --include='*.ts' | grep -v '\.test\.'
```
Expected: no output. Every non-test allowlist now comes from the table.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-provider-claude/src/provider.ts packages/agent-provider-claude/src/native-evidence.ts
git commit -m "refactor(claude): validate persisted permission modes from the table

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Display an unrecognized native mode without persisting it

This is a real defect fix, so the test fails first.

Today `confirmPermissionMode` writes whatever the native runtime reports into `resumePermissionMode`, and `info()` copies that into `persistence.opaque`. A native runtime reporting `auto` — a real SDK mode this adapter does not offer — therefore persists a value that `readConfig` silently drops and `readClaudeEmptyDescriptor` rejects as `native_evidence_invalid`.

**Files:**
- Modify: `packages/agent-provider-claude/src/session.ts:294-300`
- Test: `packages/agent-provider-claude/src/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-provider-claude/src/settings.test.ts`:

```ts
it('shows an unrecognized native permission mode without persisting it as a resume target', async () => {
  const native = fixture();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
  try {
    await session.setSessionSetting!('permissions', 'acceptEdits');
    native.events.push({ type: 'system', subtype: 'status', permissionMode: 'auto' });
    await expect.poll(async () => (await session.runtimeInfo()).settings!.find(setting => setting.id === 'permissions')!.value).toBe('auto');
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque)).toMatchObject({ permissionMode: 'acceptEdits' });
  } finally { await session.dispose(); }
});
```

The first assertion is the display rule: the session reports the mode the runtime actually holds, rather than claiming a lower privilege. The second is the persistence rule: only a resumable mode becomes the resume target.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/settings.test.ts -t 'unrecognized native permission mode' --testTimeout=10000 --maxWorkers=1
```
Expected: FAIL on the second assertion — the persisted `permissionMode` is `auto`, not `acceptEdits`.

- [ ] **Step 3: Add the guard**

In `packages/agent-provider-claude/src/session.ts`, replace `confirmPermissionMode` (lines 294-300):

```ts
  private confirmPermissionMode(mode: PermissionMode): void {
    this.settingsRevision++;
    this.permissionMode = mode;
    this.planning = mode === 'plan';
    if (!this.planning) this.resumePermissionMode = mode;
  }
```

with:

```ts
  private confirmPermissionMode(mode: PermissionMode): void {
    this.settingsRevision++;
    this.permissionMode = mode;
    this.planning = mode === 'plan';
    if (!this.planning && isResumableClaudePermissionMode(mode)) this.resumePermissionMode = mode;
  }
```

`isResumableClaudePermissionMode` is already imported by Task 2.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run src/settings.test.ts -t 'unrecognized native permission mode' --testTimeout=10000 --maxWorkers=1
```
Expected: PASS.

- [ ] **Step 5: Run the whole non-native package suite**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude exec vitest run --testTimeout=10000 --hookTimeout=15000 --maxWorkers=1 --exclude 'src/**/*.local.test.ts'
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-provider-claude/src/session.ts packages/agent-provider-claude/src/settings.test.ts
git commit -m "fix(claude): stop persisting an unrecognized native permission mode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Prove the native YOLO test actually runs

`yolo.local.test.ts` is the only evidence that YOLO works against a real runtime, and that restricted sandbox sessions still execute tools without approval. A green suite that skipped it proves nothing.

**This task is blocked on the machine that wrote this plan.** The local `claude` is 2.1.128 (`/opt/homebrew/bin/claude`), and `scripts/run-tests.mjs:22` requires 2.1.247 or newer. Install or locate a suitable binary before running.

**Files:**
- Verify only: `packages/agent-provider-claude/src/yolo.local.test.ts`

- [ ] **Step 1: Confirm a suitable native binary**

Run:
```bash
claude --version
```
Expected: `2.1.247 (Claude Code)` or newer. If the version is older, install a newer Claude Code and set `AGENT_CLAUDE_TEST_EXECUTABLE` to its absolute path. Do not proceed on an older binary — `allowDangerouslySkipPermissions` may not exist there, and a failure would be indistinguishable from a real defect.

- [ ] **Step 2: Run the native Claude suite**

Run:
```bash
AGENT_CLAUDE_TEST_EXECUTABLE="$(which claude)" pnpm test:claude
```

- [ ] **Step 3: Confirm the YOLO tests ran rather than skipped**

In the vitest output, find the two cases from `src/yolo.local.test.ts`:

```
executes a native tool in YOLO without approval with restricted sandbox false
executes a native tool in YOLO without approval with restricted sandbox true
```

Expected: both marked passed. If either is reported as skipped, the task is not complete — find why and fix it before continuing. A skipped native test here means the restricted-sandbox claim in the spec and the README is unverified.

- [ ] **Step 4: Record the result**

No commit. Report the version used and the two case results when handing this task back.

---

### Task 6: Refresh compatibility metadata and commit the work in progress

`AGENTS.md` requires regenerating compatibility metadata after reviewed implementation changes. The work-in-progress files from the starting state are still uncommitted and are committed here.

**Files:**
- Modify: `packages/agent-remote-lab/compatibility.json`
- Commit: the remaining WIP files

- [ ] **Step 1: Regenerate compatibility metadata**

Run:
```bash
pnpm compatibility:update
```

- [ ] **Step 2: Verify it agrees**

Run:
```bash
pnpm compatibility:check
```
Expected: exit 0.

- [ ] **Step 3: Typecheck the packages this branch touches**

Run:
```bash
pnpm --filter @orchardworks/agent-provider-claude run typecheck
```
Expected: no output, exit 0.

- [ ] **Step 4: Commit the YOLO feature itself**

```bash
git add packages/agent-provider-claude/src/yolo.local.test.ts packages/agent-provider-claude/src/settings.test.ts packages/agent-provider-claude/src/provider.test.ts packages/agent-provider-claude/src/native-evidence.test.ts packages/agent-host/README.md packages/agent-remote-lab/compatibility.json
git commit -m "feat(claude): offer a YOLO permission mode

Skip native permission prompts while the command sandbox and workspace
admission stay in force. Restricted sessions reset a saved elevated mode
when reopened, so elevation is a deliberate act once per session.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: Confirm a clean tree**

Run:
```bash
git status --short
```
Expected: no output.

---

## Out of scope

- `agent-host/src/claude.ts:39` returns `nativePermissionControl: true` unconditionally while the Codex and OpenCode registrations make it conditional on `restrictedNative`. The design deliberately leaves this alone: with YOLO offered in restricted sessions, the flag is no longer a bypass of an intended gate. The inconsistency with the other two providers remains worth a separate look.
- Exposing the SDK's `auto` mode. Nothing asks for it. Task 4 makes an unoffered mode behave correctly if a runtime reports one.
