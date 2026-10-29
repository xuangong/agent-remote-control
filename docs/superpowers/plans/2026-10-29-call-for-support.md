# Call For Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a worker session call for support (reviewers, consultants, testers on other providers, models and hosts) through a coordinator that organizes supporters and returns one curated report, as specified in `docs/superpowers/specs/2026-10-29-call-for-support-design.md`.

**Architecture:** A support group is a Team with a `callForSupport` profile: the coordinator is the Leader, supporters are members, the worker is a new `requester` seat bound to its existing session. The Relay owns profiles, groups, mandate validation and usage bounds; Controllers own sessions, read-only enforcement, worktrees and tool injection; the website owns profiles, calls, approvals and visibility.

**Tech Stack:** TypeScript (ESM, Node 22 runtime), TypeBox schemas, Vitest, Playwright, pnpm workspaces; Codex app-server JSON-RPC; Claude Agent SDK 0.3.247; Cloudflare Workers for the hosted Relay.

---

## How to work

- Worktree: `/Volumes/Projects/agent-remote-control/.worktrees/call-for-support`, branch `feat/call-for-support`.
- Node: prefix commands with `PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"`; the release gate runs on `v22.23.2`.
- Native Claude tests: `AGENT_CLAUDE_TEST_EXECUTABLE=$HOME/.nvm/versions/node/v22.23.2/bin/claude`. Native Codex tests: `BORGEE_CODEX_TEST_EXECUTABLE=<codex 0.162.0 or the new pin>`.
- After any change under `packages/`, run `pnpm compatibility:update` then `pnpm compatibility:check` before committing; Lab tests fail on a stale digest.
- Commit after every task. Never push or deploy before milestone 8.
- Milestones 2–8 list their tasks with files, contracts, tests and acceptance. Before starting a milestone, expand its tasks in this file to step level (test code, implementation code, commands) against the code as it then exists, commit the expansion, then execute it.

## Progress

- Milestones 1–7 and Tasks 8.1–8.2 are implemented and committed on `feat/call-for-support`.
- Task 8.1 found a stall: a coordinator message steered into a Codex turn that was ending became `unknown`. Support group seats now deliver between turns, and the group view lets the user confirm an uncertain delivery. The native acceptance then passed 19 of 20 runs; the remaining failure did not reproduce in 20 further runs and its diagnostics are in the test's failure message.
- A release review found six risks, fixed in five commits: read-only providers no longer ride in provider descriptors (an older Relay refused updated Controllers); idle release is limited to support groups; archived groups are final and removed at capacity with their files, bundles are not pinned, and Controllers forget ended groups' seats; worktrees are verified before reuse and patching; failed supporters' worktrees are removed. A second review added pruning by state size (the 2 MiB bound would fill before 128 Teams), a sweep of orphaned files, a clear message for expired uploads, and retries for worktrees an ended group could not remove.
- Task 8.3: the verification gate runs before any outward step; deploying, merging and releasing wait for the user's go-ahead. After deploying the website, check it before the first support group is created: a Relay rollback is safe only until then.

## File map

| Path | Milestone | Responsibility |
|---|---|---|
| `packages/agent-provider-sdk/src/provider.ts` | 1 | `access`, `toolNamespaces`, `sessionAccess`, `updateToolNamespaces` contracts |
| `packages/agent-provider-sdk/src/session-tools.ts` | 1 | `bindAgentSessionToolNamespaces` |
| `packages/agent-provider-codex/src/session.ts` | 1 | read-only sandbox, namespaces at `thread/start`, namespaced `item/tool/call`, executor rebinding, permission lock |
| `packages/agent-provider-codex/src/native-evidence.ts` | 1 | `codexDynamicTools` emits namespace specs |
| `packages/agent-provider-claude/src/session.ts`, `permission-modes.ts`, `session-tools.ts` | 1 | read-only options, permission lock, one MCP server per namespace, live `setMcpServers` |
| `packages/agent-remote-protocol/src/team.ts` | 2 | Team additions and invariants |
| `packages/agent-remote-protocol/src/call-for-support.ts` (new) | 2 | profile, mandate, call, report, roster schemas and validators |
| `packages/agent-remote-protocol/src/remote-host-uplink.ts` | 2 | `callForSupport` capability (read-only providers travel with the request) |
| `packages/agent-remote-hosted/src/call-for-support-profiles.ts` (new) | 2 | per-account profiles and session enablement |
| `packages/agent-remote-hosted/src/call-for-support.ts` (new) | 2 | group creation, calls, rosters, reports, usage, mandate validation |
| `packages/agent-remote-hosted/src/teams.ts`, `team-delivery.ts`, `broker.ts`, `gateway.ts` | 2 | wiring, projection by capability, capacity, routes |
| `packages/agent-host/src/team.ts` | 3 | requester seats, extensions per role, report framing, idle lease release |
| `packages/agent-host/src/call-for-support-instructions.ts` (new) | 3 | coordinator, supporter and enablement texts |
| `packages/agent-host/src/call-for-support-tools.ts` (new) | 3–4 | coordinator tools, worker tools |
| `packages/agent-host/src/host.ts` | 1, 3, 4 | seat creation arguments, provider read-only snapshot, tool injection on attach and enablement |
| `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts` | 3 | negotiate `callForSupport` |
| `packages/agent-host/src/call-for-support-workspaces.ts` (new) | 5 | worktrees, bundles, patches, cleanup |
| `packages/agent-host/src/call-for-support-usage.ts` (new) | 6 | usage accounting per session |
| `packages/agent-remote-lab/src/components/call-for-support/*` (new) | 7 | Settings profiles, call dialog, enablement, roster card, reports, usage |
| `packages/agent-remote-lab/src/components/TeamMenu.tsx`, `App.tsx`, session attributions | 7 | group listing and worker view |
| `docs/current/agent-remote/call-for-support.md` (new), `lab.md`, `relay.md`, `protocol.md` | 8 | current documentation |

---

## Milestone 1: Provider foundations

Outcome: adapters can create and resume read-only sessions that cannot widen their permissions, and can expose tools grouped in namespaces, Codex at thread start (deferred or direct) and Claude live.

### Task 1.1: SDK contracts

**Files:**
- Modify: `packages/agent-provider-sdk/src/provider.ts:30-35,79-91,175`
- Modify: `packages/agent-provider-sdk/src/session-tools.ts`
- Test: `packages/agent-provider-sdk/src/session-tools.test.ts`

- [x] **Step 1: Write the failing test** (append to `session-tools.test.ts`)

```ts
import { bindAgentSessionToolNamespaces } from './session-tools.js';

const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => name });

it('binds tool namespaces with valid, unique names and keeps their deferral', async () => {
  const [bound] = bindAgentSessionToolNamespaces([{ name: 'agent_remote', description: 'Agent Remote Control', deferred: true, tools: [tool('call_for_support')] }]);
  expect(bound).toMatchObject({ name: 'agent_remote', description: 'Agent Remote Control', deferred: true });
  expect(await bound!.tools[0]!.execute({})).toBe('call_for_support');
  expect(() => bindAgentSessionToolNamespaces([{ name: 'bad name', description: '', tools: [tool('a')] }])).toThrow(/namespace/i);
  expect(() => bindAgentSessionToolNamespaces([{ name: 'a', description: '', tools: [tool('x')] }, { name: 'a', description: '', tools: [tool('y')] }])).toThrow(/unique/i);
  expect(() => bindAgentSessionToolNamespaces([{ name: 'tool_search', description: '', tools: [tool('x')] }])).toThrow(/reserved/i);
  expect(() => bindAgentSessionToolNamespaces([{ name: 'n', description: 'x'.repeat(1025), tools: [tool('x')] }])).toThrow(/description/i);
});
it('rejects a call while the session is unavailable', async () => {
  const [bound] = bindAgentSessionToolNamespaces([{ name: 'n', description: 'd', tools: [tool('x')] }], () => { throw new Error('closed'); });
  await expect(bound!.tools[0]!.execute({})).rejects.toThrow('closed');
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/agent-provider-sdk && npx vitest run src/session-tools.test.ts`
Expected: FAIL, `bindAgentSessionToolNamespaces` is not exported.

