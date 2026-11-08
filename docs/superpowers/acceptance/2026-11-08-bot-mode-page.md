# Bot mode page acceptance

This document records Task 4's implementation and controlled browser evidence on
the `bot-mode-ui` worktree. Final integration review, compatibility, repository
checks and the real local instance belong to the parent acceptance pass; those
layers remain unverified until their evidence is appended below.

## Revision and evidence boundary

- Worktree: `/Volumes/Projects/agent-remote-control/.worktrees/bot-mode-ui`.
- Reviewed Task 3 baseline: `66f704326512a17037b551f36e8c929eeb1d48c4`.
- Task 4 implementation snapshot: `190b737a199e70bd5cddcb1f6ac0c104be007f87`.
  A subsequent test-only change adds the Window-only acknowledgement control.
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
| Window-only acknowledgement control | 4/4 passed; draft clears in all four projects; Lab source/E2E typecheck passed again |
| Legacy ownership/composition suites | 45 passed, 12 platform skips, 23 failed across 80 remaining cases; see comparison below |
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
and `webkit-ask-mobile`. The added control uses the same command with
`--grep='staying in Window mode'` and no max-failures option.
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

## Legacy Window comparison

Each legacy file/project ran separately with
`--grep-invert='another session|refresh during an unavailable|a terminal nested'`.
The three excluded cases retain their assertions and were independently
reproduced by the parent on the actual branch baseline `1c2f9fef`.

| Project | Ownership: pass / skip / fail | Composition: pass / fail | Ownership ports | Composition ports |
| --- | --- | --- | --- | --- |
| Chromium desktop | 8 / 3 / 0; 19.2 s | 7 / 2; 41.0 s | 53072/53073 | 53624/53625 |
| Chromium mobile | 5 / 3 / 3; 1.4 min | 3 / 6; 2.2 min | 54617/54618 | 55407/55408 |
| WebKit desktop | 8 / 3 / 0; 22.0 s | 7 / 2; 42.4 s | 56503/56504 | 57316/57317 |
| WebKit mobile | 5 / 3 / 3; 1.4 min | 2 / 7; 2.4 min | 58254/58255 | 59392/59393 |

The parent independently built baseline `1c2f9fef` and compared the failures.
The child read those logs under `.tmp/bot-mode/`:

- `branch-base-three.log`: selecting another session leaves the old primary
  history; unavailable/nested Side alerts match multiple notices.
- `branch-base-remaining.log` and `branch-base-cache-adapted.log`: both
  opened-list variants read the removed legacy `composition.path` cache as null.
  Adapting the baseline-only cache reader to `saved.window ?? saved` makes the
  Close/primary cases pass; its initial shape mismatch is not product evidence.
- `branch-base-mobile-ownership.log`: the same mobile containment assertion and
  Search control intercepted by the action toggle fail on the baseline.
- `branch-base-mobile-composition.log`: both source-bound Ask cases and the
  delayed Side snapshot case cannot fill their hidden source editor before
  reload, with the same setup failure on the baseline.
- `branch-base-mobile-primary.log`: the baseline reaches its primary history
  assertion, then cannot click that hidden pane. The current compact case fails
  earlier because its primary history is not mounted yet. These are different
  failure points; this scenario does not prove that user-selection behavior.
- `branch-base-webkit-mobile-cached-ask.log`: the same visible Ask control timeout
  at line 414 also occurs on baseline WebKit mobile. The current cached Ask
  cases pass on both Chromium projects and WebKit desktop.

The legacy suites are not fully green. Their assertions remain intact, and no
unrelated product behavior was changed to make them pass. Failed-case logs are
stored as `<project>-<legacy-spec>-final.log` under `.tmp/local/bot-mode/`;
later traces and error contexts are retained in its `legacy-artifacts/` folder.

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

The explicit Window-only control uses the same fixture, successful-ack gate and
held native echo, without changing modes. It observes an empty editor after
`Sent — waiting for conversation…`; Send is disabled because the draft is empty.
Filling a later draft enables Send again, proving the pending state was released.
All four controls record `sends:1`, `pending:false`, `draftAfterAck:""` and
`laterDraftEnabled:true` in `<project>-window-only-ack-control.json`.

| Control project | Result | Relay/web ports |
| --- | --- | --- |
| Chromium desktop | 1 passed, 7.0 s | 61011/61012 |
| Chromium mobile | 1 passed, 5.1 s | 61124/61125 |
| WebKit desktop | 1 passed, 5.7 s | 61218/61219 |
| WebKit mobile | 1 passed, 6.2 s | 61346/61347 |

WebKit's two control runs logged Vite socket `ECONNRESET` during disconnection;
both test processes exited successfully. No fixture cleanup exception occurred.

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

The following final-run images were opened and inspected. Paths are relative to
`.tmp/local/bot-mode/`; the screenshots support visual presentation, while tests
and fresh group/operation reads establish identity and no-replay behavior.

| Image | Observed presentation |
| --- | --- |
| `chromium-desktop-conversation-1440.png` | Roster beside content and one shared draft editor |
| `chromium-desktop-long-label-roster.png` | Wrapped label, hexagon/color and pin marker; long titles remain bounded |
| `chromium-desktop-offline-queue-return.png` | One queued reply and the later editable draft |
| `webkit-ask-mobile-conversation-320.png` | Compact Back/mode controls, readable content and one bounded composer |
| `webkit-ask-mobile-compact-hidden-roster.png` | Automatic roster with unavailable, Retry and New section |
| `webkit-ask-mobile-compact-ineligible-roster.png` | Same automatic roster after ordinary Bot eligibility is removed |
| `webkit-ask-mobile-long-label-independent-scroll.png` | Scrolled roster while the original conversation remains selected |
| `webkit-ask-mobile-handoff-window-progress.png` | Same Bot source progress, reachable controls and viewport bounds in Window |
| `webkit-ask-mobile-handoff-complete.png` | Confirmed successor history and retained source draft |
| `chromium-desktop-acknowledged-retained-draft.png` | Successful acknowledgement with already-sent text retained after mode switches |
| `chromium-desktop-window-only-ack-control.png` | Successful acknowledgement with an empty Window-only editor |
| `webkit-ask-mobile-window-only-ack-control.png` | The same empty-editor acknowledgement control on compact WebKit |

`listener-readback.json` records 57 selected fixture/validation ports, all closed
by `connect_ex`. The failed mobile joined fixture initially left only
`roles/state.json` after an `ENOTEMPTY` cleanup exception. Its task-owned root
`arc-joined-browser-HXxNTo` was removed after services exited and read back absent;
the inspected final roots `arc-joined-browser-9RLzPn` and
`arc-joined-browser-vVjAtz` were also absent. All child test processes and the
bounded artifact-preservation process have exited. Parent-started integration
services and resources are outside this cleanup scope.
