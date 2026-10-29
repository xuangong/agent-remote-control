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
| `packages/agent-remote-protocol/src/remote-host-uplink.ts` | 2 | `callForSupport` capability, provider `readOnly` flag |
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

- [ ] **Step 1: Write the failing test** (append to `session-tools.test.ts`)

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

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/agent-provider-sdk && npx vitest run src/session-tools.test.ts`
Expected: FAIL, `bindAgentSessionToolNamespaces` is not exported.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/session-tools.test.ts && cd ../.. && pnpm --filter @orchardworks/agent-provider-sdk build && pnpm --filter @orchardworks/agent-provider-sdk typecheck`
Expected: PASS; build and typecheck clean.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing unit test** with the scripted app-server used by existing tests (`src/test-utils/scripted-app-server.ts`; read its exports first and follow `session.test.ts` usage):

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

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/agent-provider-codex && npx vitest run src/session-access.test.ts`
Expected: FAIL (`sessionAccess` undefined; `thread/start` lacks `sandbox`).

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run src/session-access.test.ts && npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 5: Write the native test** `read-only.local.test.ts`, converted from the experiment `/tmp/codex-ro-experiment.mjs` `readonly` mode: a scripted Responses server issues `exec_command` writes (`echo shell > shell.txt`, `git commit --allow-empty`) and reads (`git show HEAD:existing.txt`) through `CodexAppServerProvider.createSession({ access: 'read_only' })`; assert `shell.txt` absent, commit count unchanged, the read output contains `original`, and no approval interactions were requested.

- [ ] **Step 6: Run it**

Run: `BORGEE_CODEX_TEST_EXECUTABLE=<pinned codex> npx vitest run src/read-only.local.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Write the failing unit test**

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

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tool-namespaces.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run src/tool-namespaces.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Write the native test**, converted from the experiment's `search` mode: model `gpt-5.5` in the fixture config (a catalog model with the search tool), a deferred `agent_remote.call_for_support`; the scripted model emits `tool_search_call` then a namespaced `function_call`; assert the first request's tools omit `call_for_support`, the search output contains it, the executor ran with `{ role: 'code reviewer' }`, and the function output reached the model. A second case with model `mock-model` and `deferred: false` asserts the tool is in the first request's tools.

- [ ] **Step 6: Run it on the pinned version**

Run: `BORGEE_CODEX_TEST_EXECUTABLE=<codex 0.162.0> npx vitest run src/tool-namespaces.local.test.ts`
Expected: PASS. If 0.162.0 rejects namespaces or `deferLoading`, install the first version that passes, update the pin in `packages/agent-remote-lab/src/server/compatibility.ts` and its manifest consumers in the same commit, and record the reason in the compatibility manifest.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Write the failing unit tests**

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

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/agent-provider-claude && npx vitest run src/permission-modes.test.ts src/session-access.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Convert the experiment into the native test** `read-only.local.test.ts` through `ClaudeAgentSession.open({ …, access: 'read_only' }, fixture.options)`: the scripted model attempts Read, Edit, Write, `echo > shell.txt`, `git commit --allow-empty`, `git show HEAD:existing.txt`, `cat`, and a write to `$TMPDIR`; assert the workspace is unchanged, the git read and `cat` succeed, the scratch write succeeds, and no `interaction_requested` event occurred. Delete `zz-read-only-experiment.local.test.ts`.

- [ ] **Step 6: Run it**