- [x] **Step 3: Implement**

In `provider.ts`:

```ts
export interface AgentProviderDescriptor {
  providerId: string;
  displayName: string;
  /** Native support for Host-owned extensions on creation and reattachment.
   * toolNamespaces: 'creation' when namespaces are fixed when the session starts, 'live' when they can change at any time. */
  sessionExtensions?: { instructions: boolean; tools: boolean; toolNamespaces?: 'creation' | 'live' };
  /** The adapter enforces AgentSessionExtensions.access natively on creation and reattachment. */
  sessionAccess?: { readOnly: true };
}
```

```ts
/** Tools a provider exposes as one group: a Codex dynamic tool namespace, a Claude MCP server. */
export interface AgentSessionToolNamespace {
  name: string;
  description: string;
  tools: readonly AgentSessionTool[];
  /** Registered but offered to the model only through tool search, where the provider supports it. */
  deferred?: boolean;
}
export interface AgentSessionExtensions {
  tools?: readonly AgentSessionTool[];
  /** Additional role instructions. Preserve the provider's native base prompt and policy. */
  instructions?: string;
  /** Existing provider-specific prompt configuration; use instructions for appended roles. */
  systemPrompt?: string;
  toolNamespaces?: readonly AgentSessionToolNamespace[];
  /** The session must not write its working directory, by any tool or command. Adapters without
   * descriptor.sessionAccess.readOnly reject it. Permission settings of such a session cannot change. */
  access?: 'read_only';
}
```

In `interface AgentSession` (line 175), add:

```ts
  /** Replaces the session's tool namespaces. 'live' adapters may add and remove namespaces; 'creation' adapters
   * may only rebind the executors of namespaces declared when the session started and reject anything else. */
  updateToolNamespaces?(namespaces: readonly AgentSessionToolNamespace[]): Promise<void>;
```

In `session-tools.ts`:

```ts
import type { AgentSessionToolNamespace } from './provider.js';

// Codex reserves these Responses namespaces; Claude MCP server names share the same constraints here.
const RESERVED_NAMESPACES = new Set(['functions', 'multi_tool_use', 'file_search', 'web', 'browser', 'image_gen', 'computer', 'container',
  'terminal', 'python', 'python_user_visible', 'api_tool', 'tool_search', 'submodel_delegator', 'agent_host']);

export function bindAgentSessionToolNamespaces(namespaces: readonly AgentSessionToolNamespace[] = [], assertAvailable: () => void = () => {}): AgentSessionToolNamespace[] {
  const names = new Set<string>();
  return namespaces.map(namespace => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace.name)) throw new Error('Session tool namespace names must match ^[a-zA-Z0-9_-]{1,64}$.');
    if (RESERVED_NAMESPACES.has(namespace.name)) throw new Error(`Session tool namespace ${namespace.name} is reserved.`);
    if (names.has(namespace.name)) throw new Error('Session tool namespace names must be unique.');
    names.add(namespace.name);
    if (typeof namespace.description !== 'string' || namespace.description.length > 1024) throw new Error(`Session tool namespace ${namespace.name} description must be at most 1,024 characters.`);
    return { name: namespace.name, description: namespace.description, ...(namespace.deferred ? { deferred: true } : {}),
      tools: bindAgentSessionTools(namespace.tools, assertAvailable) };
  });
}
```

Export it from the package index if `session-tools.ts` is re-exported there (check `packages/agent-provider-sdk/src/index.ts`; add `bindAgentSessionToolNamespaces` next to `bindAgentSessionTools`).

- [x] **Step 4: Run the tests**

Run: `npx vitest run src/session-tools.test.ts && cd ../.. && pnpm --filter @orchardworks/agent-provider-sdk build && pnpm --filter @orchardworks/agent-provider-sdk typecheck`
Expected: PASS; build and typecheck clean.

- [x] **Step 5: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-provider-sdk packages/agent-remote-lab/compatibility.json
git commit -m "feat(sdk): describe read-only sessions and tool namespaces"
```

### Task 1.2: Codex read-only sessions

**Files:**
- Modify: `packages/agent-provider-codex/src/session.ts` (`create` ~447, `resume` ~583, `setSessionSetting`, command execution of `permissions`)
- Modify: `packages/agent-provider-codex/src/provider.ts` (descriptor)
- Test: `packages/agent-provider-codex/src/session-access.test.ts` (new, scripted app-server)
- Test: `packages/agent-provider-codex/src/read-only.local.test.ts` (new, native)

- [x] **Step 1: Write the failing unit test** with the scripted app-server used by existing tests (`src/test-utils/scripted-app-server.ts`; read its exports first and follow `session.test.ts` usage):

```ts
import { expect, it } from 'vitest';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';
import { CodexAppServerProvider } from './provider.js';

