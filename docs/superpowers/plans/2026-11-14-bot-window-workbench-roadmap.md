# Bot/Window workbench: roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each stage plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the confirmed product model ([Bot and Window](../specs/2026-11-13-bot-window-product-model.md), [IM gateway](../specs/2026-11-13-im-gateway-product-form.md), [walkthrough](../../design-previews/2026-11-13-bot-window-walkthrough.html)) into a stable, measured, cross-Host agent workbench.

**Mandate:** On 2026-11-14 the owner delegated every remaining decision ("按你的顺序，一直到最后不要问我了，全权委托你处理，最后要一个稳定性能有保证的bot/window跨host agent工作台"). The walkthrough's layout proposals count as reviewed. Performance work comes last, after UI/UX and features, except where a feature cannot work without it.

**Architecture:** Groups stay Window documents on the hosted Relay. Bot membership is derived from views; per-mode visibility lives in the group's `presentation`; fold and sleep are shared group state. The IM layer (read positions, presence, previews, outbox, drafts) moves from browsers to the Relay in later stages, always derived from the agent sessions and never a second copy of a conversation.

**Tech stack:** TypeScript, TypeBox schemas in `agent-remote-protocol`, the hosted Relay (`agent-remote-hosted`, Cloudflare Durable Object via `agent-remote-cloudflare`), the Controller (`agent-host`), React Lab (`agent-remote-lab`), Vitest, Playwright, `pnpm local` for closed-loop checks.

---

## Stages

Each stage ships on its own: tests first, `pnpm verify:changed` (full `pnpm verify` when a Controller release is part of it), a local-instance check on desktop and phone, merge to `main`, push, Worker deploy (and a Controller release when Controller code or its CLI's reading of groups changes). Window mode keeps working at every stage.

| # | Stage | Ships | Plan |
|---|---|---|---|
| 1 | Bot membership and automatic groups | Side, Team, TPM and Support sessions are first-level bots with role tags; Asks nest under their bot; every group appears in Bot mode unless hidden there; per-mode hiding replaces Show as section; opening a session over a bot opens it beside; Bot mode leases only the selected group | [stage 1](2026-11-14-stage-1-bot-membership.md) |
| 2 | Working from a bot | Reading across a handoff in Bot mode (decision 6 of the IM gateway): after a handoff the conversation continues into the previous sessions' content, read-only, behind a quiet divider — a real handoff on 2026-11-14 left the bot's conversation empty; a bot's ⋯ menu: new Side, TPM, Team, call for support, hide in one mode, remove from group; new sessions join the bot's group; a new session in Bot mode starts a group named after it; closing a bot's pane folds it | written when stage 1 ships |
| 3 | Fold, sleep and the live budget | Folded slim strips with shared-channel status; sleep stored with the group, quiet, dimmed, woken by opening; low-key reminder for a sleeping bot that needs you; per-device live subscription budget; Disconnect retired | written when stage 2 ships |
| 4 | IM layer, part 1 | Shared read positions and the unread dot (no counts); typing presence in Bot mode; latest-reply previews and times in rows (decision C); phone list → chat with "‹ Bots" | written when stage 3 ships |
| 5 | IM layer, part 2 | Shared drafts; the outbox for offline Hosts, visible and cancellable on every device | written when stage 4 ships |
| 6 | Performance | Measured client and server budgets: switch timing, live budget size, render cost of large groups, Relay commit and fan-out cost, bundle size; regressions guarded by tests | written when stage 5 ships |
| 7 | Stability | Cross-Host end-to-end coverage (two Hosts, offline Host, handoff across providers), flake removal, soak on the local instance, release notes and docs | written when stage 6 ships |

Later, outside this roadmap unless time allows: notifications without an open page (IM stage 3), group chats for Teams and stored history (IM stage 4).

## UI bar

On 2026-11-14 the owner added: the implementation should feel like a native app and be refined ("要更接近native app的感觉，精致一定"). Every stage is checked on desktop and phone in light and dark against native conventions: filled selections without outlines, label colors, press and hover feedback with short transitions (none with reduced motion), 44-pixel touch targets, roomier phone rows.

## Decisions taken under the mandate

These fill gaps the specs left open. Each is recorded where it is implemented as well.

1. **Hidden in Bot mode is `presentation.bots: false`.** Bot mode shows every group that is not hidden there and has at least one bot. `bots` keeps its role as the container of rank and per-bot details; it no longer decides whether a group appears. A group stays visible in at least one mode.
2. **One bot per session, enforced where it is visible.** The Relay rule keeps applying to groups that carry `bots` details, as today. The roster shows a session once, in the first group (by order) that holds it, so older data where a session sits in two Windows, or both halves of a separated group, never shows twice. Window mode keeps allowing a session in several Windows.
3. **Managed views are bots.** Team, TPM and Support views are bots although their feature rebinds them; the `bot_view` rule exempts managed views, whose identity is their feature member rather than the native session.
4. **Roles.** `Side` for an attached view; `Team Leader` / `Team member` from the team feature; `Support` for a team that has a call-for-support roster; `TPM` from the TPM feature. A custom label shows beside the role, never instead of it.
5. **Group order.** Groups with a rank sort by rank; groups without one follow in catalog order, so places stay stable.
6. **Leases.** Bot mode keeps a live group lease only for the selected group; every other group is read from the catalog. Enrolling bot views for handoff tracking uses catalog data.
7. **Rollback.** Once a group is hidden in Bot mode, Worker versions before stage 1 cannot read the Relay state; fix forward.
8. **Rule 6 in Window panes comes whole, in stage 2.** Stage 1 opens another session beside a bot only in groups whose bots carry details, as before; other Window panes still take another session in place. Applying "open beside" to every pane alone would pile up panes and break in-place navigation (handoff history, Track restore) that 19 Window tests describe. Stage 2 gives panes the whole rule at once: open beside, closing a bot's pane folds it, removing is explicit, and navigation within a bot's own chain (history, return to current) stays in place.
