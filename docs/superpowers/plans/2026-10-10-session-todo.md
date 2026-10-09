# Composable Session Todo Implementation Plan

> **For agentic workers:** Execute inline using superpowers:executing-plans. Preserve the existing TPM worktree and uncommitted implementation.

**Goal:** Compose TPM from ordinary sessions, a sequential todo toolkit, explicit user confirmation, and heartbeat scheduling.

**Architecture:** A provider-neutral Host module owns todo transitions and exposes tools through existing session extensions. A public schema and reusable Session View component expose the same durable state; TPM supplies its initial list, main-session dispatch policy, and review prompt. Native runtime facts remain in adapters.

**Tech Stack:** TypeScript, TypeBox, existing session extensions, React, Vitest.

**Spec:** Approved conversation design: optional standard session capabilities; sequential editable list, explicit user consent, all steps complete before delivery completion.

## Constraints

- Only the first unfinished step can progress. Completed steps are immutable.
- Replan at step boundaries. Retain pending confirmation gates. After user approval, replanning inserts a fresh confirmation gate before changed work.
- Models request confirmation; only an authenticated management action records the user's decision, bound to todo revision and request identity.
- Checklist changes do not share the work revision used by heartbeat. Completion needs evidence, not native idle.
- Persist before publication. Never replay unknown native dispatch. Pending main messages are tied to their current todo and checked again before dispatch.
- Ordinary native tools are not sandboxed by a checklist. Do not claim universal enforcement or semantic proof of acceptance.
- No publish, push, deployment, global install, or daemon restart.

## Tasks

- [x] Add public todo schemas and a pure Host transition module. Test ordered progress, completed-prefix immutability, replan approval, stale confirmation, model inability to approve, and empty completion prevention.
- [x] Add a storage-independent tool factory and heartbeat policy helper. Test composition without TPM. Bind them to TPM's durable store and seed a delivery list; keep legacy records readable.
- [x] Gate main-session dispatch and work completion using todo facts. Test admission and pre-dispatch revalidation, restart persistence, and user decisions over the real management transport.
- [x] Export a reusable todo panel and compose it into the ordinary SessionWorkbench. Test consent content, errors, revision binding, and read-only mode; TPM remains the first product consumer.
- [x] Update user/developer docs, run focused bounded suites and typecheck/build, update compatibility metadata, then check compatibility and inspect the final diff.

## Test cases

```ts
expect(() => transition(list, { action: 'complete', stepId: 'later', revision: 1, evidence: ['test'] })).toThrow(/current/i);
expect(() => transition(waiting, { action: 'complete', stepId: 'approval', revision: waiting.revision, evidence: ['model says yes'] })).toThrow(/user/i);
expect(() => confirm(waiting, staleDecision)).toThrow(/changed|stale/i);
expect(replanned.steps.find(step => step.status !== 'completed')?.kind).toBe('confirmation');
```

Use Vitest with `--testTimeout=10000 --hookTimeout=15000 --maxWorkers=1` and a process-group outer deadline. Build changed dependencies before cross-package tests. Refresh protocol compatibility only after implementation review.

## Validation

- Host: 54 focused tests passed, covering ordering, consent, persistence, dispatch fencing, heartbeat and real Host uplink behavior.
- Lab: 29 focused tests passed, including reusable view rendering and real HTTP/WebSocket confirmation forwarding.
- Protocol: 3 tests passed; Cloudflare: 2; ARDB management: 3.
- Recursive build and typecheck passed. Compatibility digest refreshed and verified.
- Browser checks passed at 320, 390 and 1440 px, in inline and floating-toolbar heading modes. Opening the list preserves composer geometry; panel bounds stay inside the view; Escape closes it. The existing toolbar hit area produces the same standalone 4 px overflow with and without the list.
- No native provider end-to-end rerun in this increment. No commit, push, deployment, package publication or Controller update.