it('starts and resumes a read-only thread in the read-only sandbox without approvals', async () => {
  const server = createScriptedAppServer();
  const provider = new CodexAppServerProvider({ requestTimeoutMs: 2000, spawn: () => server.child });
  expect(provider.descriptor.sessionAccess).toEqual({ readOnly: true });
  const session = await provider.createSession({ sessionId: 's', cwd: '/workspace', access: 'read_only' });
  expect(server.requests('thread/start')[0]).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
  const handle = await session.persistenceHandle!();
  await session.dispose();
  await provider.resumeSession(handle, { access: 'read_only' });
  expect(server.requests('thread/resume')[0]).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
});
it('refuses to widen a read-only session', async () => {
  const server = createScriptedAppServer();
  const provider = new CodexAppServerProvider({ requestTimeoutMs: 2000, spawn: () => server.child });
  const session = await provider.createSession({ sessionId: 's', cwd: '/workspace', access: 'read_only' });
  const permission = (await session.runtimeInfo()).settings?.find(setting => setting.category === 'permissions');
  if (permission) await expect(session.setSessionSetting!(permission.id, 'workspace-write')).rejects.toThrow(/read-only/i);
  await expect(session.executeCommand!('permissions', 'full-access')).rejects.toThrow(/read-only/i);
});
```

Adapt helper names to the scripted server's real API while keeping the assertions.

- [x] **Step 2: Run it to verify it fails**

Run: `cd packages/agent-provider-codex && npx vitest run src/session-access.test.ts`
Expected: FAIL (`sessionAccess` undefined; `thread/start` lacks `sandbox`).

- [x] **Step 3: Implement**

- Descriptor in `provider.ts`: add `sessionAccess: { readOnly: true }` and `sessionExtensions.toolNamespaces: 'creation'`.
- `session.ts`: add `private readonly access?: 'read_only'` to `CodexAppServerSession` (constructor parameter after `recoveryPlan`), and a helper:

```ts
function sandboxParams(access: 'read_only' | undefined, restrictedNative: boolean) {
  if (access === 'read_only') return { sandbox: 'read-only', approvalPolicy: 'never' } as const;
  return restrictedNative ? { sandbox: 'workspace-write', approvalPolicy: 'never' } as const : {};
}
```

  Replace each `...(restrictedNative ? { sandbox: 'workspace-write', approvalPolicy: 'never' } : {})` in `create`, `createNativePrefix` (~516) and `resume` (~587) with `...sandboxParams(access, restrictedNative)`, where `create` reads `config.access` and `resume` reads `extensions.access`.
- In `setSessionSetting` and in the `permissions` command path, when `this.access === 'read_only'` and the setting's category is `permissions` (or the command is `permissions`), throw `new AgentOperationRejectedError('operation_rejected', 'This session is read-only; its permissions cannot change.')`.
- Children opened from a read-only session inherit `access`.

- [x] **Step 4: Run the unit tests**

Run: `npx vitest run src/session-access.test.ts && npx vitest run`
Expected: PASS, no regressions.

- [x] **Step 5: Write the native test** `read-only.local.test.ts`, converted from the experiment `/tmp/codex-ro-experiment.mjs` `readonly` mode: a scripted Responses server issues `exec_command` writes (`echo shell > shell.txt`, `git commit --allow-empty`) and reads (`git show HEAD:existing.txt`) through `CodexAppServerProvider.createSession({ access: 'read_only' })`; assert `shell.txt` absent, commit count unchanged, the read output contains `original`, and no approval interactions were requested.

- [x] **Step 6: Run it**

Run: `BORGEE_CODEX_TEST_EXECUTABLE=<pinned codex> npx vitest run src/read-only.local.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-provider-codex packages/agent-remote-lab/compatibility.json
git commit -m "feat(codex): run read-only sessions in the read-only sandbox"
```

### Task 1.3: Codex tool namespaces

**Files:**
- Modify: `packages/agent-provider-codex/src/native-evidence.ts:87` (`codexDynamicTools`)
- Modify: `packages/agent-provider-codex/src/session.ts` (`create`, `createNativePrefix`, `resume`, `callTool` ~287, new `updateToolNamespaces`)
- Test: `packages/agent-provider-codex/src/tool-namespaces.test.ts` (new)
- Test: `packages/agent-provider-codex/src/tool-namespaces.local.test.ts` (new, native)

- [x] **Step 1: Write the failing unit test**

```ts
it('declares namespaces at thread start and routes namespaced calls', async () => {
  const server = createScriptedAppServer();
  const provider = new CodexAppServerProvider({ requestTimeoutMs: 2000, spawn: () => server.child });
  const calls: unknown[] = [];
  const session = await provider.createSession({ sessionId: 's', cwd: '/workspace', toolNamespaces: [{ name: 'agent_remote', description: 'Agent Remote Control', deferred: true,
    tools: [{ name: 'call_for_support', description: 'Call for support.', inputSchema: { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false },
      execute: async args => { calls.push(args); return 'ACCEPTED'; } }] }] });
  expect(server.requests('thread/start')[0].dynamicTools).toEqual([{ type: 'namespace', name: 'agent_remote', description: 'Agent Remote Control',
    tools: [{ type: 'function', name: 'call_for_support', description: 'Call for support.', deferLoading: true,
      inputSchema: { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false } }] }]);
  const result = await server.serverRequest('item/tool/call', { threadId: server.threadId, callId: 'c', namespace: 'agent_remote', tool: 'call_for_support', arguments: { role: 'reviewer' } });
  expect(result).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'ACCEPTED' }] });
  expect(calls).toEqual([{ role: 'reviewer' }]);
  expect(await server.serverRequest('item/tool/call', { threadId: server.threadId, callId: 'd', namespace: 'other', tool: 'call_for_support', arguments: {} }))
    .toMatchObject({ success: false });
  await session.updateToolNamespaces!([{ name: 'agent_remote', description: 'Agent Remote Control', tools: [{ name: 'call_for_support', description: 'Call for support.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' } }, required: ['role'], additionalProperties: false }, execute: async () => 'REBOUND' }] }]);
  expect(await server.serverRequest('item/tool/call', { threadId: server.threadId, callId: 'e', namespace: 'agent_remote', tool: 'call_for_support', arguments: { role: 'x' } }))
    .toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'REBOUND' }] });
  await expect(session.updateToolNamespaces!([{ name: 'new_namespace', description: 'd', tools: [] }])).rejects.toThrow(/thread start/i);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tool-namespaces.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

`native-evidence.ts`:

```ts
export function codexDynamicTools(tools: readonly Pick<AgentSessionTool, 'name' | 'description' | 'inputSchema'>[] | undefined,
  namespaces: readonly AgentSessionToolNamespace[] = []) {
  const functions = (tools ?? []).map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema }));
  const grouped = namespaces.map(namespace => ({ type: 'namespace', name: namespace.name, description: namespace.description,
    tools: namespace.tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema, ...(namespace.deferred ? { deferLoading: true } : {}) })) }));
  const all = [...functions, ...grouped];
  return all.length ? all : undefined;
}
```

`session.ts`:
- Field `toolNamespaces: AgentSessionToolNamespace[] = []`, set with `bindAgentSessionToolNamespaces(config.toolNamespaces / extensions.toolNamespaces, () => session.assertOpen())` next to `session.tools`.
- `dynamicTools: codexDynamicTools(session.tools, session.toolNamespaces)` where tools are declared (`create`, and `createNativePrefix` when not forking). Resume does not declare; it only binds executors (Codex keeps declarations in thread metadata).
- `callTool`: when `params.namespace != null`, find the namespace by name and the tool inside it; otherwise use `this.tools`. Unknown namespace or tool → `success: false` with "Session tool is unavailable."
- `updateToolNamespaces(namespaces)`: bind them; reject with `AgentOperationRejectedError('operation_rejected', 'Codex tool namespaces are fixed at thread start; only their executors can change.')` if any name, tool name set or deferral differs from the declared namespaces recorded when the thread started (record a declaration signature `JSON.stringify(namespaces.map(n => [n.name, !!n.deferred, n.tools.map(t => t.name)]))`; on resume, the signature is the one from the extensions given to `resume`); otherwise replace `this.toolNamespaces`.

- [x] **Step 4: Run the unit tests**

Run: `npx vitest run src/tool-namespaces.test.ts && npx vitest run`
Expected: PASS.

- [x] **Step 5: Write the native test**, converted from the experiment's `search` mode: model `gpt-5.5` in the fixture config (a catalog model with the search tool), a deferred `agent_remote.call_for_support`; the scripted model emits `tool_search_call` then a namespaced `function_call`; assert the first request's tools omit `call_for_support`, the search output contains it, the executor ran with `{ role: 'code reviewer' }`, and the function output reached the model. A second case with model `mock-model` and `deferred: false` asserts the tool is in the first request's tools.

- [x] **Step 6: Run it on the pinned version**

Run: `BORGEE_CODEX_TEST_EXECUTABLE=<codex 0.162.0> npx vitest run src/tool-namespaces.local.test.ts`
Expected: PASS. If 0.162.0 rejects namespaces or `deferLoading`, install the first version that passes, update the pin in `packages/agent-remote-lab/src/server/compatibility.ts` and its manifest consumers in the same commit, and record the reason in the compatibility manifest.

