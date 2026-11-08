# Bot mode page acceptance

This document records the Bot mode milestones 2a and 2b implementation, review,
controlled browser evidence and final local-instance acceptance. Earlier child
results below are point-in-time records; the final integration section records
the reviewed delivery snapshot and supersedes their pending parent-owned gates.

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

## Final integration acceptance (2026-11-09)

The reviewed product snapshot is `460885ae6f24cace1a9f36cbf39cb9d7920e374a`.
The final source fix is `ce82a9ca79ea7273f8076672728bfb43caa797fd`; the next commit
refreshes compatibility metadata. Final documentation commits do not change product code.
The branch remains `feat/bot-mode-ui` in the dedicated worktree. No push, merge,
package publication or deployment belongs to this Bot milestone delivery.

The independent final review found four Important issues: Bot observation lifetime
when the remembered Window disappears, concrete-history clicks on delivered Window
notifications, stale public catalog state across scopes, and a pending local draft
blocking an explicitly selected new attachment target. The combined fix addressed
all four; its scoped re-review found no new breakage. The conservative draft-clearing
limitation above remains deferred Minor M1.

| Final check | Observed result and local artifact |
| --- | --- |
| Recursive build | Passed, including debugger; `.tmp/bot-mode/2b-final-build.log` |
| Repository typecheck | Passed, including Lab E2E and debugger web types; `2b-final-typecheck.log` |
| Full `pnpm test` | Exit 0; 7,842 passed / 22 skipped across 18 packages, debugger included; `2b-final-unit.log` |
| Final fix regression suite | 20 files, 515 passed / 6 skipped; `final-fix-focused-final.log` |
| Compatibility update and check | Passed; digest `sha256:4b35d0dccc8299514bb52f0123546fe8965ef67f41d1cb9fd8264dde2f4582fa` |
| Chromium desktop Bot matrix | 15 passed; 31.5 s; ports 51459/51460 |
| Chromium mobile Bot matrix | 15 passed; 31.0 s; ports 52430/52431 |
| WebKit desktop Bot matrix | 15 passed; 35.2 s; ports 54438/54439 |
| WebKit mobile Bot matrix | 15 passed; 34.2 s; ports 55664/55665 |

All final browser fixture ports were read back closed. Browser logs are
`.tmp/local/bot-mode/post-fix-<project>.log`. These 60 passes do not erase the
legacy failures and differing compact-primary failure boundary documented above.
The isolated baseline comparison worktree was removed only after its task-owned
probe diff and evidence were archived; the main checkout and other worktrees remain intact.

### Real local-instance observations

Origin: `http://localhost:58578`, instance `bot-mode-ui-986bb6c2`.
The final product validation ran with clean running and checkout commit `460885ae6f24`.
`pnpm local up` completed with signed-in local user and registered Controller uplink;
Claude and Codex were enabled. The native fixtures belong to this instance's workspace.
No physical iPhone test or production verification was performed.

The actual Bot B displayed the Codex reply `LOCAL-OK`. Text and a Ready image draft
survived mode changes; the same B editor DOM was retained when moving that same
view directly between Window and Bot. Opening unrelated Window A retained its
independent location and draft. At 390 by 844, Back displayed the roster, only one
composer was visible, and the page had no horizontal overflow. New section created
a real section-only group and its empty-state explanation. The actual ungrouped
Codex session displayed `FALLBACK-READY` in Other sessions.

The first actual Handoff committed operation `14b08539-7b7e-4328-b34a-362486e5b62b`
from native `01a1bc84-ffa5-7da0-8f8f-2cea536435ff` to
`01a1bc9c-b35c-7742-b059-05dec30d2d69`. It did not send a prompt. The harness then
switched to Window A and timed out after 120 seconds waiting for background B's
saved binding. This is a recorded failed harness execution, not a passed acceptance.

