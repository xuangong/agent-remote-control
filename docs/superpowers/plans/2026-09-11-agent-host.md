# Agent Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run CLI Providers in an independently paired Agent Host and preserve existing remote controls.

**Architecture:** Reuse the uplink RPC and session stream rails. Host owns Provider adapters, directory state, and the normalized relay; backend owns pairing and routing. Existing DSH registration remains a supported legacy shape.

**Tech Stack:** TypeScript, Node >=22, pnpm 10.34.5, TypeBox, ws, Vitest, React.

**Spec:** docs/superpowers/specs/2026-09-11-agent-host.md

## Global Constraints

- Work only in /Users/zhangxian/workspace/agent-remote-control/.worktrees/agent-host; preserve Borgee and running services.
- Public session protocol stays 1.4.0. Uplink stays version 2 with additive registration and directory support.
- Registration accepts exactly either legacy `{ providerId: 'dsh' }` or `{ providers: [{ providerId, displayName }] }`, a nonempty bounded unique list. Never both.
- Host catalog shape is `{ hosts: [{ id, name, online, providers: [{ providerId, displayName }], providerId? }] }`; providerId may be returned for a single provider to retain old callers.
- New Host RPC create body is `{ providerId, requestId, cwd?, workspaceId?, model?, reasoningEffort?, planning? }`. Attach body is `{ providerId, nativeSessionId, parentNativeSessionId? }`. Broker assigns a proposed relay agent ID through envelope sessionId; Host may return its existing `{ agentId, nativeSessionId }` on deduplication. Broker must check binding conflicts and actual native identity.
- New Host reads preserve providerId query; native child attachment uses `/remote/child/attach`. Legacy DSH retains its exact existing request shape, rejects unsupported configuration explicitly, and does not pretend to support children.
- In the Host, directory mutations persist independently of uplink lifetime. One native session has one relay projection. Unknown create outcomes remain reserved, never retried automatically.
- Codex minimum is 0.148.0. Preserve configurable executable, CODEX_HOME, workspace, and inherited environment.
- Use per-test and outer deadlines. Dependencies install via https://mirrors.cloud.tencent.com/npm/ without global changes.
- pnpm is available by prepending `/Users/zhangxian/workspace/agent-remote-control/.worktrees/chat-session-controls/.runtime/manual-dsh/tools/10.34.5/node_modules/.bin:/Users/zhangxian/.nvm/versions/node/v22.23.2/bin` to PATH. Avoid the system Corepack stub.
- Pin real Codex tests with BORGEE_CODEX_TEST_EXECUTABLE=/Users/zhangxian/workspace/agent-remote-control/.worktrees/chat-session-controls/.runtime/codex/node_modules/.bin/codex.
- No pushes, publishing, service restarts, or edits outside the worktree. Commit only your task files. Do not spawn nested agents.

### Task 1: Provider-aware Host uplink and broker

**Files:** packages/agent-remote-protocol/src/remote-host-uplink.ts and codec tests; packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts and transport tests; packages/agent-remote-lab/src/server/remote-host-broker.ts and tests.

**Interfaces:** Consume existing RPC and stream envelope. Produce registration and broker HTTP/RPC contracts in Global Constraints. `RemoteHostUplinkClientOptions.providers?: readonly { providerId: string; displayName: string }[]` selects new registration; omitted retains legacy DSH.

- [ ] Add failing codec/real WebSocket tests for a two-provider registration, duplicate provider rejection, scoped catalog/workspaces/models forwarding, native-assigned creation identity, settings fingerprint conflicts, child attach/recovery, and legacy DSH behavior. Example expected registration:
```ts
{ uplinkVersion: 2, type: 'register', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'example', displayName: 'Example' }] }
```
- [ ] Run focused Vitest with `--testTimeout=10000 --hookTimeout=30000` under an outer 120 second subprocess timeout and capture the expected missing-capability failures.
- [ ] Extend registration schema, validate unique descriptors, expose `providers` option, and reject terminal registration failures through ready rather than hanging. Extend read paths for models and scoped child mutation.
- [ ] Refactor broker routing to preserve provider selection/configuration for new Hosts. Key attachment/creation ledgers by host and provider, retain parent identity for recovery, consume Host-returned IDs, validate mismatches/collisions/generation changes, and never repeat uncertain creations. Keep DSH wire compatibility localized to legacy registration.
- [ ] Rebuild dependency closure, run focused tests/typecheck, then commit task files. Do not update compatibility metadata yet; final integration owns it.