- [x] **Step 7: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-provider-codex packages/agent-remote-lab
git commit -m "feat(codex): declare tool namespaces at thread start and route namespaced calls"
```

### Task 1.4: Claude read-only sessions

**Files:**
- Modify: `packages/agent-provider-claude/src/permission-modes.ts`
- Modify: `packages/agent-provider-claude/src/session.ts` (constructor ~118, query options ~172, `setSessionSetting` ~373, `setPlanning` ~404)
- Modify: `packages/agent-provider-claude/src/provider.ts` (descriptor, pass `access` on create and resume)
- Test: `packages/agent-provider-claude/src/permission-modes.test.ts`, `session-access.test.ts` (new, fake query)
- Test: `packages/agent-provider-claude/src/read-only.local.test.ts` (new, native; replaces `zz-read-only-experiment.local.test.ts`)

- [x] **Step 1: Write the failing unit tests**

```ts
// permission-modes.test.ts
import { claudeReadOnlyOptions } from './permission-modes.js';
it('builds read-only options that remove edit tools and deny workspace writes', () => {
  expect(claudeReadOnlyOptions('/w')).toEqual({ permissionMode: 'dontAsk', disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { denyWrite: ['/w'] } } });
});
```

```ts
// session-access.test.ts, using the fake query pattern of existing session tests (options.query)
it('opens a read-only session with read-only options and refuses permission changes', async () => {
  let options: any;
  const session = await openFakeClaudeSession({ cwd: '/w', access: 'read_only' }, captured => { options = captured; });
  expect(options).toMatchObject(claudeReadOnlyOptions('/w'));
  await expect(session.setSessionSetting('permissions', 'bypassPermissions')).rejects.toThrow(/read-only/i);
  await expect(session.setPlanning(true)).rejects.toThrow(/read-only/i);
});
```

`openFakeClaudeSession` is the helper the existing session unit tests use; reuse it (search `options.query` in `src/*.test.ts`).

- [x] **Step 2: Run them to verify they fail**

Run: `cd packages/agent-provider-claude && npx vitest run src/permission-modes.test.ts src/session-access.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

`permission-modes.ts`:

```ts
/** Verified with Claude Code 2.1.247: no edit tools, workspace writes fail in the sandbox, reads and scratch writes work, nothing asks. */
export function claudeReadOnlyOptions(cwd: string) {
  return { permissionMode: 'dontAsk' as const, disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { denyWrite: [cwd] } } };
}
```

`session.ts`:
- `ClaudeSessionConfig` gains `access?: 'read_only'`; a read-only session requires `cwd` (throw otherwise).
- In the constructor, a read-only session sets `this.permissionMode = 'dontAsk'` and ignores stored or resumed modes.
- In query options, spread `claudeReadOnlyOptions(config.cwd)` last for read-only sessions, so neither `sandbox` nor `permissionMode` from other paths apply.
- `setSessionSetting('permissions', …)` and `setPlanning(…)` throw `new AgentOperationRejectedError('operation_rejected', 'This session is read-only; its permissions cannot change.')` for read-only sessions; the `permissions` setting in `runtimeInfo` is reported with only the current option.
- The permission mode store is not written for read-only sessions.

`provider.ts`: descriptor `sessionAccess: { readOnly: true }`; pass `access` from `config.access` on create and from `extensions.access` on resume.

- [x] **Step 4: Run the unit tests**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 5: Convert the experiment into the native test** `read-only.local.test.ts` through `ClaudeAgentSession.open({ …, access: 'read_only' }, fixture.options)`: the scripted model attempts Read, Edit, Write, `echo > shell.txt`, `git commit --allow-empty`, `git show HEAD:existing.txt`, `cat`, and a write to `$TMPDIR`; assert the workspace is unchanged, the git read and `cat` succeed, the scratch write succeeds, and no `interaction_requested` event occurred. Delete `zz-read-only-experiment.local.test.ts`.

- [x] **Step 6: Run it**

Run: `AGENT_CLAUDE_TEST_EXECUTABLE=$HOME/.nvm/versions/node/v22.23.2/bin/claude npx vitest run src/read-only.local.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-provider-claude packages/agent-remote-lab/compatibility.json
git commit -m "feat(claude): run read-only sessions without edit tools in a write-denying sandbox"
```

### Task 1.5: Claude tool namespaces, live

**Files:**
- Modify: `packages/agent-provider-claude/src/session-tools.ts`
- Modify: `packages/agent-provider-claude/src/session.ts` (`hostTools` ~113/168/180/523, new `updateToolNamespaces`)
- Modify: `packages/agent-provider-claude/src/provider.ts` (descriptor `toolNamespaces: 'live'`)
- Test: `packages/agent-provider-claude/src/session-tools.test.ts`, `session-namespaces.test.ts` (new)
- Test: `packages/agent-provider-claude/src/tool-namespaces.local.test.ts` (new, native; replaces `zz-dynamic-mcp-experiment.local.test.ts`)

- [x] **Step 1: Write the failing unit test**

```ts
it('adds and removes namespace servers on the running query, keeping the host server', async () => {
  const applied: Array<Record<string, unknown>> = [];
  const session = await openFakeClaudeSession({ cwd: '/w', tools: [hostTool('read_team')] }, undefined, { setMcpServers: async servers => { applied.push(servers); return { added: Object.keys(servers), removed: [], errors: {} }; } });
  await session.updateToolNamespaces!([{ name: 'agent_remote', description: 'Agent Remote Control', tools: [hostTool('call_for_support')] }]);
  expect(Object.keys(applied.at(-1)!).sort()).toEqual(['agent_host', 'agent_remote']);
  await session.updateToolNamespaces!([]);
  expect(Object.keys(applied.at(-1)!)).toEqual(['agent_host']);
});
it('declares namespaces present at open as their own servers', async () => {
  let options: any;
  await openFakeClaudeSession({ cwd: '/w', toolNamespaces: [{ name: 'agent_remote', description: 'd', tools: [hostTool('call_for_support')] }] }, captured => { options = captured; });
  expect(Object.keys(options.mcpServers)).toEqual(['agent_remote']);
});
```

`hostTool(name)` returns an `AgentSessionTool` with an object schema; add it to the test file.

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/session-namespaces.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

- `session-tools.ts`: `createClaudeSessionTools(definitions, assertAvailable, name = 'agent_host')` names its server.
- `session.ts`: `private namespaceServers = new Map<string, ReturnType<typeof createClaudeSessionTools>>()`; at open, build one server per `config.toolNamespaces` entry (deferral is ignored: Claude has no deferred MCP tools); query options `mcpServers: { ...(hostTools ? { agent_host: hostTools } : {}), ...Object.fromEntries(namespaceServers) }`.
- `updateToolNamespaces(namespaces)`: bind with `bindAgentSessionToolNamespaces`, build servers, call `this.native.setMcpServers({ agent_host?, ...new })`, check `errors` is empty (throw the first error otherwise), close servers that were removed, then replace the map. Serialize with the existing settings change guard so it cannot race a turn start.
- `dispose`: close every namespace server.

- [x] **Step 4: Run the unit tests**

Run: `npx vitest run`
Expected: PASS.

- [x] **Step 5: Convert the experiment into the native test** `tool-namespaces.local.test.ts` through `ClaudeAgentSession`: open without namespaces, send a first turn, call `updateToolNamespaces` with `agent_remote.call_for_support`, send a second turn scripted to call `mcp__agent_remote__call_for_support`; assert the second request's tools include it, the executor ran, and the turn result contains the tool output. Then remove the namespace and assert the next request no longer lists it. Delete `zz-dynamic-mcp-experiment.local.test.ts`.

- [x] **Step 6: Run it**

Run: `AGENT_CLAUDE_TEST_EXECUTABLE=$HOME/.nvm/versions/node/v22.23.2/bin/claude npx vitest run src/tool-namespaces.local.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-provider-claude packages/agent-remote-lab/compatibility.json
git commit -m "feat(claude): expose tool namespaces as MCP servers that can change during a session"
```

### Task 1.6: Host passes configuration and access to new seats

**Files:**
- Modify: `packages/agent-host/src/team.ts:12-23` (`TeamRuntimeAccess.create`)
- Modify: `packages/agent-host/src/host.ts:1251` (`automationAccess.create`), provider registration read-only report
- Test: `packages/agent-host/src/team-host.test.ts` or a new `team-seat-configuration.test.ts`

- [x] **Step 1: Write the failing test**: create a Team seat whose member has `model: 'm'`, `reasoningEffort: 'high'`, `access: 'read_only'` through `TeamRuntime.create` with a fake `TeamRuntimeAccess`; assert `access.create` received `{ providerId, cwd, model: 'm', reasoningEffort: 'high', extensions: { …, access: 'read_only' } }`; and a Host-level test that `automationAccess.create` forwards `model`, `reasoningEffort` and `access` to `directory.create`, and rejects `access: 'read_only'` for a registration whose adapter lacks `descriptor.sessionAccess.readOnly`.

Until milestone 2 adds the fields to `TeamMember`, the test builds the seat with a local type that extends `TeamSeat`; milestone 2 replaces it with the protocol type.

- [x] **Step 2: Run it to verify it fails.**

Run: `cd packages/agent-host && npx vitest run src/team-seat-configuration.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

