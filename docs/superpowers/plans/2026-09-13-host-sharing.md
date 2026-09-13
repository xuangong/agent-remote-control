# Host Sharing Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review the independent Gateway and Controller tasks.

**Goal:** Share Hosts with Gateway users and enforce cumulative per-user session creation limits.
**Architecture:** Gateway authenticates people; durable Relay brokers enforce grants, session creators and quota before using the shared Host uplink.
**Tech Stack:** TypeScript, Node, React, Bun/Hono, Vitest, real HTTP/WebSocket.
**Spec:** docs/superpowers/specs/2026-09-13-host-sharing-design.md

## Global constraints
English code/docs; Chinese user communication. Work only in existing feature worktrees. No real CLI inference, merge, push or deployment. Every test has per-test and process deadlines. Preserve current protocol and run compatibility update/check.

## Task 1: Relay grants and quotas
Files: server/host-sharing.ts (new), server/gateway-control.ts (new), server/remote-host-broker.ts, server/gateway-relay.ts and transport tests under packages/agent-remote-lab/src.
- [x] Write real transport tests: Bob cannot see Alice Host; owner service share with limit 1 makes Host visible; concurrent distinct creates permit only one; retry returns same binding; peer attach/snapshot/events fail; revoke closes Bob stream without owner/Host disconnect.
- [x] Implement durable grants and ledger. Reserve before async dispatch; native request IDs are namespaced by principal. Handle replay/restart and unknown outcomes without double creation.
- [x] Route shared Host requests under caller namespace; session catalog filtered by recorded ownership; child attachment validates native parent relationship.
- [x] Verify persistence, quota adjustment, service proof auth and revocation races.

## Task 2: Gateway APIs and dashboard
Files: vnext/packages/gateway/src/control-plane/agent-remote/control.ts and routes.ts; vnext/apps/dashboard/src Agent Remote page/components and tests.
- [x] Authenticate actual ses_ user, resolve recipient email using raw repo; sign POST /gateway/control with contract from spec. Test denied identities and tampered requests.
- [x] Implement Host directory, owner share editor, quota edit/revoke, shared Host quota display and launch deep links. Use existing dashboard UI conventions.
- [x] Verify targeted Bun tests, dashboard behavior and full ci:local.

## Task 3: Controller presentation and deep link
Files: App.tsx, components/HostPairing.tsx, directory-client.ts, related tests.
- [x] Consume access/sessionQuota fields. Show cumulative used/limit, owner/shared and block UI create when exhausted while leaving existing sessions usable.
- [x] Select authorized host from ?host= after remote hosts load; invalid/unavailable target does not select another Host implicitly.
- [x] Test shared Host affordances and quota exhausted rendering; preserve local Controller behavior.

## Task 4: Integration and review
- [x] Preserve selected host through login challenge, signed launch and callback. Test two users and restart with real HTTP/WS plus browser validation.
- [x] Review cross-user routing, creator checks, quota races, no reset on revoke, and unknown outcomes. Fix findings.
- [x] Build/typecheck, run focused regression and Gateway ci:local, update/check compatibility. Document results and limitations; commit coherent changes in both worktrees.

## Verification evidence

- ARC: 93 targeted controller/auth/broker/transport tests pass with per-test and process deadlines; all workspace build and typecheck pass.
- Gateway: final ci:local has 3593 pass, 1 existing skip, 0 fail; includes workspace types, lint, dashboard build and Cloudflare dry-run.
- Chromium: actual Gateway SQLite identity, actual Relay process, scripted Host uplink; sharing, Host deep link, private catalog, cumulative limit, idempotent replay, successful and unresolved creation reservation persistence across restart, revoke/regrant all pass. No CLI agents invoked.
- Review fixes: discard unacknowledged stream buffers synchronously on revoke; distinguish definite pre-dispatch failures from unknown post-native outcomes; inherit child creator from parent regardless of which authorized user attaches first.
- Boundary: provider-native automatic subagents and external CLI activity are not user-created Remote sessions; quota is not an OS isolation mechanism. Unresolved reservations are retained without a manual release UI.
