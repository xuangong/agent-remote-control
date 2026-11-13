# UI modernization phase 3a: roster and responsive layout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Continue the approved modernization with a readable, usable Bot roster on desktop and phones, while clearing confirmed Window UI defects.

**Architecture:** Reuse the shared UI primitives and existing group operations. Keep display state in browser-scoped hooks and native session interpretation in existing adapters. Change the roster without remounting conversation surfaces.

**Tech Stack:** React 18, TypeScript, semantic CSS tokens, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-ui-modernization-design.md`; follow-up scope and open items: `docs/handoffs/2026-11-12-ui-modernization-next-steps.md`.

## Global Constraints

- Preserve the existing Session View. No message/tool/approval/composer/internal-layout redesign; only targeted small fixes for confirmed problems.
- Desktop and phone equally; light and dark following the system.
- No UI library. Preserve existing accessible control names and session ownership.
- Native directory timestamps are metadata, never activity or new-result evidence.
- Use Node `/Users/zhangxian/.nvm/versions/node/v24.22.1/bin` for tests; all tests have per-test and outer deadlines.
- Work only in `.worktrees/ui-modern-3a`; preserve other local services.
- Inspect actual local screenshots at 1440x900 and 390x844, plus narrow 320px and intermediate widths for overflow. Fix observed crowding, overlap and unreachable controls in touched flows.
- Rebuild using `pnpm local up` after changes; no new native protocol or backend fields.
- Do not push or deploy this milestone until its concrete result has been reviewed with the user.

## Task 1: Clear confirmed Window UI defects

**Files:**
- Modify: `packages/agent-remote-lab/src/components/WindowWorkspaces.tsx`, its tests.
- Modify: `packages/agent-remote-lab/src/components/SessionWorkbench.attributions.test.tsx`.
- Create a focused confirmation component under `src/components/` only if sharing it with the existing toolbar avoids meaningful duplication.

**Interfaces:** Consume existing `useWindowActions.deleteWindow(id): Promise<boolean>` and `Sheet`, `Button`. Preserve existing workspace actions and scope guards. The existing toolbar confirmation must continue to work.

- [ ] Reproduce the baseline failure in `SessionWorkbench.attributions.test.tsx:22`; inspect `SessionHeading`, `SessionHeadingActions` and current responsive layout to decide whether the product or the structural assertion is wrong. Keep assertions that expansion preserves the timeline DOM, draft and title actions.
- [ ] Add observable deletion tests before implementation: invoking `Delete Window: <title>` opens `Delete this Window?`, cancellation/Escape does not remove a Window, confirming removes exactly the requested Window, pending confirmation cannot double-submit, and an error remains visible/retryable. Scope or active-panel changes close stale confirmation.

```tsx
await act(async () => deleteButton.click());
expect(workspace.remove).not.toHaveBeenCalled();
const dialog = container.querySelector('dialog');
expect(dialog?.textContent).toContain('Delete this Window?');
```

- [ ] Run the focused tests red with `timeout 90 pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/components/WindowWorkspaces.test.tsx src/components/SessionWorkbench.attributions.test.tsx --testTimeout=10000`.
- [ ] Use a scope-bound pending target instead of calling delete immediately. Disable confirmation while pending, close only on success, surface the existing action error inside the sheet if shared toast alone would be obscured. Keep the existing active-Window deletion restrictions. Explain that removing layout leaves agent sessions running.
- [ ] Run the focused tests green, inspect the diff and commit only Task 1 files. Record red/green commands and results in the task report.

## Roster continuation gate

The user requested advance review of functional-layout changes after Task 1 started. Roster implementation is on hold for review of `docs/superpowers/specs/2026-11-13-bot-roster-layout-review.md`. This executable plan currently contains Task 1 only. A complete roster plan will follow the layout decision. Research and the proposal are review artifacts, not implemented product behavior.