```ts
export interface TeamSeatCreation { cwd?: string; model?: string; reasoningEffort?: string }
export interface TeamRuntimeAccess {
  …
  create(provider: string, creation: TeamSeatCreation, extensions: AgentSessionExtensions): Promise<string>;
}
```

`host.ts` `automationAccess.create(providerId, creation, extensions)`: reject `extensions.access === 'read_only'` unless `registration(providerId).adapter.descriptor.sessionAccess?.readOnly`; then `directory.create({ ...creation, ...extensions }, evidence)`. Update the TPM caller of `create` (`packages/agent-host/src/tpm.ts`) to pass `{ cwd }`.

Expose `readOnlyProviders(): string[]` from the Host (registrations whose descriptor declares `sessionAccess.readOnly` and are enabled) for milestone 3's provider snapshot.

*As built:* the configuration is `roleSessionConfig(descriptor, creation, extensions)` in `packages/agent-host/src/role-session-creation.ts`, unit-tested directly. Team passes `{ cwd }` until Task 2.2 gives `TeamMember` its `model`, `reasoningEffort` and `access`; the Team-level forwarding test moves there. `readOnlyProviders()` is not added: Task 2.3 reports `readOnly` in `describeProviders` from `descriptor.sessionAccess` directly.

- [x] **Step 4: Run the agent-host suite**