Run: `AGENT_CLAUDE_TEST_EXECUTABLE=$HOME/.nvm/versions/node/v22.23.2/bin/claude npx vitest run src/read-only.local.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Write the failing unit test**

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

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/session-namespaces.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `session-tools.ts`: `createClaudeSessionTools(definitions, assertAvailable, name = 'agent_host')` names its server.
- `session.ts`: `private namespaceServers = new Map<string, ReturnType<typeof createClaudeSessionTools>>()`; at open, build one server per `config.toolNamespaces` entry (deferral is ignored: Claude has no deferred MCP tools); query options `mcpServers: { ...(hostTools ? { agent_host: hostTools } : {}), ...Object.fromEntries(namespaceServers) }`.
- `updateToolNamespaces(namespaces)`: bind with `bindAgentSessionToolNamespaces`, build servers, call `this.native.setMcpServers({ agent_host?, ...new })`, check `errors` is empty (throw the first error otherwise), close servers that were removed, then replace the map. Serialize with the existing settings change guard so it cannot race a turn start.
- `dispose`: close every namespace server.

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Convert the experiment into the native test** `tool-namespaces.local.test.ts` through `ClaudeAgentSession`: open without namespaces, send a first turn, call `updateToolNamespaces` with `agent_remote.call_for_support`, send a second turn scripted to call `mcp__agent_remote__call_for_support`; assert the second request's tools include it, the executor ran, and the turn result contains the tool output. Then remove the namespace and assert the next request no longer lists it. Delete `zz-dynamic-mcp-experiment.local.test.ts`.

- [ ] **Step 6: Run it**

Run: `AGENT_CLAUDE_TEST_EXECUTABLE=$HOME/.nvm/versions/node/v22.23.2/bin/claude npx vitest run src/tool-namespaces.local.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Write the failing test**: create a Team seat whose member has `model: 'm'`, `reasoningEffort: 'high'`, `access: 'read_only'` through `TeamRuntime.create` with a fake `TeamRuntimeAccess`; assert `access.create` received `{ providerId, cwd, model: 'm', reasoningEffort: 'high', extensions: { …, access: 'read_only' } }`; and a Host-level test that `automationAccess.create` forwards `model`, `reasoningEffort` and `access` to `directory.create`, and rejects `access: 'read_only'` for a registration whose adapter lacks `descriptor.sessionAccess.readOnly`.

