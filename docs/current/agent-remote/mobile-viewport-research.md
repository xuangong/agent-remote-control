# Mobile viewport stability research

Research snapshot: 2026-09-23. Source baseline: `f701e57`.
Target: iPhone, user-reported iOS 27, Safari installed on the Home Screen.
This document proposes diagnostic experiments; it does not claim a verified fix.

## Observed behavior and scope

The user reviewed a slow-motion recording of landscape-to-portrait rotation.
The title, conversation and composer move downward together by approximately two
text lines, leave blank space above the title, and then return. Portrait-to-landscape
does not show the same disturbance. Previous timeline changes reduced the perceived
disturbance but did not remove this residual movement.

Rigid movement of these three regions makes application-shell positioning and the
browser viewport the first investigation targets. Markdown reflow and timeline
scroll anchoring alone do not explain movement of the title and composer.
The distance is an observation, not a constant to subtract in a workaround.

## Current ownership of layout

| Layer | Current implementation | Consequence |
| --- | --- | --- |
| Document | `html/body/#root` have minimum heights; body uses `100dvh` and mobile `overflow:hidden` | This does not prove that the native root scroll view cannot move. |
| Mobile shell | Fixed positioning, CSS `100dvh`, top defaults to zero | All major regions share this position. |
| Viewport hook | If inferred occlusion exceeds 100 px, writes shell height and `top = visualViewport.offsetTop` | A mistaken occlusion sample can activate a whole-shell positioning path. |
| Header | Normal Grid row with top safe-area padding | Padding affects internal layout; it is not the same quantity as visual viewport offset. |
| Timeline | Internal scrolling, bottom-origin flex layout | Its scroll correction cannot alone translate the header and composer. |
| Composer | Normal Grid row, bottom safe-area padding suppressed during inferred occlusion | Keep this shared layout rather than independently fixing the composer. |

Relevant files are `packages/agent-remote-lab/src/hooks/useVisualViewport.ts`,
`packages/agent-remote-lab/src/app.css`, and `packages/agent-remote-lab/index.html`.

The hook checks that visual viewport width matches window width before comparing
heights. That is useful but does not establish that every measurement belongs to
the same stage of the rotation. It can infer occlusion even without an editable
element focused. Focus affects retention of the reference height, not permission
to enter the occluded state. This is a code-level vulnerability to inconsistent
samples, not evidence that the user's device actually produced such samples.

## Findings from primary sources