Run: `npx vitest run src/team-seat-configuration.test.ts && pnpm test`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-host packages/agent-remote-lab/compatibility.json
git commit -m "feat(controller): create Team seats with a model, effort and access"
```

### Milestone 1 exit

- [x] `pnpm -r run build && pnpm typecheck` clean; unit suites of the SDK, Codex, Claude and agent-host pass; the four native tests pass.
- [x] Remove `/tmp` experiment leftovers from the worktree if any remain (`git status` clean apart from committed work).

---

## Milestone 2: Protocol and Relay groups

Outcome: the Relay stores profiles and enablement, creates and reuses groups, validates and provisions rosters in both approval modes, records calls, reports, ledgers, releases and usage, and hides groups from incapable Controllers.

Refinements found while expanding this milestone (recorded in the spec's "Refinements" section):
- Profiles and enablement live in the tenant broker state (`RemoteHostBrokerState.callForSupport`) next to `teams`, not in the gateway's favorites state: the tenant broker is per account, and group creation must read profiles in the same commit. Routes: `GET /v1/remote/call-for-support`, `POST /v1/remote/call-for-support/profiles`, `POST /v1/remote/call-for-support/enablement`, owner only like Teams.
- Effective enablement of a session: its explicit entry if the user set one (possibly empty), otherwise the profiles with `enableByDefault`.
- Call status gains `queued`: a call that arrives while another is open waits; reporting the open call opens the next one and queues its message. A call's `task` is at most 12000 characters so its framed message fits the 16000-character Team message.
- The Relay frames call and report messages; Controllers deliver them like other Team messages.
- A roster decision reaches the coordinator as a message from the requester seat, prefixed `[Call For Support]`, because Team messages always have a member sender.
- Storage: a report is at most 24 KiB of JSON; a group's `callForSupport` is kept within 64 KiB by compaction (evidence of all but the latest reported call, then findings of the oldest reported calls, then the oldest reported calls); the tenant's 2 MiB Team state bound is unchanged.

### Task 2.1: Call For Support schemas
**Files:** create `packages/agent-remote-protocol/src/call-for-support.ts`, `call-for-support.test.ts`; export from `src/index.ts`.
- TypeBox schemas, all `additionalProperties: false`:
  - `CallForSupportSupporterConfiguration { providerId; model (1..256); reasoningEffort? (1..64) }`.
  - `CallForSupportMandate { supporters (1..8); maxSupporters (1..6); workspaces (1..3 unique of shared|worktree|remote); remoteHosts ({ hostId; workspace (1..2048) }, 0..8); approval; budget? { tokensPerCall? ≥1; tokensTotal? ≥1; costUsdTotal? >0 } }`.
  - `CallForSupportCoordinatorConfiguration { providerId?; model?; reasoningEffort? }`.
  - `CallForSupportProfile { id; name (1..128); description (≤4000); mandate; coordinator; enableByDefault; revision ≥1; updatedAt }`.
  - `CallForSupportContext { commit? and base? (git object names `^[0-9a-f]{7,64}$`); files? (≤64 of 1..2048); conversation? }`.
  - `CallForSupportFinding`, `CallForSupportReport` (findings ≤64, resources `TeamResource` 1..8), `CallForSupportUsage { tokens ≥0 integer; costUsd? ≥0 }`.
  - `CallForSupportCall { id; task (1..12000); followUpOf?; context?; deliverable; origin; status open|queued|reported|needs_input|failed; createdAt; reportedAt?; usage; report? }`.
  - `CallForSupportRosterMember { name; responsibility; providerId; model; reasoningEffort?; workspace; hostId? }`, `CallForSupportRoster { id; status; members (1..6); release? (≤12 ids); rationale (≤4000); withinMandate; createdAt; decidedAt?; note? }`.
  - `CallForSupportGroup { profileId?; profileRevision?; role (1..256); description (≤4000); mandate; coordinator { providerId; model?; reasoningEffort? }; status active|paused_budget; pauseReason?; calls (≤64); roster?; ledger { text ≤16000; revision ≥0 }; usage }`.
- Validators `isCallForSupportMandate` etc. add: `remote` in `workspaces` ⇒ `remoteHosts` non-empty; unique supporter configurations; unique remote hosts; `isCallForSupportRoster`: `hostId` present exactly for `remote` members; `isCallForSupportGroup`: unique call IDs, `followUpOf` names a listed call or is absent, at most one `open` call, report present exactly for reported/needs_input/failed calls with matching status.
- `callForSupportReportBytes(report)` and the constants `CALL_FOR_SUPPORT_REPORT_BYTES = 24 * 1024`, `CALL_FOR_SUPPORT_GROUP_BYTES = 64 * 1024`, `CALL_FOR_SUPPORT_PROFILE_LIMIT = 32`.
- Tests: a full valid value of each; each bound at its limit and over; unknown fields; `remote` without hosts; duplicate configurations; two open calls; report/status mismatch.

### Task 2.2: Team additions and invariants
**Files:** `packages/agent-remote-protocol/src/team.ts`, `team.test.ts` (create if absent); `packages/agent-host/src/team.ts` and a Team-host test.
- `TeamMember`: role `requester`; creation `released`; `model?`, `reasoningEffort?`, `access?: 'read_only'`, `workspace?` (`{kind:'shared'} | {kind:'worktree'; commit} | {kind:'remote'; commit; repository}`), `usage?: { tokens; costUsd?; updatedAt }`.
- `TeamMessage.callForSupportCallId?`; `Team.callForSupport?: CallForSupportGroup`.
- `TeamCreate.callForSupport?: { profileId; call: { task; context?; deliverable }; fresh? }`.
- `TeamAction` adds `call_for_support { teamId; operationId; task; context?; deliverable; followUpOf? }`, `resolve_roster { teamId; rosterId; decision; note? }`, `release_member { teamId; memberId }`, `update_mandate { teamId; mandate; profileRevision? }`, `resume_group { teamId }`.
- `TeamHostCall` adds `propose_roster { teamId; memberId; operationId; members; release?; rationale }`, `report_support { teamId; memberId; callId; operationId; report: { status; summary; findings; resources? (resource IDs) } }`, `write_ledger { teamId; memberId; revision; text }`, `release_supporter { teamId; memberId; target }`, `report_usage { teamId; memberId; tokens; costUsd? }`, `call_for_support { worker: { providerId; nativeSessionId; title? }; operationId; roleId?; profileId?; task; context?; deliverable; followUpOf?; fresh? }`, `support_status { worker: { providerId; nativeSessionId }; roleId?; callId? }`.
- `isTeam` additions: members after the Leader are `member` or `requester`; exactly one requester when `callForSupport` is set and none otherwise, never at index 0; `workspace`, `model`, `reasoningEffort`, `access` and `usage` only in groups; `shared` members are `read_only` and on the source host; `callForSupportCallId` only in groups; no `queued` message targets a `released` member; `isCallForSupportGroup(team.callForSupport)`.
- `packages/agent-host/src/team.ts`: seat creation passes `{ cwd, model, reasoningEffort }` and `access` in the extensions. Test in `team-host.test.ts` style: a member with `model`, `reasoningEffort`, `access` reaches `directory.create` with them.
- Tests: existing Team tests unchanged; a valid group Team; each invariant rejects a crafted violation.

### Task 2.3: Uplink capability and provider flag
**Files:** `packages/agent-remote-protocol/src/remote-host-uplink.ts` (+ test), `packages/agent-remote-hosted/src/broker.ts`, `packages/agent-host/src/host.ts` (`describeProviders`), `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts` (+ test).
- `registered.callForSupport?: 1`; provider entries `readOnly?: true`.
- Broker: the query parameter `callForSupport=1`, honored only with `teamSuccession`, sets `host.callForSupport = 1` for the connection, like `teamRecipients`, and the Relay acknowledges it.
- Uplink client: option `callForSupport?: true` requests it; `client.callForSupport` reports the acknowledgement; registration mismatch handling like `teamSuccession`.
- Controller: `describeProviders` adds `readOnly: true` from `adapter.descriptor.sessionAccess?.readOnly`; the Host requests `callForSupport` when `team` is configured (Milestone 3 implements the Controller side; until then it is not requested).
- Tests: schema round trip; broker acknowledges only when requested; uplink client tracks it.

### Task 2.4: Profiles store and session enablement
**Files:** create `packages/agent-remote-hosted/src/call-for-support-profiles.ts` (+ test); `broker.ts` state and routes.
- `RemoteHostBrokerState.callForSupport?: { profiles: CallForSupportProfile[]; enablement: Array<{ hostId; providerId; nativeSessionId; profileIds: string[]; updatedAt }> }` (enablement ≤ 1024 entries, oldest dropped).
- Pure functions on the state: `executeProfileCommand(state, command, now)` for `{ type: 'create'; profile: Omit<…, 'id'|'revision'|'updatedAt'> } | { type: 'update'; id; revision; profile } | { type: 'delete'; id; revision }` with conflicts on revision mismatch and capacity 32; `setEnablement(state, anchor, profileIds, now)` (profile IDs must exist); `effectiveProfiles(state, resolve, worker)` returning the explicit entry whose anchor resolves to the worker, else `enableByDefault` profiles.
- Broker routes (owner only): `GET /v1/remote/call-for-support` → `{ profiles, enablement }` with enablement anchors projected to their current sessions; `POST …/profiles` and `POST …/enablement`.
- Tests: CRUD with revisions, conflicts, capacity, unknown profile in enablement, enablement following a handoff (resolve through a succession), default profiles, per-tenant isolation through two brokers.

### Task 2.5: Group creation, reuse and calls
**Files:** create `packages/agent-remote-hosted/src/call-for-support.ts` (pure group operations on `SavedTeam`) + test; `teams.ts` (wire), `broker.ts` (ports).
- `TeamBrokerPorts` gains `callForSupport?: { profiles(): CallForSupportProfile[]; effectiveProfiles(hostId, worker): CallForSupportProfile[]; assertHost(hostId): void; readOnly(hostId, providerId): boolean }`.
- `createGroup(teams, input, now)`: Team with `callForSupport` from the profile (role = profile name, description, mandate and coordinator copied, `profileId`, `profileRevision`), Leader = coordinator (worker host, coordinator provider or the worker's, model, effort, `read_only`, `shared`), member 1 = requester (worker host and provider, `nativeSessionId` of the worker, responsibility "Worker"), first call, and the call message requester → Leader. Team count limit 128.
- Provisioning order: the requester seat first (Controller binds and reports `cwd`), then the Leader with the requester's `cwd`.
- `addCall(team, input, now)`: validates `followUpOf`; status `open` and message queued when no call is open, else `queued`.
- Worker host calls: `call_for_support` resolves the worker on the calling host, checks effective enablement (`unavailable` otherwise), uses `roleId` (group whose requester resolves to the worker) or `profileId` (reuse the active group for worker+profile unless `fresh`, which archives it; else create), returns `{ status, callId, roleId, message }`; neither → `needs_approval`. `support_status` returns enabled profiles, the worker's groups (roleId, role, status, requester member ID, open and queued calls, last report summary) or one call with its report.
- User: `TeamCreate.callForSupport` creates a group from the website; `TeamAction.call_for_support` adds a call.
- `send`: a Leader may not message the requester; a requester may not use `send`.
- Tests: create (members, provisioning order, call message), reuse, `fresh`, follow-up validation, queued calls, disabled session, unknown role, incapable host.

### Task 2.6: Rosters, approval modes and provisioning
**Files:** `call-for-support.ts`, `teams.ts`.
- `propose_roster` (Leader only): hard errors (group paused, unknown or incapable host, provider not on the host, `shared` with a provider without `readOnly`, `worktree`/`remote` without a commit on the open call, release of a non-supporter, Team member capacity); mandate checks set `withinMandate` (configuration in `supporters`, workspace in `workspaces`, `remote` host in `remoteHosts`, active supporters after releases ≤ `maxSupporters`). A new proposal replaces a pending one.
- `every_roster` or outside the mandate → `pending`; otherwise `approved` and provisioned at once. `resolve_roster` approves or rejects; rejection queues a `[Call For Support]` note to the Leader.
- Provisioning: release listed members (creation `released`, queued messages to them canceled), add members with IDs derived from roster ID and index, `cwd` = requester `cwd` for `shared` and `worktree`, the repository for `remote`, `workspace` with the open call's commit, `access: 'read_only'` for `shared`; provision each; roster `provisioned`.
- `release_member` (user) and `release_supporter` (Leader) release one supporter.
- Tests: each rule; both approval modes; releases before additions; replacement of a pending proposal; rejection note.

### Task 2.7: Reports, ledger, usage and pause
**Files:** `call-for-support.ts`, `teams.ts`.
- `report_support` (Leader only, open call or replay of the same `operationId`): resources accessible to the Leader; report ≤ 24 KiB; stored on the call; framed message to the requester with `callForSupportCallId` and the resources; next queued call opens.
- Report framing: `[Support report · <role> · call <id> · <status>]`, summary, findings without evidence (`- [severity] location: problem → suggestion (agreement)`), resource lines, and the fixed advice note; truncated findings end with "Read the full report with read_support_report.".
- `write_ledger` (Leader only, revision-checked, ≤16000).
- `report_usage` (the member's own Host; monotonic per member): adds the increase to the member, the open call and the group; reaching `tokensPerCall`, `tokensTotal` or `costUsdTotal` sets `paused_budget` with the reason and reports the open call `needs_input` to the requester. While paused, `claim` refuses messages to the Leader and supporters, and new calls answer `unavailable`.
- `update_mandate` replaces the mandate (and `profileRevision`); `resume_group` reactivates if no bound is reached.
- Compaction to 64 KiB after each change.
- Tests: framing text; replay; ledger conflict; usage aggregation and monotonicity; each bound; pause effects; resume; compaction order.

### Task 2.8: Projection, capacity and compatibility
**Files:** `teams.ts`, `broker.ts`.
- `poll` and member host calls omit or refuse groups for hosts without `callForSupport`; browsers receive groups.
- Capacity test: 24 groups at their 64 KiB bound fit in 2 MiB with their messages; adding full groups until the bound fails with "Team storage capacity reached" and leaves the state unchanged.
- Existing hosted suites unchanged.

Milestone 2 exit: `pnpm --filter @orchardworks/agent-remote-protocol test`, `pnpm --filter @orchardworks/agent-remote-hosted test`, Cloudflare package tests, typecheck.

---

## Milestone 3: Controller groups

Outcome: Controllers negotiate the capability, bind requester seats, give coordinators and supporters their extensions, deliver reports as framed input, and release idle members' runtimes.

### Task 3.1: Negotiation and group seats
**Files:** `packages/agent-remote-protocol/src/team.ts` (`TeamSeat`), `packages/agent-remote-hosted/src/teams.ts` (`provisionOnce`), `packages/agent-host/src/host.ts` (`createAgentHost`, `automationAccess`), `packages/agent-host/src/team.ts`.
- `TeamSeat.callForSupport?: { role; description }`, set by the Relay for every seat of a group.
- `createAgentHost` requests `callForSupport` when Teams are configured and passes `callForSupport: () => client.callForSupport` to the Team runtime; `TeamRuntimeAccess` gains `callForSupport?(): boolean` and `readOnlyProviders?(): string[]` (registrations whose descriptor declares `sessionAccess.readOnly`).
- `TeamRuntime.create` refuses group seats unless the Relay acknowledged the capability.
- Tests: uplink option wiring in a Team-host test; refusal without acknowledgement.

### Task 3.2: Requester seats
**Files:** `packages/agent-host/src/team.ts` + `team-requester.test.ts`.
- `createOnce` for `requester`: acquire the source session (the worker), read its `cwd`, release, record the seat `ready` with the worker's `nativeSessionId`; no native creation.
- `seatHeldBy` ignores requester seats: they carry no Team tools, so the worker keeps its own role and moves freely in handoffs; its seat follows by role routing.
- Delivery to a requester: the message text as framed by the Relay, without the Team header; `immediate` when the worker is idle, `next_turn` while it is busy (never steered into a running turn).
- Tests: binding reports `cwd` without `create`; no extensions for the worker; a report delivered verbatim, queued for the next turn while busy and started when idle.

### Task 3.3: Coordinator and supporter extensions
**Files:** create `packages/agent-host/src/call-for-support-roles.ts` (instructions and coordinator tools) + test; `team.ts` (`tools`, `genericSuccession`); `team-inbox.ts`.
- Coordinator (`leader` of a group): instructions from the spec's "Coordinator instructions"; tools `read_team` (with the group's calls, roster, ledger and mandate), `acknowledge_team_messages`, `send_team_message`, `read_source_session`, `upload_team_resource`, `download_team_resource`, `report_team_progress`, `propose_roster`, `release_supporter`, `report_support`, `write_ledger`.
- Supporter (`member` of a group): supporter instructions (work only on the brief, report evidence to the coordinator, never write outside the own worktree, read `shared` code at the commit through git); the existing member tools; `read_team` without the group state.
- Read-only seats move only to providers in `readOnlyProviders()`.
- Tests: tool lists per role; argument schemas; host-call payloads of the new tools; instructions name the encapsulation rules; supporters do not see the group state; a read-only seat's handoff to a provider without read-only enforcement is refused.

### Task 3.4: Idle lease release
**Files:** `packages/agent-host/src/team.ts` + test.
- The tick holds a member's lease while a message to it is queued, dispatching or unsettled, until the member reports idle, and while its Team is archiving; it reports presence only for leased members, so presence stays current until idle; released and abandoned members are skipped. Applies to all Teams.
- Tests: an idle member without messages holds no lease; a queued message acquires, delivers and releases after settlement; archiving acquires to report presence and completes.

Milestone 3 exit: agent-host suite, Team suites, typecheck.

---

## Milestone 4: Worker tools

Outcome: enabled sessions can call, list, read and download; tools are injected on attach, at creation and on enablement changes.

Decisions:
- The Controller learns enablement by polling the Relay (`support_enablement` host call): the explicit entries for its sessions, resolved to the sessions that hold them now, and whether any profile is enabled by default.
- Worker tools go only to sessions without a role (no Team or TPM seat); a worker's requester seat carries no role, so the worker keeps them.
- Codex (`toolNamespaces: 'creation'`): the `agent_remote` namespace is declared on every Controller-created thread that has no role (website creation, handoff successors, prompt-edit branches), direct when the session is enabled at creation and deferred otherwise; attachments rebind its executors. Claude (`'live'`): the namespace is present only while enabled, and changes are applied with `updateToolNamespaces` on live attachments.
- No separate enablement note is sent: it would start a turn on an idle worker. Tool and namespace descriptions say when to call; the website's call path always works. (Spec refinement.)

### Task 4.1: Enablement feed
**Files:** `packages/agent-remote-protocol/src/team.ts` (`TeamHostCall` `support_enablement`), `packages/agent-remote-hosted/src/call-for-support.ts` + test.
- `{ action: 'support_enablement' }` → `{ defaultEnabled: boolean; sessions: Array<{ providerId; nativeSessionId; enabled: boolean }> }` for the calling Host, entries resolved through role succession.
- Tests: explicit entries on and off, defaults, entries of other Hosts omitted, a handed-off session reported as its successor.

### Task 4.2: Worker tools
**Files:** create `packages/agent-host/src/call-for-support-worker.ts` + test.
- `WorkerSupport` (ports: `request`, `available`, resource files): polls enablement on its own interval while the Relay acknowledged Call For Support; `enabled(ref)`; `namespace(actual, deferred)` returning `agent_remote` with `call_for_support`, `support_status`, `read_support_report`, `download_support_resource`.
- Tools: `call_for_support` and `support_status` forward to the Relay with the worker's current session; `read_support_report` reads the call through `support_status` and returns the report or one finding with its evidence; `download_support_resource` checks the resource belongs to the call's report and downloads it through the worker seat with Team resource files into a verified local path.
- Tests: schemas; each tool against a support harness; unavailable answers while disabled; download verification.

### Task 4.3: Injection
**Files:** `packages/agent-host/src/host.ts`, `stdio-directory.ts` (`composeExtensions` keeps `access` and `toolNamespaces`), + `call-for-support-injection.test.ts`.
- Extensions of a session = its role's extensions, else the worker namespace per provider capability (above); used on attach, for handoff successors created empty, for prompt-edit branches and for website creation (dispatch only, never in cached operation parameters).
- On an enablement change, `updateToolNamespaces` on live attachments of `live` providers that hold no role.
- Tests: Codex creation declares the namespace deferred or direct; Claude attach includes it only when enabled; an enablement change adds and removes it on a live Claude session; role sessions never get it; `composeExtensions` keeps the fields.

Milestone 4 exit: agent-host suite and typecheck. Native Controller-level acceptance of the worker tools runs in Milestone 8.

---

## Milestone 5: Workspaces and patches

Outcome: `worktree` and `remote` supporters get their own worktrees at the call's commit, and their patches reach the worker.

Decisions (verified with git 2.54 in a scratch repository):
- A bundle names a temporary ref `refs/agent-remote/bundle/<id>` at the commit (`<base>..<ref>` when a base is known); the remote fetches it to `refs/agent-remote/support/<id>`, which keeps the commit reachable, and adds a detached worktree.
- A patch is `git add -A` in the supporter's own worktree, then `git diff --cached --binary <commit>`: one patch with committed, uncommitted and new files, applicable with `git apply` at the commit.
- The Relay drives both exchanges with new Controller paths `/remote/team/support-bundle` (the worker's Host creates and uploads the bundle as its seat) and `/remote/team/support-patch` (the supporter's Host produces and uploads the patch as the supporter), and grants the resulting resource to the member that needs it. A member still being created may read resources granted to it, on its own Host.
- Worktrees are removed when the Controller sees their member released or their Team archiving.

### Task 5.1: Worktrees
**Files:** create `packages/agent-host/src/call-for-support-workspaces.ts` + test.
- `repositoryRoot(cwd)`; `worktreePath(root, teamId, memberId)` = `<root>/.agent-remote/worktrees/<teamId>/<memberId>` (identifiers checked); `prepareWorktree(cwd, teamId, memberId, commit)` writes `.agent-remote/` to the common `info/exclude` once, checks the commit exists, reuses an existing worktree at that commit, else `git worktree add --detach`, and returns the path plus the worker's relative subdirectory; `removeWorktree(root, path)` (`git worktree remove --force`, `git worktree prune`).
- `TeamRuntime` seat creation for `worktree` members creates the session in the worktree; the tick removes worktrees of released members and of archiving Teams, once.
- Tests against temporary repositories: creation at the commit, exclude entry written once, reuse, removal and prune, missing commit error; a worktree seat created in its worktree and cleaned up on release.

### Task 5.2: Remote bundles
**Files:** `call-for-support-workspaces.ts` (`createBundle`, `fetchBundle`), `packages/agent-host/src/host.ts` (`/remote/team/support-bundle`), `team.ts`, protocol `requestPath` and `TeamMemberWorkspace.remote.bundle?`, `packages/agent-remote-hosted/src/call-for-support.ts` (provisioning), `teams.ts` (resource reads of members being created).
- Relay: before creating a `remote` member, it asks the worker's Host for a bundle of the call's commit (base when given), grants the resource to the member and records it in `workspace.bundle`.
- Remote Controller: downloads the bundle as the member, fetches it into the repository, prepares the worktree, creates the session there.
- Tests: bundle with and without base, fetch into a clone that lacks the commit, failure messages; Relay provisioning order with a fake Host.

### Task 5.3: Patch collection
**Files:** `call-for-support-workspaces.ts` (`collectPatch`), `host.ts` (`/remote/team/support-patch`), `team.ts`, protocol (`TeamHostCall` `collect_supporter_patch`), Relay `call-for-support.ts`, coordinator tool in `call-for-support-roles.ts`.
- `collect_supporter_patch { teamId; memberId; target; operationId }` (coordinator only, target a `worktree` or `remote` supporter): the Relay asks the target's Host for the patch, grants it to the coordinator and returns the resource; an empty patch returns `{ empty: true }`.
- Tests: patch from uncommitted changes, from commits and new files, empty patch, `git apply --check` at the commit in a fresh worktree; coordinator flow against the support harness.

Milestone 5 exit: workspace tests, agent-host suite.

---

## Milestone 6: Usage and budgets

### Task 6.1: Accounting
- `call-for-support-usage.ts`: `accountUsage(total, usage, turnCompleted)` for `session` and `runtime` cumulative scopes (a runtime decrease starts a new runtime), `turn` (on completion) and `call` scopes, and `totalCostUsd`; totals persist with the seat.
- `team.ts`: while a coordinator's or supporter's runtime is held, its live `usage_updated` and `turn_completed` events are accounted; `report_usage` is sent on turn completion, at most every 10 seconds otherwise, and on each tick when the total grew. A held runtime stays held while its live session works, because reported presence can lag a delivery that just started a turn.
- Tests: each scope, runtime restart, saved totals after a restart; lease retention under lagging presence.

### Task 6.2: Pause and resume end to end
- The Relay refuses claims to a paused group's coordinator and supporters, and reports the open call `needs_input` to the worker (Task 2.7); after `update_mandate` and `resume_group` the next call is delivered.
- Test against the support harness: usage pauses the group, the worker gets the pause report, the queued call waits, and after the raise and resume it reaches the coordinator.

---

## Milestone 7: Website

### Task 7.1: Settings profiles
- `components/call-for-support/ProfilesSettings.tsx`: list, editor (mandate rows from host model catalogs, workspaces, remote hosts and repositories, max supporters, budget, approval, coordinator, enable by default), revision conflicts.
- Unit tests; browser test creating a profile.

### Task 7.2: Call dialog and enablement
- Session actions: **Call for support** dialog (existing role or profile; task, context, deliverable, follow-up) and **Enable for this session** with profile selection; suggestion for sessions with file changes in a git repository.
- Unit tests; browser test calling from a session.

### Task 7.3: Group views
- Team list entries for groups (role, worker, status, usage); roster approval card; calls and reports with findings and resources; budget pause with resume; worker session attributions with open calls.
- Unit tests; browser test approving a roster and seeing a report delivered to the worker against the recorded provider.

---

## Milestone 8: Acceptance and release

### Task 8.1: Native acceptance
- `packages/agent-host/src/call-for-support.local.test.ts`: a Codex worker (search-capable model fixture) enabled for a "Cross review" profile calls; a Claude supporter and a Codex supporter on the shared workspace cannot write; the report reaches the worker; a follow-up reuses both sessions; a `worktree` supporter's patch downloads and applies.

### Task 8.2: Documentation
- `docs/current/agent-remote/call-for-support.md` (current behavior, contracts, limits, verification); updates to `lab.md`, `relay.md`, `protocol.md`, `session-succession-recovery.md` for requester seats; README feature list.

### Task 8.3: Release
- `pnpm verify` on Node 22.23.2, `pnpm test:setup`, native suites; deploy the website (record the rollback version first); bump the Controller version, `pnpm compatibility:update`, commit "chore(controller): prepare X with reviewed compatibility", build the package, `node scripts/controller-release.mjs`, push main and the tag, draft release with assets, verify checksums, publish as Latest. Each outward step needs the user's go-ahead.
