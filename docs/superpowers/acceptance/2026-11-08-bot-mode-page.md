# Bot mode page acceptance

This document records Task 4's implementation and controlled browser evidence on
the `bot-mode-ui` worktree. Final integration review, compatibility, repository
checks and the real local instance belong to the parent acceptance pass; those
layers remain unverified until their evidence is appended below.

## Revision and evidence boundary

- Worktree: `/Volumes/Projects/agent-remote-control/.worktrees/bot-mode-ui`.
- Reviewed Task 3 baseline: `66f704326512a17037b551f36e8c929eeb1d48c4`.
- Latest Task 4 static Lab build: `App-DAosOQAX.js`, `App-CM4f-pJK.css`;
  Vite built 1,129 modules in 2.85 seconds. The existing large-chunk warning remains.
- Node: `v24.22.1`, with `NODE_OPTIONS=--no-experimental-webstorage` and the
  machine's existing Corepack cache. No native profile or credential was changed.

The browser tests use fresh, headless Playwright contexts and loopback fixture
servers. The recorded provider's Relay, gateway and Host uplink are real
transports; its native execution is deterministic fixture behavior.
The joined Handoff fixture uses real verified succession receipts and transport
with fake native evidence and execution. Neither fixture proves a real provider
turn, native Handoff, a physical mobile device or the complete `pnpm local up`
instance.

## Changes exercised

Bot attention observes only ordinary, visible roster members. Hidden members,
deleted members, fallback sessions, Track and Ask are excluded in Bot mode.
Window mode keeps its tracked/open/Ask scope. Reading acknowledges only the
actually visible attached conversation, including the compact roster visibility
rule. Eligible identities and admission tokens fence asynchronous notification
fingerprinting, delivery and clicks; leaving scope closes stale notices and
removes their observation baseline. The saved Track list is retained.

Bot notification clicks resolve the current roster's group/view identity without
changing the remembered Window. Roster status observation runs while Bot mode is
visible, independently of the Window overview. The retained Bot presentation now
rechecks `isBotView` after access recovery (Task 3 review note N1).

Controlled browser acceptance exposed three actual presentation defects:

1. An in-progress Bot Handoff was rendered inside its original hidden host after
   selecting another Bot or switching to Window. The same operation's existing
   progress section now uses a body portal for Bot/fallback origins. Window
   origins retain their existing inline presentation. There is one chooser,
   progress section and operation. The panel is bounded to the viewport and
   remains scrollable on compact screens.
2. A shared ordinary Window conversation moved to a portal but lost the original
   pane's React capture selection path. Its fixed host now invokes the captured
   Window pane selection callback on native pointer/focus capture, only while
   shown, in Window mode and with ready access. Ignored controls keep the prior
   predicate; Bot, parked and access-paused interactions do not select a Window
   pane. Attached and other nonportal Family paths keep their original handlers.
3. A compact selected Bot that was removed, hidden or made ineligible left its
   unavailable notice behind a hidden roster. When no retained conversation
   descriptor remains, the compact workspace now shows the roster and its
   unavailable/Retry notice immediately, without requiring Back or selecting a
   different Bot. The saved place stays unchanged. A valid access-paused editor
   and temporary loading still retain their conversation presentation.

## Automated evidence

The initial attention RED run had 8 failures and 71 passes across 4 files. The
missing eligibility API, Track observation scope, stale notification cleanup and
N1 retained eligibility were observed before implementation. Handoff hiding was
also reproduced in component/App and browser tests before the portal correction.

The Window pane browser probe initially kept `selectedViewId=B2` after a real
click in pane `main` (expected `main`). The new component pointer/focus cases
initially observed zero selection callbacks, then passed after the narrow fix.
The three compact unavailable component cases were also RED before the roster
correction and GREEN afterward; the browser cases require automatic roster
visibility without a manual Back click.