The selected active Bot consumer owns `windowSuccessionLayout` reconciliation;
Window mode suspends it. Plan Task 1 Step 5 explicitly subscribes and reconciles
selected groups while Bot mode is active. Waiting longer in Window A does not
activate B's consumer. The follow-up opened Bot B without replaying Handoff:
it resolved the exact committed successor and saved revision 2 to 3, preserving
B's group/view and unrelated A. One subsequent UI send through a mode round trip
produced the real reply `BOT-VERIFIED`, with one observed send and no uncaught page
error. The first context had closed, so that recovery alone does not establish
its original draft continuity. Evidence: `local-acceptance.*`, `native-successions.json`,
`native-handoff-diagnostics.json`, `local-continuation.*` under `.tmp/local/bot-mode/`;
read-only diagnosis: `.tmp/bot-mode/handoff-projection-diagnosis.md`.

The preparatory Claude request returned ordinary provider failure
`API Error: 422 The request was blocked by the content safety policy.` It was not
retried or relabeled as success. Codex has real reply evidence; Claude does not
have a successful model turn for this acceptance. OpenCode was not exercised.

| Opened image under `.tmp/local/bot-mode/` | Observed state, paired with script DOM assertions |
| --- | --- |
| `local-final-desktop-draft.png` | Native B reply, roster and text plus Ready image draft |
| `local-final-compact-conversation.png` | Compact Back, single conversation and retained draft |
| `local-final-compact-empty-section.png` | Newly created empty section and Other sessions |
| `local-final-handoff-dialog.png` | B's actual Codex Handoff chooser and existing draft |
| `local-acceptance-failure.png` | Window A and its independent draft during the background-binding timeout |
| `continuation-committed-handoff-reopened.png` | Same B opens its verified successor with pending first-input context |
| `continuation-native-reply.png` | Actual successor reply BOT-VERIFIED and one visible editor |
| `continuation-fallback.png` | Ungrouped native history FALLBACK-READY in Other sessions |

### Remaining native acceptance boundary

A separate same-context attempt on the already committed successor reached an
explicit terminal rejection during prepare: operation
`088af8b5-efa2-40eb-be09-39fe7252b256`, `succession_preparation_failed`.
The supported `succession/status` read confirms role revision 2 and its current
native identity remain unchanged. Candidate `01a1bca3-9c25-7231-98a4-cf6cb5654e68`
was created but was not committed; a read shows an idle empty session. No commit
request or user send occurred. This failed record was not replayed or reconciled,
and the candidate was not adopted as a replacement.

`native-draft-before.png` was opened and shows the actual BOT-VERIFIED history,
text and Ready image. `native-draft-failure.png` was opened and shows that same
history and draft with the visible "Handoff could not be completed" progress
notice. Artifacts: `native-draft-handoff.mjs`, `.log`, `.json`, and
`native-draft-rejected-status.json`. This is a failure of the real preparation
path, not evidence that the Bot draft survives a successful same-context Handoff.
The underlying exception is not present in the generic failure code; do not
attribute it to credentials, the environment or Bot presentation without evidence.

| Final local layer | State | Evidence boundary |
| --- | --- | --- |
| Build | verified | Clean 460885ae running build matched checkout after local up |
| Site | verified | Running local site and signed-in local user |
| Controller | verified | Registered uplink; Claude/Codex enabled |
| Page | verified | Opened desktop/compact images and corresponding DOM assertions |
| Feature | partial | Mode, drafts, section creation, fallback and committed-successor recovery verified; successful same-context native Handoff draft continuity remains unverified |
| Model turn | verified for Codex; failed for Claude | Actual LOCAL-OK, BOT-VERIFIED and FALLBACK-READY; Claude returned provider API 422 |

Implementation and independent review are complete. Full native acceptance is
not claimed complete. The retained-ack draft limitation, legacy browser failures,
and preparation rejection remain explicit delivery concerns. The worktree and
local instance are retained for inspection and further native diagnosis.

## Decisions and costs

The following is the exhaustive chronological `Ruling:` record from this plan's
execution ledger. Each decision includes its reason and cost or evidence limit.

1. Retain /handoff for ordinary writable Bot views through existing source-scoped guards and chooser — earlier user request in this session opens it wherever logically supported — cost is additional Bot Handoff integration tests.

2. Use existing stable portal-host pattern to keep one composer per view across mode presentation — mount-local pending state cannot safely be duplicated or discarded — cost is a small explicit surface ownership component.

