# Codex History Paging and Remote CLI Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks inline.

**Goal:** Open Codex sessions with the newest ten turns, load older turns on demand, and proxy native remote commands through the Controller CLI.

**Architecture:** Native pagination remains in codex-daemon-client and the Codex adapter. An optional Provider history reader feeds the existing Relay Timeline pagination. Historical rows receive decreasing signed sequence numbers without renumbering live rows or changing the live cursor. CLI resolution reuses privately saved Controller environment without requiring or exposing Relay credentials.

**Tech Stack:** TypeScript, Node.js, Vitest, Unix WebSocket RPC.

**Spec:** User-approved conversation: ten turns per native page, latest first, earlier history on demand; `agent-remote-controller codex` resolves executable/home/socket and locale, with explicit daemon lifecycle mappings.

## Global Constraints

- Work only in this dedicated worktree; preserve running services.
- No merge, push, deployment, or production daemon restart in this task.
- Keep live cursor nonnegative; allow signed positions only for historical Timeline cursors/rows and resource binding positions.
- Preserve runtime state, buffered live notifications, historical resources, and recovery generation isolation.
- Tests have per-test and outer deadlines; build dependencies before tests.

## Tasks

- [x] Add transport tests proving ten-turn descending pages, chronological projection, delayed older-page independence, and recovery without full-history reads.
- [x] Add native page helper, metadata-only resume, optional paged snapshots, and Provider normalized history reader. Support older servers only on explicit method-not-found responses.
- [x] Add Relay on-demand history loading, stable prepend positions, concurrent request deduplication and stale-epoch rejection; extend signed historical cursor codecs and test real wire delivery.
- [x] Add CLI process tests for saved configuration, argument preservation, locale, daemon command mapping, custom socket safety, and exit status. Implement the proxy without shell interpolation or implicit lifecycle actions.
- [x] Document commands and paging boundaries. Run relevant tests, typechecks, build, compatibility:update and compatibility:check. Review diff and report verified scope.

## Verification

- Codex adapter: 264 non-local unit tests passed, including paginated opening and real Unix WebSocket restoration. The paging/recovery subset was rerun after adding the waiting-status assertion (25 passed).
- Protocol: 138 passed. Web: 311 passed. Relay: 239 passed, plus the later epoch-isolation regression in a 44-test focused run.
- Native client: 8 passed. Controller CLI/configuration/registration: 33 passed, including inherited soft descriptor limit verification.
- Full workspace build and typecheck passed. Controller archive build and both independent package/CLI smoke tests passed.
- Current native 0.155.1 read-only checks returned ten recent turns and ten disjoint earlier turns for the large comparison session; the small session returned one complete page. This is history-read verification, not production browser or resume-latency acceptance.
- The legacy native integration suite pins 0.148.0 and was not validated with that executable in this run. Legacy fallback is covered by protocol fixtures.
- No production installation, merge, push, or deployment performed.

## Local Resume and File-Limit Recovery Guidance

User-approved extension: expose the native resume command from the web session and recommend explicit daemon restart with its risks for confirmed file exhaustion.

- [x] Add a selectable, copyable native resume command to the existing session-link dialog. Only validated Codex native UUIDs are used; run commands on the Host with its Controller configuration.
- [x] Classify shared-daemon RPC exhaustion in the native adapter, preserve the safe reason through Host and Relay, and display expandable risk information plus a copyable restart command. Do not add remote shell execution or automatically restart a daemon.
- [x] Retain uncertain creation semantics and avoid dispatching duplicate operations even when the underlying cause is known.
- [x] Verify native Unix-socket failures, Host retry behavior, Relay reason redaction/quota retention, copy/failure handling, and desktop/mobile dialog layout.


Extension validation: Codex provider/native failures 19 passed; Host control/operation cache 45 passed; hosted broker 45 passed; web notices/copy/directory client 13 passed. Desktop and mobile Chromium dialog checks both passed, including horizontal overflow and focus restoration. Full workspace build/typecheck and compatibility check passed. Native file exhaustion used a real Unix WebSocket test server; no production daemon was restarted. No iPhone Safari device check or production deployment was performed.
