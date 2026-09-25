# OpenCode Provider Implementation Plan

> Execute the independent package and Host tasks with scoped workers, then review and validate their integration in this worktree.

**Goal:** Make OpenCode a usable shared provider through Controller and ARDB using the existing Session View.

**Architecture:** An independent OpenCode server owns native tasks. A provider adapter consumes the official SDK HTTP/SSE interface and translates to existing normalized observations. Controller directory and ARDB register the adapter without stdio ownership leases.

**Tech Stack:** TypeScript, pnpm, official OpenCode JS SDK, Vitest, Node HTTP fixtures.

**Spec:** `docs/superpowers/specs/2026-09-25-opencode-provider.md`

## Global Constraints

- All edits stay in `.worktrees/opencode-provider`.
- No native task abort on detach, no automatic input replay, no stdio Take control.
- Credentials are local-only. All tests have per-test and outer process deadlines.
- No new public event schema unless an observed native semantic cannot be represented.

## Task 1: Provider and native transport

Files: new `packages/agent-provider-opencode/{package.json,tsconfig.json,src/index.ts,src/provider.ts,src/session.ts,src/transport.ts,src/normalize.ts,src/*.test.ts}`.

Public interface: `OpenCodeAgentProvider(options?: OpenCodeAgentProviderOptions)` implements `AgentProviderAdapter`. Options: `serverUrl?: string`, `username?: string`, `password?: string`, `requestTimeoutMs?: number`, `restrictedNative?: boolean`, `onDiagnostic?: (line: string) => void`. Expose `listSessions(): Promise<OpenCodeSessionSummary[]>`, `getSession(id: string): Promise<OpenCodeSessionSummary | undefined>`, `renameSession(id: string, title: string): Promise<void>`, `close(): Promise<void>`. Summary has `id`, `title`, `cwd`, `updatedAt` (ISO string), optional `createdAt` and `parentId`. Persistence opaque holds cwd and selected model/agent only, never credentials/endpoint authority.

- [x] Write and run failing real-transport tests. Required assertions include `expect(session.capabilities.sessionControl).toBe('shared')`, emitted history boundary and native echo, and `expect(abortRequests).toBe(0)` after dispose.
- [x] Implement SDK-backed requests, event subscription/retry and scoped session recovery. Add timeouts and sanitized errors.
- [x] Translate native events with stable identities and snapshot reconciliation. Test missing events after reconnect, final text duplication, canceled versus failed turns, pending interactions and image send.
- [x] Implement native listing/read/rename, settings and commands where supported. Test same-name rename as a no-op and no automatic POST retry.
- [x] Run `pnpm test:opencode` (root outer deadline and per-test timeouts) and package typecheck.

## Task 2: Controller shared registration and product selection

Files: new `packages/agent-host/src/opencode.ts`, `opencode-directory.ts` and tests; modify Host registrations/config/CLI provider allowlists and package dependency. Product allowlists/icons/display labels are updated only where enumeration requires it.

Consumes Task 1 interface. Configuration uses `AGENT_HOST_OPENCODE_URL`, `AGENT_HOST_OPENCODE_USERNAME`, `AGENT_HOST_OPENCODE_PASSWORD`; registration reports `preservesWorkOnDisconnect: true`.

- [x] Add failing directory/registration tests asserting shared capability, workspace rejection, direct-ID resume, idempotent native rename and absence of takeover leases.
- [x] Implement native directory mapping and normalized initial history/runtime. Reuse Host operation deduplication/title broadcast rather than introducing another broadcast path.
- [x] Register provider selection and local configuration; keep existing providers unchanged and native credentials out of browser-facing values.
- [x] Verify touched Host/product tests with an outer timeout and per-test deadline.

## Task 3: ARDB, packaging and documentation

Files: ARDB provider loader/CLI/options/tests/package.json, Controller build script if required, README and new `docs/opencode.md`.

- [x] Add failing loader/option tests for `--provider opencode`.
- [x] Use `AGENT_HOST_OPENCODE_URL` and local Basic credential variables for ARDB; resume through the existing `--persistence-file` interface.
- [x] Ensure bundled Controller and ARDB resolve the new provider and SDK.
- [x] Document independent server startup, CLI attach, credentials, configuration, native login and supported capabilities. No hosted service or implicit credentials.

## Task 4: Review and acceptance

- [x] Run baseline/focused regressions, all affected typechecks and builds sequentially before browser/package smoke.
- [x] Run an isolated native `opencode serve` smoke on a free port using temporary data/config; read version, create/list/read/rename/resume and verify detach does not delete the session. Use an isolated deterministic model HTTP fixture for native execution; commercial model credentials and responses remain outside this smoke test.
- [x] Review behavior against the spec and fix findings. Run `pnpm compatibility:update`, then `pnpm compatibility:check` and `git diff --check`.
- [x] Report exact verified results and any native-model validation limits. Leave work ready for the user's merge/deploy request.

## Acceptance evidence

- Provider: 26 real HTTP/SSE and Relay regression tests, including shared control, cursor pagination, cross-project catalog paging, reconnect reconciliation, interaction receipts and detach without abort.
- Focused Controller: 118 tests; ARDB: 102 tests; product compatibility/Favorites: 61 tests; Provider SDK baseline: 41 tests.
- All 18 workspace package typechecks passed. Provider, Controller and ARDB builds passed.
- Real OpenCode 1.18.18 with an isolated deterministic model transport passed native execution, native rename, history pagination, cross-project discovery, resume and two-client ARDB shared control.
- Controller tarball is built and its independent-install smoke passes without replacing the user's installed Controller.
- Compatibility metadata includes the provider, pinned SDK/native versions and explicit capability degradations.
- No commercial model request, Windows native runtime, production deployment or user-service upgrade was performed.

## Review corrections

Native snapshot/delta overlap and interaction receipts are reconciled without duplication. Native user compaction markers and restored model/agent choices are preserved. Removed models do not block history access. Message pagination uses opaque native response cursors; the global catalog uses its separate numeric cursor and covers all projects. Token usage is a latest-step snapshot rather than a partial-window session total.