3. Implement milestone 2b only after 2a, leaving milestone 3–5 management/linking/team features for their own plans — matches accepted staged specification — cost is empty new sections until management is delivered; useful existing Window conversion remains available.

4. Enable section-only URL redirection only when the new optional WorkspaceNavigation contract is supplied; retain 2a explicit section URL behavior for legacy callers — plan promises old callers unchanged, App will opt into the new path — cost is maintaining both caller contracts until legacy callers migrate. Confirmed section-only must never attach stale native query state or rewrite last-Window.

5. Give section creation explicit sectionCreationState/retrySection instead of reusing Window retrySave/error — independent operations must not intercept each other and Task3 needs reload-visible uncertainty — cost is two small public controller fields and a dual-pending regression.

6. Add an explicit no-new-attach gate for parked leaves and validate mapped views against current group data in App before succession resolution — existing missing-slot fallback is not deletion/rebinding proof — cost is one leaf gate and group-locator regression coverage.

7. Preserve the new-navigation contract that cached Window targets cannot attach before remote inspection confirms Window appearance; update the legacy App retention test to verify no pre-inspection attach, then one attachment/stream with unchanged timeline gates — an old ordinary cache may now be a section-only group and cannot establish current authority — cost if wrong is extra cold-start attachment latency until inspection; legacy callers without the navigation contract retain their old hook behavior. Do not weaken the existing cached-section regression to satisfy the old App timing assertion.

8. During temporary WorkspaceReady=false recovery, preserve the current surface host/editor and read-only content while revoking attachment/mutation/connection admission and aborting native recovery; retire the registry only on scope/transport/unmount — existing App recovery regressions and the product reading/draft continuity contract override Task2 brief conflating access suspension with scope disposal — cost if wrong is stale read-only content during recovery, bounded by existing access gates; source/scope changes must still retire it. Task3 implementer owns this narrow surface fix plus lifecycle/access regressions, and Task3 review must include it.

9. Retain the existing rich-draft ownership fence when a successful in-flight acknowledgement arrives after mode transitions invalidated its captured edit owner; do not weaken useImageDraft/AgentComposer clearing authority in this milestone — one acknowledged send, pending release, no replay and no lost draft are verified; text equality alone cannot authorize clearing a potentially newer edit — cost if wrong is sent text remaining in the editor after switching modes, requiring manual editing/clearing. Browser tests/report must explicitly assert and disclose this behavior plus a Window-only control; final review must triage the limitation. A future automatic-clear optimization needs proven document-owner continuity.

10. Migrate the delayed Side restoration browser assertion from DOM absence to existing shared-Window selection semantics: selected view/URL stay chosen after late response, Side membership is unchanged and unselected, correct draft persists, no create/send replay — implementer statically compared baselinea0648327 SessionFamily and found the same attached-view retention and Close/Back semantics; selecting another pane does not close it — cost if wrong is an undetected legacy-only removal regression; report static baseline evidence only, not a baseline browser pass. Explicit Close still must remove the view and not reattach after reload. Task4 review includes migrated assertions.

11. Preserve the existing same-scope Window-mode delivered notification contract: after A succeeds to B/C, its already-delivered notification still opens concrete A history. Continue gating new observations and deliveries by eligibility, and gate Bot-mode notification clicks by the current roster — the plan simultaneously required removal-time closure and unchanged Window click behavior; the established history locator guarantee and Window preservation requirement take precedence — cost if wrong is older Window notifications remaining actionable after succession, while current-mode/scope/disposal authorization must still apply. Do not satisfy the regression by deleting its history assertions.

12. Treat saved Bot succession layout as active-consumer projection, not an eager background rewrite while another Window is displayed; verify the exact committed successor when returning to the same Bot — Task1 Step5 explicitly activates selected-group reconciliation and leases only in Bot mode, and actual committed-operation readback plus reopening confirms recovery — cost is a stale persisted Bot binding until that group is activated; no promise of instantaneous rewriting of all saved groups. The first120s assertion remains recorded as failed; it cannot prove same-context draft continuity after its context was closed.
