# Copilot Provider Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Connect Copilot CLI through the official Node SDK in an isolated worktree, retaining the unmerged controller launcher.

**Architecture:** A new native adapter implements the existing Provider SDK, with a parent-owned child view and native event projection. Host discovery and launcher registration follow Claude's structure; public Remote schemas stay provider-neutral.

**Tech Stack:** TypeScript, @github/copilot-sdk 1.0.11, pnpm, Vitest, Node test runner.

**Spec:** User request in this session: new worktree, inherit pending changes, integrate Copilot CLI through Copilot SDK using Claude's approach. This document records its implementation scope.

## Global Constraints

- Work only in `.worktrees/copilot-provider`, based on 697e567; preserve existing services.
- Use public SDK APIs; label experimental RPC capabilities explicitly.
- No Borgee runtime/source dependency and no credential commits.
- Reuse existing protocol; advertise only implemented capabilities.
- Test with per-test and outer deadlines; synchronize compatibility metadata.
- No merge, push, package publication or repository creation.

### Task 1: Native provider

**Files:** Create `packages/agent-provider-copilot/{package.json,tsconfig.json,src/*}`.
**Interfaces:** Export `CopilotAgentProvider`, `CopilotSessionSummary`, `CopilotAgentProviderOptions`. Provider accepts `{ executable?, env?, requestTimeoutMs?, onDiagnostic? }`; implements createSession/resumeSession/listSessions/openChildSession and optional dispose. Summary shape matches Claude: nativeSessionId/providerId/title/workspace?/createdAt/updatedAt/state.

- [x] Add behavior tests for native event projection, lifecycle, history/live boundary, callback approvals/questions, settings/skills, child views and repeated child input.
- [x] Implement SDK client lifecycle with create/resume and native history, send/cancel, errors, persistence and resources. Keep background tasks alive after assistant.idle.
- [x] Implement native skills commands, model settings and child eventLog history using public SDK calls. Do not advertise unimplemented controls.
- [x] Run bounded provider tests/typecheck, self-review, and report exact coverage and native limitations.

### Task 2: Host and controller launcher

**Files:** Create `packages/agent-host/src/copilot{,-directory}.ts`; modify host registrations, package dependencies/exports/tests, CLI help, `scripts/start.mjs`, `scripts/lib/controller-options.mjs`, launcher fixture/tests and runbook.
**Interfaces:** Consume Task 1 exports; register `copilot` with executable/environment options; launcher opt-in Copilot while preserving existing default codex/claude/dsh configuration.

- [x] Add registration/directory tests for selecting Copilot, creation, resume and close.
- [x] Implement native registration with executable preflight; directory owns loaded sessions and closes provider clients.
- [x] Add explicit Copilot launcher config/CLI flags and dynamic readiness checks, with fixture tests.
- [x] Run bounded host/setup tests and report results.

### Task 3: Integration validation and support documentation

**Files:** Update support/onboarding docs and compatibility metadata; add native CLI test/fixture under the Copilot package if needed.
**Interfaces:** Consume provider and Host registration from Tasks 1 and 2.

- [x] Install declared dependencies normally; locate and verify Copilot CLI.
- [x] Validate real SDK-to-CLI transport, create/resume/history and deterministic local model requests where available.
- [x] Document implemented support, experimental APIs and unverified limits without implying type declarations prove runtime support.
- [x] Run provider build/typecheck, relevant bounded suites and compatibility update/check.
- [ ] Controller: whole-repository build/tests, browser acceptance and whole-branch review.