Until milestone 2 adds the fields to `TeamMember`, the test builds the seat with a local type that extends `TeamSeat`; milestone 2 replaces it with the protocol type.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd packages/agent-host && npx vitest run src/team-seat-configuration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface TeamSeatCreation { cwd?: string; model?: string; reasoningEffort?: string }
export interface TeamRuntimeAccess {
  …
  create(provider: string, creation: TeamSeatCreation, extensions: AgentSessionExtensions): Promise<string>;
}
```

`host.ts` `automationAccess.create(providerId, creation, extensions)`: reject `extensions.access === 'read_only'` unless `registration(providerId).adapter.descriptor.sessionAccess?.readOnly`; then `directory.create({ ...creation, ...extensions }, evidence)`. Update the TPM caller of `create` (`packages/agent-host/src/tpm.ts`) to pass `{ cwd }`.

Expose `readOnlyProviders(): string[]` from the Host (registrations whose descriptor declares `sessionAccess.readOnly` and are enabled) for milestone 3's provider snapshot.

- [ ] **Step 4: Run the agent-host suite**

Run: `npx vitest run src/team-seat-configuration.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm compatibility:update && pnpm compatibility:check
git add packages/agent-host packages/agent-remote-lab/compatibility.json
git commit -m "feat(controller): create Team seats with a model, effort and access"
```

### Milestone 1 exit

- [ ] `pnpm -r run build && pnpm typecheck` clean; unit suites of the SDK, Codex, Claude and agent-host pass; the four native tests pass.
- [ ] Remove `/tmp` experiment leftovers from the worktree if any remain (`git status` clean apart from committed work).

---

## Milestone 2: Protocol and Relay groups

Outcome: the Relay stores profiles and enablement, creates and reuses groups, validates and provisions rosters in both approval modes, records calls, reports, ledgers, releases and usage, and hides groups from incapable Controllers.

### Task 2.1: Call For Support schemas
- Create `packages/agent-remote-protocol/src/call-for-support.ts` with TypeBox schemas and `is…` validators for `CallForSupportProfile`, `CallForSupportMandate`, `CallForSupportCall`, `CallForSupportReport`, `CallForSupportRoster`, `CallForSupportGroup` exactly as in the spec, with the stated bounds; export from `index.ts`.
- Tests: valid and boundary values for each; rejection of unknown fields, out-of-range counts, `shared` combined with write access, `remote` without `remoteHosts`.

### Task 2.2: Team additions and invariants
- `team.ts`: member role `requester`, creation `released`, `model`, `reasoningEffort`, `access`, `workspace`, `usage`; message `callForSupportCallId`; `Team.callForSupport`; `TeamCreate.callForSupport`; the new `TeamAction` and `TeamHostCall` members; `isTeam` invariants (one requester exactly when `callForSupport` is set, never at index 0; members' configurations within the mandate; `shared` members read-only and on the source host; message call IDs exist; released members are never message targets).
- Tests: existing Team fixtures still validate; each invariant rejects a crafted violation.

### Task 2.3: Uplink capability and provider flag
- `remote-host-uplink.ts`: `callForSupport: 1` in `registered`, the request parameter like `teamSuccession`; provider entries gain `readOnly?: true`.
- Tests: schema accepts and round-trips both; old messages still validate.

### Task 2.4: Profiles store and session enablement
- Create `packages/agent-remote-hosted/src/call-for-support-profiles.ts` modeled on `favorites.ts`: per subject list ≤ 32, revision-checked commands (`create`, `update`, `delete`), enablement map keyed by session identity following committed succession like favorites (`favorites-succession.ts`), served from `gateway.ts` at `GET/POST /v1/call-for-support/profiles` and `/v1/call-for-support/enablement`.
- Tests (`call-for-support-profiles.test.ts`): CRUD with revisions, conflicts, capacity, enablement following a handoff, per-subject isolation.

### Task 2.5: Group creation, reuse and calls
- Create `packages/agent-remote-hosted/src/call-for-support.ts` (`CallForSupportBroker`, built on `TeamBroker` ports): `createOrReuseGroup(worker, profile, call, fresh)`, `call(teamId, input)`; creation provisions the coordinator (leader) and the requester seat (binding, no native creation) and queues the call message; `fresh` archives the previous group. Requires `callForSupport` on the worker's host.
- Wire into `teams.ts` `create`/`action`/`hostCall` and `broker.ts` routes; requester host calls `call_for_support` and `support_status`.
- Tests: create, reuse by (role anchor, profile), `fresh`, follow-up validation, call ordering (queued behind an open call), incapable host rejection.

### Task 2.6: Rosters, approval modes and provisioning
- `propose_roster` validation per the spec; `every_roster` waits; `within_mandate` provisions valid rosters at once and waits for others with `withinMandate: false`; `resolve_roster`; provisioning releases listed members then calls `createSeat` with configuration, access, workspace and cwd; `release_member`/`release_supporter`.
- Tests: each validation rule; both approval modes; releases before additions; count with releases; `remote` host and repository rules; read-only provider flag required for `shared`.

### Task 2.7: Reports, ledger, usage and pause
- `report_support` (only coordinator → requester, resources accessible to the coordinator, call status update, report stored on the call), `write_ledger` (revision-checked, ≤ 16000), `report_usage` (monotonic per member; updates member, open call, group), budget bounds pause the group and report `needs_input`; `update_mandate`, `resume_group`.
- Tests: report framing data, ledger conflicts, usage aggregation, each budget bound, pause blocks deliveries, resume.

### Task 2.8: Projection, capacity and compatibility
- `poll`/`read` omit support groups for hosts without `callForSupport`; Team count limit 128; budget checks with a full group (64 calls with reports at maximum size, full ledger) stay within 2 MiB and 128 KiB per Team, trimming oldest reported calls' evidence first.
- Tests: projection for capable and incapable hosts; capacity test; existing broker suites unchanged.

Milestone 2 exit: `pnpm --filter @orchardworks/agent-remote-protocol test`, `pnpm --filter @orchardworks/agent-remote-hosted test`, Cloudflare package tests, typecheck.

---

## Milestone 3: Controller groups

Outcome: Controllers negotiate the capability, bind requester seats, give coordinators and supporters their extensions, deliver reports as framed input, and release idle members' runtimes.

### Task 3.1: Negotiation and provider snapshot
- `remote-host-uplink-client.ts`: request `callForSupport` and track the acknowledgement; provider snapshot entries carry `readOnly` from `readOnlyProviders()`.
- Tests: uplink client negotiation with and without acknowledgement; snapshot contents.

### Task 3.2: Requester seats
- `team.ts` `createOnce`: role `requester` binds the source session (verify it exists on this Controller with `access.acquire`, read `cwd`), no `access.create`; restore and succession like members; `extensions()` returns only Call For Support tools for requesters (milestone 4) and nothing else.
- Tests: binding, cwd report, succession following, no Team tools on the requester.

### Task 3.3: Coordinator and supporter extensions
- Create `call-for-support-instructions.ts` (coordinator and supporter texts from the spec) and `call-for-support-tools.ts` (coordinator tools: `propose_roster`, `release_supporter`, `report_support`, `write_ledger`, `collect_supporter_patch` (milestone 5), plus existing Team tools); `team.ts` `tools()` branches on support groups.
- Tests: tool lists per role, argument schemas, host call payloads, instructions contain the encapsulation rules.

### Task 3.4: Report delivery and idle lease release
- Report framing and delivery mode (busy → `next_turn`, idle → `immediate`); the Team tick retains a lease only for members with queued, dispatching or unsettled deliveries, and while archiving needs presence; presence for unleased members is not reported, and archive acquires to confirm idleness.
- Tests: framing text, delivery modes, lease retention and release across ticks, archive completion, resume on the next delivery (fake Host `idle.retain` accounting).

Milestone 3 exit: agent-host suite, Team suites, typecheck.

---

## Milestone 4: Worker tools

Outcome: enabled sessions can call, list, read and download; tools are injected on attach and on enablement changes.

### Task 4.1: Tool definitions
- `call-for-support-tools.ts`: `call_for_support`, `support_status`, `read_support_report`, `download_support_resource` with the spec's schemas; results as compact JSON; `unavailable` when not enabled.
- Tests: schemas, each result shape, disabled behavior.

### Task 4.2: Injection and enablement
- `host.ts`: on attach of any session, compute the `agent_remote` namespace (Claude: only when enabled; Codex: always declared on Controller-created threads, deferred unless enabled at creation) and pass it in extensions; on an enablement change from the Relay (pushed through the uplink as a Team poll field or a new control message), call `updateToolNamespaces` on attached sessions and queue the enablement note to the worker.
- Tests: Claude live add and remove, Codex declaration at creation and executor rebinding, note delivery once per enablement.

### Task 4.3: Requester host calls
- The tools issue `call_for_support`/`support_status` host calls with the worker's seat; `read_support_report` reads from the group; `download_support_resource` uses Team resource download into a verified local path.
- Tests: end-to-end against a fake broker: call accepted, status, report read with and without `findingId`, download verification.

Milestone 4 exit: agent-host suite; native: a Claude session gains the tools on enablement and calls; a Codex session created enabled calls directly, one created disabled finds the tool by search after enablement.

---

## Milestone 5: Workspaces and patches

Outcome: `worktree` and `remote` supporters get their own worktrees at the call's commit, and their patches reach the worker.

### Task 5.1: Worktrees
- `call-for-support-workspaces.ts`: `prepareWorktree(repo, teamId, memberId, commit)` (exclude entry, `git worktree add --detach`), `removeWorktree`, path validation inside the repository and allowed roots.
- Tests against temporary git repositories: creation at the commit, exclude entry written once, removal and prune, missing commit error.

### Task 5.2: Remote bundles
- Requester side: `createBundle(repo, base, commit)` uploaded as a Team resource; remote side: fetch the bundle into the configured repository, then `prepareWorktree`. Seat creation for `remote` waits for the bundle resource.
- Tests: bundle with and without base, fetch into a clone that lacks the commit, failure messages.

### Task 5.3: Patch collection
- `collect_supporter_patch(target)`: the supporter's Controller produces `git diff --binary <commit>` and `git format-patch <commit>..HEAD` into one resource; the coordinator attaches it to a report.
- Tests: patch from uncommitted changes, from commits, empty patch, application with `git apply --check` in a fresh worktree.

Milestone 5 exit: workspace tests, agent-host suite.

---

## Milestone 6: Usage and budgets

### Task 6.1: Accounting
- `call-for-support-usage.ts`: per-session accumulators for `session`, `runtime` and `turn` scopes and `totalCostUsd`; subscribed for coordinator and supporter sessions; cumulative `report_usage` calls throttled to one per member per 10 seconds and on turn completion.
- Tests: each scope, runtime reset handling, throttle, monotonic reports after restart (persisted accumulators).

### Task 6.2: Pause and resume end to end
- Controller stops delivering to a paused group; the coordinator and requester receive the pause note; resume after `update_mandate`.
- Tests with a fake broker.

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
