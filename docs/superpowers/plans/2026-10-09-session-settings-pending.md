# Session setting intent and confirmation

**Goal:** Accept model, reasoning effort and permission intents while work continues, then settle each intent from native confirmation or a bounded failure.

**Design:** The public snapshot owns setting changes independently of native runtime settings. Each change carries a request identity, target, last confirmed value and deadline. The relay acknowledges acceptance immediately, serializes native mutations separately from message submission, and never retries a mutation with an uncertain result. Adapters distinguish not-yet-submitted changes (`deferred`) from native queued changes (`pending`). Native settings remain authoritative. New intents supersede old intents; old completions cannot settle a newer request.

The deadline is 30 seconds from acceptance. At expiry, end Pending immediately and request fresh runtime information; retain the last confirmed value if readback fails. A late native update still updates the actual setting. Failures remain in the snapshot with their identity and a short explanation. Each rendered settings surface tracks which failures it has displayed; opening the relevant panel clears its unread dot. No timeout toast, interrupt, or automatic replay.

**Constraints:** Preserve provider policies and native option semantics, including OpenCode variant and provider defaults. Do not resolve approval requests as a side effect. Keep running services intact. Work only in this worktree; no publication or push.

## Implementation

- [x] Add schema and SDK result semantics; add busy-setting admission test, then remove only the public settings idle gate.
- [x] Add relay intent coordinator tests for immediate acceptance, actual confirmation, timeout, failure, supersession, deferred retry and disposal. Integrate with AgentManager and test over real WebSockets.
- [x] Adapt Codex, Copilot, Claude and OpenCode independently against installed native contracts, with behavior tests.
- [x] Add renderer tests for shared pending state, editable latest targets, stable timeout fallback and per-category read-on-open dots. Use existing controls and semantic colors.
- [x] Update strict protocol version, fixtures and documentation together. Review the diff, rebuild, run affected tests and compatibility update/check.

**Validation:** Run Vitest with explicit test/hook deadlines under an outer subprocess timeout; use repository root commands for full suites. Record native tests separately from simulated native responses. Do not claim live-provider acceptance without a real native run.

## Verification notes

- Public protocol is now 1.7.0. Strict consumers must upgrade together; uplink envelope versions are unchanged. The pinned Codex Lab target and current-version fixtures are 0.162.0; exact version validation and lower-version rejection remain enforced.
- Relay validation includes two actual WebSocket clients, reconnect snapshots, duplicate operation receipts, hanging native calls/readback, and A -> B -> A supersession.
- Desktop and mobile Chromium: six settings scenarios passed. Screenshots verify shared yellow targets, native-value restoration, per-view unread dots, read-on-open behavior, retained explanations, and no mobile horizontal overflow.
- Codex native validation uses an isolated 0.162.0 process and a local HTTP inference fixture. Claude native validation uses the pinned 2.1.247 binary. These tests do not contact a paid model endpoint or change existing daemon configuration.
- Copilot settings tests use SDK doubles; OpenCode settings tests use HTTP/SSE fixtures. This change does not claim new live-binary settings coverage for either provider.
- Node 26 exposes an undefined global `localStorage` that conflicts with the Lab's jsdom setup. Final Lab verification uses the installed Node 22.23.2. The root `pnpm test` entry also supplies a duplicate `--hookTimeout` to a package script; package runs with an outer deadline are used without changing unrelated test infrastructure.
- Readback has a separate five-second deadline. A newer read invalidates an older read before either finishes, and adapter revisions prevent stale results from corrupting their internal confirmed state.
- Codex 0.162.0 verified successive HTTP inference requests in one turn as `A/high -> B/high -> B/low -> A/low`, followed by a future turn using `A/low`. The feature-disabled case defers without enabling global features. Native live publication and future-default confirmation remain separate; partial application reports an explicit failure rather than replaying either mutation.

| Suite | Passed |
| --- | ---: |
| Protocol | 210 |
| Relay | 335 |
| Web | 600 |
| Codex non-local / isolated native | 398 / 4 |
| Claude, including pinned native tests | 119 |
| Copilot | 118 |
| OpenCode | 115 |
| Hosted | 202 |
| DSH | 81 |
| Debugger | 114 |
| Cloudflare | 65 |
| Lab, Node 22.23.2 and Codex 0.162.0 | 951 (6 skipped) |
| Relay conformance | 17 |
| Setup and installation fixtures | 62 |
| Standalone Controller package and isolated installation | 3 |
| Settings browser scenarios, desktop / mobile | 6 |

Final integration build and workspace typecheck passed. The complete Lab run passed after all source and digest updates were frozen; earlier attempts during dist replacement and with a stale digest are retained as failed runs, not counted as acceptance evidence.

Final verification logs: `/tmp/arc-settings-final-0162-build.log`, `/tmp/arc-lab-codex-0162-regression-final.log`, `/tmp/arc-settings-final-0162-setup.log`, and `/tmp/arc-settings-final-0162-package.log`.