1. Layout viewport, visual viewport and document coordinates are distinct.
   `visualViewport.offsetTop` measures the visual viewport relative to the layout
   viewport; `pageTop` uses the document's initial containing block. Neither is a
   safe-area inset. See [CSSOM View](https://www.w3.org/TR/cssom-view-1/#the-visualviewport-interface).
2. `dvh` does not promise a smooth, frame-by-frame size during browser UI animation.
   The specification also permits overlay interfaces such as keyboards to leave
   viewport units unaffected. CSS-driven sizing reduces application-owned work,
   but cannot alone guarantee keyboard avoidance or eliminate native motion.
   See [CSS Values](https://www.w3.org/TR/css-values-4/#viewport-relative-lengths).
3. `interactive-widget=resizes-content` has the desired standardized behavior of
   resizing both viewports, but the WebKit implementation request is still NEW in
   the retrieved snapshot. The existing meta value is not proof that it works on
   the target device. The VirtualKeyboard API implementation request is also NEW.
   See [CSS Viewport](https://www.w3.org/TR/css-viewport-1/#interactive-widget),
   [WebKit 259770](https://bugs.webkit.org/show_bug.cgi?id=259770), and
   [WebKit 230225](https://bugs.webkit.org/show_bug.cgi?id=230225).
4. Safe areas describe regions where content needs protection. Use them as
   edge padding with explicit ownership, rather than as a second whole-shell
   translation. See [WebKit's safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/).
5. Current browser compatibility data lists `overflow-anchor` support from Safari
   27. The user's reported version is therefore relevant; lack of support in old
   Safari is not an adequate explanation here. This does not prove the exact
   device build's behavior, and anchoring still concerns a scroll container, not
   whole-shell movement. See [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/css/properties/overflow-anchor.json).

### Related WebKit reports and their limits

| Source | Relevant evidence | Limit |
| --- | --- | --- |
| [218983](https://bugs.webkit.org/show_bug.cgi?id=218983) | Standalone PWA can report incorrect visual viewport height after landscape keyboard use followed by portrait rotation. | Older report; not proof of the same iOS 27 defect. |
| [292603](https://bugs.webkit.org/show_bug.cgi?id=292603) and [PR 74122](https://github.com/WebKit/WebKit/pull/74122) | A contributor traces native scroll extent inflation to overlapping keyboard and obscured insets; DOM scrollTop can remain zero despite native movement. PR was open and unmerged when checked. | Keyboard/bottom-gap case, not the reported rotation/top-gap reproduction. |
| [301172](https://bugs.webkit.org/show_bug.cgi?id=301172) | Standalone fixed/sticky positioning can visually drift during scrolling. | Different trigger; does not establish a rotation cause. |
| [191363](https://bugs.webkit.org/show_bug.cgi?id=191363) | Historical safe-area rotation issue. A later comment reports expected behavior on iOS 16.4. | An open bug status alone cannot establish current applicability. |
| [300523](https://bugs.webkit.org/show_bug.cgi?id=300523) | iOS 26 viewport shift around Dynamic Island/keyboard changes. Maintainer suggests testing 26.1 for a fix. | Do not extrapolate directly to iOS 27. |

## Layout direction

Keep one bounded application shell. Header, scrollable content and composer should
remain ordinary Grid rows. Each visible conversation may have its own scrollport
for Side/Ask; the document should not become another conversation scrollport.
Sidebars and modal overlays still need their own deliberate scrolling boundaries.

Use CSS sizing when unobscured. Preserve a small keyboard adapter where Safari
does not resize the layout viewport. A confirmed visual viewport displacement can
require offset compensation; deleting that compensation unconditionally can put
the composer behind the keyboard. Only accept coherent measurements for the
adapter, and keep height, offset and keyboard classification in one decision.

Assign safe-area padding once at each exposed edge. Preserve pinch zoom, focus
visibility and keyboard navigation. Do not add root translation/height animations,
continuous scroll resets, permanent rendering-layer promotion, or long visual
freezes to hide a geometry problem.

| Candidate | Benefit | Cost / required proof |
| --- | --- | --- |
| Existing fixed shell with corrected viewport decisions | Smallest change if trace shows application-owned top movement | Fixed composition remains; needs real rotation and keyboard traces. |
| Bounded normal-flow or absolute shell, ordinary Grid children | Reduces reliance on fixed-shell positioning | Native root scrolling/focus panning may return; keyboard, zoom and overlays need A/B verification. |
| Pure CSS shell with no keyboard adapter | Least JS geometry work | Not sufficient while Safari's keyboard resize behavior cannot be relied on. |
| Independently fixed header/composer | Familiar overlay pattern | More coordinate owners and synchronization risk; not recommended for this application. |

There is not yet enough evidence to choose between the first two candidates.
Changing fixed to absolute is an experiment, not a generally correct Safari fix.

## Diagnostic experiment before the next layout change

Add an opt-in, bounded in-memory geometry recorder for real-device use. Record
event-time snapshots and animation-frame samples around rotation, focus and page
restoration. Take the pre-update values and the hook's chosen result together.
Sampling should stop after the transition window; it must not become permanent
per-frame polling or upload message contents. Geometry reads can themselves alter
timing, so compare instrumented and uninstrumented recordings.

Capture these values with a monotonic timestamp and event reason:

- `innerWidth/innerHeight`, document `clientWidth/clientHeight` and scroll extent.
- `scrollX/scrollY`, `document.scrollingElement.scrollTop`.
- Visual viewport `width/height/offsetTop/offsetLeft/pageTop/pageLeft/scale`.
- Shell, title and composer bounding rectangles; shell computed top and height.
- Current viewport CSS variables, inferred occlusion, retained reference height,
  width alignment and coarse-pointer state.
- Computed top/bottom safe-area probe values; active element category, standalone
  display mode, orientation and page visibility. Do not record input values.

Interpret changes by coordinates rather than by the direction of one raw number:

| Observation | Next experiment |
| --- | --- |
| Shell top style changes and all children move correspondingly | Inspect why occlusion/offset compensation activated; replay the actual measurement sequence. |
| Shell position is stable but header padding and row sizes change | Isolate safe-area ownership and its rotation update sequence. |
| Root or visual viewport coordinates change without a shell style change | Investigate focus panning and root scroll extent; compare constrained root layouts. |
| Recording visibly shifts while sampled CSS geometry does not | Investigate native/compositor movement or unsampled intermediate frames; test a minimal page in standalone mode. |

Equal title/composer translation with stable separation points more strongly to
shell/viewport motion than to header padding alone. DOM geometry alone cannot
certify that native composition remained stationary; use a synchronized recording.

Run controlled A/B variants one at a time: original shell, offset compensation
diagnostic variant, then an alternate bounded shell only if evidence calls for it.
Use a minimal page with a header, one scrolling region and editable composer to
separate browser behavior from application rendering. Do not ship a blanket
`top:0` experiment as a fix; keyboard-open behavior must be retained.

## Acceptance and verification boundaries

Test on the reported iOS 27 device in Home Screen mode, with Safari-tab mode as
a control. Include both rotation directions, repeated cycles, no focus, software
keyboard visible, keyboard recently dismissed, return from another app, timeline
at latest and in history, short/long conversations, Ask open and Side visible.
Cover focused multiline input, image attachments, pinch zoom and safe-area edges.

Success means no extra down-and-back shell translation after accounting for the
browser's normal rotation, no transient blank strip above the app, and a reachable
composer above the keyboard. History should retain its reading anchor and latest
mode should retain its bottom relationship without a second application-induced
scroll jump. Validate landscape home-indicator and portrait notch clearance.

Recorded geometry sequences can become deterministic hook regression tests.
Desktop Chromium and Playwright WebKit can verify sizing and application writes,
but they cannot establish the absence of native iPhone standalone composition
glitches. A passing viewport-resize test is not a passing real-device rotation.

The research phase did not change runtime layout. A layout fix should be selected
from the measured cause rather than by adding another timing delay.

## Opt-in recorder

Settings now provides **Layout diagnostics → Record layout changes**. It defaults
to off, is not persisted, and survives closing the Settings panel. Enable it,
return to the conversation, reproduce the shift, then return to Settings and use
**Copy report** or **Download**. Export stops recording first. A selectable text
area remains available if clipboard access or downloads are blocked.

The recorder retains at most 800 samples in memory and stops after 10 minutes or
pagehide. It samples animation frames for three seconds after relevant viewport,
orientation, focus and restoration events, skips unchanged frames, and suspends
frame sampling while hidden. The existing viewport hook contributes measurements
immediately before and after its style writes without changing its decisions.
Stopping removes listeners, timers and the hidden safe-area probe. Clearing removes
the report; starting again replaces it. Refreshing loses the report.

The JSON report identifies its format and version, includes wall-clock start/stop
times and relative sample times, and describes its delta encoding: the first
retained sample is complete; subsequent samples inherit omitted top-level fields.
It reports dropped sample counts if the buffer rolls over. Geometry, browser user
agent and display mode are included; chat text, input values, URLs, session IDs,
credentials and browser storage are not read or uploaded.

Deterministic tests cover opt-in lifetime, bounded capture, automatic stop,
foreground recovery, Settings remounting, clipboard fallback and JSON download.
Browser tests exercise the viewport hook's before/after positions in Chromium and
WebKit. These simulated viewport events verify the recorder, not a physical iOS
27 rotation fix. Real-device recording remains necessary.

## Device trace and edge-to-edge trial

The user's 2026-09-23 recording captures the residual movement. At 5855 ms,
portrait viewport height changes to 874 px and the top safe area becomes 62 px.
Navigation padding changes from 0 to 62 px; its height changes from 49 to 111 px.
The composer top becomes 734.41 px. At 6141 ms, viewport height returns to 812 px,
top inset returns to zero and composer top returns to 672.41 px. This interval
lasts approximately 286 ms. A subsequent short root-scroll sequence goes from
0 to 62 to 0; the sampled shell rectangle correspondingly moves to y=-62 and back.

Throughout this sequence, keyboard occlusion is false, shell computed top is zero,
and viewport top/height overrides are absent. This rules out application keyboard
offset compensation for this recording. It does not establish which native
WebKit component causes the temporary viewport/safe-area change.

The Home Screen entry now requests `black-translucent` instead of `default`, while
retaining `viewport-fit=cover`. The intended contract is one edge-to-edge viewport
with CSS safe-area padding, rather than a page normally below the system status
bar. Apple's archived [meta tag reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)
describes this distinction; actual iOS behavior still requires verification.

The outer mobile navigation owns the top inset. The optional secondary Header
does not add it again. No rotation timers, scroll resets or viewport policy
changes are added.

The initial trial also painted a fixed dark strip over the top safe area. The
user subsequently reported a dark flash at the top. Since the strip height
directly followed the changing inset, it could appear abruptly during rotation.
The decorative strip has been removed; the existing surface backgrounds now
paint the safe area. This does not change layout geometry. Native status text
contrast and remaining page movement still need device verification.

Diagnostics include the current document's `statusBarStyle`. This identifies
the loaded HTML declaration, not proof that an existing Home Screen installation
has adopted the native mode. For device validation, fully close and reopen the
Home Screen app after deployment and record another rotation. Check whether
settled portrait mode consistently uses the full height with a nonzero top inset,
and whether the transient 62 px down-and-back movement has disappeared. Also check
status text contrast, keyboard access, foreground recovery and both orientations.
If an existing installation retains the old native mode, compare a newly added
Home Screen entry before changing layout code again.

`e2e/standalone-layout.spec.ts` verifies served launch metadata and exercises real
CSS safe-area values via Chromium's CDP inset override. WebKit runs the metadata
and recorder checks, but skips the CDP-only inset test. These tests establish
safe-area ownership and control bounds, not native iPhone rotation smoothness.