### Task 2: Independent Host runtime and daemon

**Files:** New packages/agent-host/{package.json,tsconfig.json,src/index.ts,src/host.ts,src/directory.ts,src/codex.ts,src/cli.ts} and focused tests; shared catalog relocation to packages/agent-remote-relay/src/remote-host-catalog.ts with DSH re-export; root package.json and pnpm-lock.yaml; scripts/agent-host.mjs if useful.

**Interfaces:** Consume Task 1 uplink. Export `createAgentHost(options)` with provider registrations and uplink config, `ready`, and idempotent `close`. Each registration pairs an AgentProviderAdapter with a directory source exposing list/workspaces/create/open/optional openChild/close; Codex factory owns its executable validation and directory. Exact exported type names are local choices documented in the report for Task 3. Host exports must not import Lab or DSH runtime.

- [ ] Add failing behavior tests for create returning native ID, provider isolation, duplicate creation/request conflicts, single projection on repeated attach, preserving sessions on uplink reconnect, rejecting mismatched child ownership, and disposing on explicit Host shutdown only. Use real relay/uplink transports and provider test fixtures for deterministic lifecycle assertions.
- [ ] Run focused tests under outer 120 second deadline and capture failures.
- [ ] Extract generic catalog unchanged into Relay and retain DSH re-export; move production Codex directory/version/spawn management into Host. Preserve child connection borrowing and held new sessions. Avoid multiple observe loops for one native session.
- [ ] Implement provider-scoped directory control using the existing relay create/requireAgent and native provider methods. Directory owns request deduplication independent of transport. For repeated attach return existing relay agentId; allow the broker to reuse it. Handle shutdown during pending operations by draining/disposing, without leaked sessions or retrying uncertain requests.
- [ ] Implement a foreground CLI plus start/status/stop daemon workflow. Pair with provided key/server, keep installation ID stable in private scoped state, avoid exposing keys in logs/process arguments, use bounded launch and shutdown, protect against stale PID reuse, and provide startup failure guidance. Do not start an actual user daemon as a side effect of tests.
- [ ] Install workspace changes with Tencent registry, build and test package, verify `--help`, and commit task files. Report runtime API and CLI commands to the controller.

### Task 3: Workbench integration and end-to-end validation

**Files:** packages/agent-remote-lab/src/server/local.ts, src/server/codex-directory.ts and tests, src/directory-client.ts, src/components/HostPairing.tsx, src/App.tsx and focused tests, e2e Host/Codex fixtures, scripts/dev.mjs, docs/current/agent-remote/{README,lab,providers,protocol,relay}.md, docs/runbooks/codex-debug.md, README.md, compatibility metadata as generated.

**Interfaces:** Consume Task 1 Host descriptors/routing and Task 2 runtime/CLI. Backend `createLocalServer` owns Recorded only. Production CLI spawning occurs exclusively through Agent Host. Clearly isolated native test fixtures may instantiate Providers for adapter/conformance tests but are not the production launcher.

- [ ] Add failing UI tests for a Host advertising two providers, Codex creation through selected Host with options preserved, offline availability, and generic pairing guidance. Retain DSH regression coverage. Add transport integration for real Codex hosted outside backend, send/tool results/status/control, child route, and reconnect preserving runtime identity.
- [ ] Run focused tests with per-test and outer deadlines; capture expected failures.
- [ ] Remove production Codex instantiation/directory from Lab local server. Reuse Host-owned Codex directory for test-only compatibility where needed rather than duplicate implementation. Make dev commands expose clear independent Host startup; no silent same-process fallback.
- [ ] Render each advertised provider under its actual Host. Keep Recorded as a labeled local fixture source. Remove synthetic production Local runtime claims. Preserve existing Host-specific opened/fork/side routing and settings inheritance for Codex on a remote Host. Display generic pairing instructions with DSH and CLI Host guidance, without redesigning the chat UI.
- [ ] Use an isolated test backend/frontend and real pinned Codex with deterministic responses to validate discovery/create/send/tool-result/interrupt and reconnect. Verify browser behavior where available. Do not claim a live endpoint or native DSH run unless actually performed.
- [ ] Run root tests/build/typecheck as appropriate with outer deadlines, then `pnpm compatibility:update` and `pnpm compatibility:check`, plus docs validation. Update runtime docs/runbook with actual commands and limitations including temporary key lifetime and backend restart re-pairing.
- [ ] Commit integrated changes. Provide full test evidence, remaining limitations, and startup commands in report. Preserve all existing worktrees and services.