| Check | Observed result |
| --- | --- |
| Attention/App/Handoff focused unit pass | 6 files, 129 tests passed, 12.01 s before the later Window pane correction |
| Surface/Family/real-transport surface pass | 3 files, 50 tests passed, 3.87 s after that correction |
| Compact unavailable and App regression pass | 3 files, 30 tests passed, 8.51 s after the compact correction |
| Lab source and E2E typecheck | Final pass successful |
| Lab static production build | Passed; assets recorded above |
| Final combined focused unit pass | 10 files, 186 passed, 21.29 s |
| Chromium desktop, Bot mode | 14 passed, 28.6 s; ports 50175/50176 |
| Chromium mobile, Bot mode | 14 passed, 30.0 s; ports 50810/50811 |
| WebKit desktop, Bot mode | 14 passed, 31.0 s; ports 51420/51421 |
| WebKit mobile, Bot mode | 14 passed, 31.5 s; ports 52248/52249 |
| Legacy ownership/composition suites | Remaining cases pending; original failures independently confirmed on branch baseline `1c2f9fef` |
| Compatibility update/check | Not exercised by Task 4 child; parent owns the reviewed refresh |
| Repository typecheck/unit suite | Not exercised by Task 4 child; parent owns integration checks |

Every run has per-test and outer deadlines. Focused Vitest uses
`--testTimeout=10000 --hookTimeout=15000 --maxWorkers=1` inside a Python
`subprocess.run(..., timeout=...)`. Browser runs use the root runner's 30-second
test timeout and 480-second global deadline, a 530-second Python deadline, and
the root runner's 540-second outer deadline. Projects run sequentially with
fresh free Relay/web ports; no existing listener is stopped or reused.

Browser command: `pnpm test:e2e bot-mode.spec.ts --project=<project> --max-failures=3`.
The four projects are `chromium-desktop`, `chromium-mobile`, `webkit-ask-desktop`
and `webkit-ask-mobile`. Final remaining totals and ports are appended below.
Early fixture/locator corrections are not
product defects: duplicate empty-section headings needed a region scope,
remote-created Windows needed their actual selected route, duplicate native
Bot bindings were correctly rejected, and label metadata has a 120-character
limit. Existing ownership/persistence specs migrate direct-child selectors to
their Window-mode business pane, compare rich-editor text equivalently, and wait
for the actual Send control before dispatching.
The mode helper waits for the normal Window View disclosure and its expanded
state, rather than inspecting a temporary mode button during reload recovery.
WebKit offline tests also close newly intercepted sockets while offline because
Playwright's proxy connection is independent of browser offline emulation.
The mobile WebKit scroll case uses native focus on an offscreen roster button
and timeline PageUp; other projects use wheel input. This verifies independent
scroll containers, not touch gestures. The compact Handoff flow uses Hide details
before selecting another Bot, then expands the same progress section in Window
for the source, cancellation and viewport-bound assertions. No forced clicks
or direct scroll-position assignment are used in these cases.

## Known draft limitation

With a held successful acknowledgement, switching Window → Bot → Window can
invalidate rich-draft capture ownership. The existing conservative clear guard
then retains the already-sent text. The browser test proves one send, successful
delivery feedback (`Sent — waiting for conversation…` while the native echo is
held), pending release and continued shared editing of a later draft.

The sent text may need manual editing or clearing. No uncertain input is
replayed, and this task does not weaken the image/composer ownership guards.
Automatically clearing in this case requires separate evidence of continuous
document ownership.

## Complete local instance layers

| Layer | State | Task 4 child evidence |
| --- | --- | --- |
| Build | not exercised | Static Lab build passed; no `pnpm local up`/running checkout-build match was read by the child |
| Site | not exercised | No real local instance status/sign-in verification by the child |
| Controller | not exercised | No local Controller uplink/provider verification by the child |
| Page | not exercised | Controlled fixture screenshots only; real local page verification is parent-owned |
| Feature | not exercised | Controlled fixture behavior only; real local behavior verification is parent-owned |
| Model turn | not exercised | No real provider reply or native Handoff by the child |

## Screenshots and cleanup

Task-created artifacts are under `.tmp/local/bot-mode/` and are not committed.
Only images actually opened and inspected are cited in the final evidence table.
The fixture tests close their own pages, Host uplinks, Relays, gateways and
temporary authority servers in `finally`; the root runner owns its two fixture
services. The child has not started or stopped a complete local instance, used
the user's browser/Controller, pushed or deployed.

Final inspected screenshots and listener readback will be appended after the
remaining browser passes.
