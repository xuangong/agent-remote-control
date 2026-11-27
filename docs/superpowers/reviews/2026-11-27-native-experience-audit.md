# Native-experience audit of the web workbench (2026-11-27)

Scope: the installed app only, on a phone (iPhone "Add to Home Screen") and on the desktop (Chromium standalone window). Question: does it behave like a native app, or only look like one? Audit of `main` at `0af3d93b`; no product code changed. Evidence lives under `.tmp/native-audit/` (ignored by git); the scripts that produced it are in the same directory (`start.mjs`, `liefi2.mjs`, `open.mjs`, `pages.mjs`, `nav2.mjs`, `offline.mjs`, `life.mjs`, `reload.mjs`, `styles.mjs`).

## Method and limits

- Own instance (`pnpm local up`, one Host, 3 assistants with real Claude replies plus 3 CLI sessions), headless Playwright only.
- **Phone:** WebKit with the iPhone 15 descriptor (touch, 393x659 viewport) for DOM, scroll, history and style facts; Chromium with the same viewport and touch for load timing, because only Chromium can throttle with CDP (`Network.emulateNetworkConditions`, latency plus bandwidth). The WebKit throttle is a per-request route delay: it does not delay the service worker's own fetches or WebSockets, so no WebKit timing below is cited as network evidence.
- **Standalone:** `navigator.standalone` and `display-mode: standalone` are emulated. The app only reads them for install prompts, push and storage persistence (`kernel/installed-app.ts`); no layout or navigation code branches on them, so the emulation loses nothing for those paths.
- **Profiles:** fast (localhost), 300 ms / 1.5 Mbps ("3G-ish"), 1500 ms / 400 kbps ("poor"), 6000 ms latency ("lie-fi"), offline. "Warm" means the service worker is active and the device store holds conversations, which is every launch of an installed app after the first.
- Layout shift is measured with `layout-shift` entries (Chromium only; WebKit has none, so WebKit shifts are read from element and frame sequences).

## Summary: the organising problems

The app is structurally closer to native than most web apps: a service worker with a stored shell, a device store, persisted drafts, a tab bar, views that stay mounted, history entries per conversation and per Settings page, push/pop animation, no dark-theme flash, resume from background without flashes. Once data is on screen, navigation is instant (30-60 ms to first change, zero layout shift). The "unstable web page" feeling comes from four patterns around **getting data on screen and keeping the place**, not from the navigation itself.

1. **Local state is stored but not rendered.** Every data hook is gated on `accessReady`, which becomes true only after `/auth/status` answers (`GatewayController.tsx`, `useSessionSuccessionBinding.ts:73` passes `accessReady` as the workspace hook's `enabled`; `device-store-start.ts`: stored conversations "are shown only once the Relay confirms the lease"). The shell paints immediately with the cached access, then shows an empty list until the network answers: three sequential round trips (page, `/auth/status`, `/v1/windows`). On a 1.5 s network the person sees an empty app for 3 s; offline they see it forever.
2. **"Empty" and "not loaded yet" are the same state.** Lists render `!items.length` as the empty-state copy (`features/chats/BotRoster.tsx:99`, "No chats yet. Start one from Assistants."). There is no tri-state, so every slow load shows a lie, and content then pops in with layout shift.
3. **The page is network-first.** The service worker asks the network for `/` and only falls back to the stored shell when the network fails (`app-shell/app-shell.ts` `page()`). A slow or stalled network (the common mobile case) is therefore not a failure, and the launch is blank for as long as the network takes. A native app never waits for the network to draw its first screen.
4. **Pages are swapped, not stacked, and the place is not remembered below the page level.** Roster, Settings and the last-opened conversation stay mounted, which is good, but only one conversation is mounted at a time, `display: none` resets its `scrollTop`, and nothing stores a reading position. Push animates only the incoming page, pop re-animates the roster from 60 % opacity, and there is no interactive swipe back. Place survives reload at the page level (URL, open assistant, draft) but not at the reading level (scroll).

A fifth, smaller pattern: touch chrome is still web chrome (everything is `user-select: text`, default grey tap highlight, `touch-action: auto`).

## Findings, ranked by how much they break the native feel

Setup tags: P = phone, D = desktop. Times are ms from navigation start unless stated.

### 1. A warm launch shows an empty app until three round trips finish (P, D)

- **Evidence (Chromium, phone-shaped, warm, `liefi2.mjs`):** at 300 ms / 1.5 Mbps the shell paints at 344, the roster has no rows until **1042** (page 315, `/auth/status` 650, `/v1/windows` about 1000). At 1500 ms / 400 kbps rows appear at **4877** while the tab bar and "No chats yet. Start one from Assistants." show from 1639: **3.2 s of a false empty list** (`slow-home-a.png`). Fast network: rows at 141. Desktop warm at 300 ms: first row at 455, the other two at 1328 (`start-desktop-slow.json`).
- **A cold launch into a conversation** (`liefi2.mjs`, deep link, 300 ms): 410 "Pick someone to talk to" (wrong pane), 662 "Opening the assistant…", 1011 composer with an empty timeline, **2473 first messages**, although this device holds the conversation. At 1500 ms the messages arrive at 4776 (`slow-deep-b.png`: header and draft, empty body).
- **Cause:** `GatewayController` renders children with the cached access but `ready=false`; `useWindowWorkspace(baseUrl, userScoped, accessReady, ...)` and the device-store reads wait for `ready`. The device-store comment states stored rows are shown only after the lease is confirmed. In-app, after the first open, stored messages are shown at +73 ms (`open.mjs warm`), so the store works; only the launch path blocks on the lease.
- **Fix direction:** treat a cached lease as good enough to render, read-only and marked stale (the device link dot already exists): render roster, conversation previews and messages from local state in the first frame; confirm in the background; reconcile in place. A 401/403 then purges and signs out as it does now. Size: M-L (one gate moved, but every hook that checks `accessReady` for reading, not writing, needs the read/write split).

### 2. False empty states while loading or offline (P, D)

- **Evidence:** "No chats yet. Start one from Assistants." on every warm launch before rows (cold 33 ms, warm 20-30 ms on fast network, 3.2 s on a poor one) and **permanently when offline** (`offline-home.png`: shell starts, red dot on Me, empty list, tapping nothing works; `offline.mjs`). Other texts seen while loading: "No timeline activity." (conversation open, Window tile on desktop), "Pick someone to talk to", "Nothing learned yet." and "No files changed or shared yet." (assistant details sheet), desktop "Create a group to organize sessions…" (`pages.mjs`, `start.mjs`).
- **Cause:** empty copy is rendered from `length === 0` with no loaded flag (`BotRoster.tsx:99`; the same shape in the conversation timeline, details lists, Window sidebar).
- **Fix direction:** one `Loadable<T> = unknown | loaded` per list; `unknown` renders reserved space (placeholder rows or nothing) and never copy; `loaded && empty` renders the copy. Audit every `lab-*-empty` and `*.empty` message key. Size: S per list, M overall.

### 3. Offline start is an empty, inert app (P, D)

- **Evidence:** with the network off, the installed shell starts from the service worker in 136 ms, shows the false empty list, and cannot open any assistant or conversation, even though messages and the roster were stored on this device (`offline.mjs`: tap on Hatch times out, nothing to tap). The only status is a red dot on the Me tab.
- **Cause:** finding 1 (reads gated on the lease), plus the roster comes from the window catalog fetched from the Relay and not from the cached window groups that `useWindowWorkspace` keeps in local storage for the open Window only (lines 474-505).
- **Fix direction:** same as 1, plus an honest quiet banner or title line ("Offline, showing saved chats") and a send path that queues (the outbox exists). Size: part of 1, S extra.

### 4. A stalled network blanks the launch (P, D)

- **Evidence (Chromium, warm, `liefi.mjs`):** time to first painted shell equals the network latency: 35 ms fast, 335 at 300 ms, 1590 at 1500 ms, **6037 at "lie-fi" 6 s**, then rows at 18142. Nothing is drawn meanwhile (the stored shell is only used if the network fails outright).
- **Cause:** `app-shell.ts` `page()` is network-first with the navigation preload; the stored `/` answers only on a thrown fetch.
- **Fix direction:** stale-while-revalidate for `/` (the shell is just a loader and its bundles are content-hashed): answer from the stored shell at once, fetch in the background, let the next launch or a prompt pick up the new build. If a hard "always newest" guarantee is needed, race the network against a 300-500 ms timer and fall back to the stored shell. Size: S (one function and its unit test, plus the update rule in finding 9).

### 5. First open of a conversation this device has not seen is a blank page (P, D)

- **Evidence (`open.mjs firstOpen`, Chromium phone):** after tapping an assistant, the header and the composer appear at +72 ms, the body is **blank for 1259 ms at 300 ms latency and 4837 ms at 1500 ms**, with no skeleton and no spinner (`open-firstOpen-1500-mid.png`). When the conversation is open in the app but the session is not attached yet, "Opening the assistant…" shows, then a false "No timeline activity." (`pages.mjs`, open Hatch: settle 871 ms, both texts seen).
- **Cause:** the body renders only attached replica entries; there is no placeholder and no use of the roster's last-reply preview.
- **Fix direction:** reserve the timeline with a few skeleton bubbles from the first frame, show the roster's last reply as the first bubble, and load the newest page first. Size: M.

### 6. Reading position is lost on leave, return and reload (P)

- **Evidence (WebKit phone, `nav2.mjs`, `nav-phone.mjs`, `life.mjs`):** scrolled up 400 px in a conversation, went back and reopened: `scrollTop` 0 (the bottom of the column-reverse list). After reload, also 0. The roster's own scroll is kept (355 stays 355 after a round trip; 120 stays 120 after a tab round trip). Only the last conversation stays mounted (`.lab-timeline-scroll` count: 2, one hidden), so switching between assistants also resets.
- **Cause:** the conversation pane is one slot swapped by assistant; a hidden pane is `display: none`, which discards `scrollTop`; no reading anchor is stored (no `scrollRestoration`, no persisted offset in `useTimelineScroll`).
- **Fix direction:** store per conversation `{lastSeenEntryId, offsetFromTop}` in the device store when leaving or on `pagehide`/`visibilitychange`; restore it before first paint; show a "N new" pill when the anchor is not the bottom. Alternatively hide with `visibility`/`content-visibility` instead of `display: none`. Size: M.

### 7. Late data moves the page (P, D)

- **Evidence (`layout-shift` entries, Chromium):** phone home at 300 ms: **CLS 0.135** (rows insert at 1040, "Other sessions" shifts at 1055); at 1500 ms the same, 0.136. Desktop: **0.038** per warm launch (`lab-session-dock-rail`), **0.090** on a cold launch (`lab-sidebar-section`, then the dock rail 0.087). On WebKit the home goes 3 rows to 6 rows after a second burst (`start-phone-*.json`).
- **Cause:** content is created when the data arrives (finding 1); the rail and sections have no reserved height.
- **Fix direction:** falls out of 1 and 2 (render the stored list once; placeholders keep height); additionally give the dock rail and the section containers a stable min-height. Size: S after 1-2.

### 8. Navigation is a page swap with one-sided animation and no gesture (P)

- **Evidence:** open applies `lab-bot-push` only to the incoming conversation (240 ms, from 32 % right at 40 % opacity); the roster vanishes instantly. Back applies `lab-bot-pop` to the roster from -12 % at 60 % opacity, so a half-transparent page fades over nothing. There are no touch handlers for an edge swipe (`grep touchstart|pointermove` finds drag code only for docks and Ask). Back is `history.back()`, which works (history length grows per open, and `history.back()` returns to the roster; Settings details push `agentRemotePage` entries the same way), so the iOS system edge gesture should work, but it shows no page underneath.
- **Cause:** `bot-workspace.css` 155-170: `data-navigation="push|pop"` animations on one element; the other element is `[hidden]`.
- **Fix direction:** keep both layers visible during the transition (outgoing slides -30 %, incoming from 100 %, with a dim layer), or the View Transitions API on browsers that have it; for an owned swipe-back, a pointer-driven drag on the left 20 px edge that reveals the roster underneath. Size: M. Needs a real iPhone to judge (see below).

### 9. Cost of the first launch after every release (P, D)

- **Evidence:** the `App` chunk is **1.97 MB raw, 583 KB gzip, 475 KB brotli**, loaded lazily after `index` (207 KB) and before anything but the blank ground paints. Cold desktop at 300 ms / 1.5 Mbps: first contentful paint 3364, rows 4025 (`start-desktop-slow.json`). The service worker installs a new build in the background but the launch that discovers it has already loaded the new HTML, so its bundles come from the network, not from the stored shell.
- **Cause:** one chunk holds the whole workbench; the new shell is stored only after the page that needs it.
- **Fix direction:** (a) with finding 4, let the launch use the old stored shell and take the new build on the next launch (the push of a new version is a "restart to update" affordance, never an unprompted reload); (b) split the roster and conversation core from Settings, Trace, Inspector and the code highlighters; (c) draw the logo and ground from `index.html` itself (inline CSS) so the first frame is the app's, not blank. Size: M.

### 10. First-ever visit flashes words, then a blank ground (P, D)

- **Evidence (`start.mjs`, cold):** "Opening Orchard…" for about 40 ms (phone 113-208), then the blank `gateway-workspace-shell`, then the app. On a poor network the sequence stretches to a second of blank. Design decision 4 of I4 says a short wait shows no words.
- **Cause:** with no cached access, `GatewayController` renders `AccessPage('checking')` (the server access page's words, `access-page.ts:30`), then `WorkspaceShell`.
- **Fix direction:** show the same wordless shell for the `checking` state. Size: S.

### 11. Touch chrome is web chrome (P, needs a device to confirm)

- **Evidence (`styles.mjs`, WebKit):** every element reports `user-select: text`, including roster rows, tab labels, titles and buttons; icon buttons, the roster, the composer and messages use the default tap highlight `rgba(0,0,0,.4)` (only rows and tabs set it transparent); `touch-action: auto` on all list and chrome elements; the viewport meta has no `maximum-scale` or `user-scalable`. Only the send button sets `user-select: none` and `touch-action: none`.
- **Effect on a phone:** a long press on chrome can start text selection and the magnifier instead of a context menu; a grey flash on tap; a double tap on a row or message can zoom the page.
- **Fix direction:** global `user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; touch-action: manipulation` on the shell, and opt in (`user-select: text`) for message content, code, inputs and details. Size: S.

### 12. Chunk failure and update recovery cost time and place (P, D)

- **Evidence (code, `chunk-recovery.ts`, `app-shell.ts`):** a failed lazy chunk retries after 0.5, 1.5 and 4 s (6 s of nothing), then reloads the page once (session-storage guard), then throws. A reload keeps the URL, the open assistant and the draft (verified: the draft shows in the roster row and the composer after `reload`), but not the scroll, focus or any open sheet. A new worker takes over at once (`skipWaiting`) and deletes older caches, so an open page that lazily loads a later chunk from the old build can fail into this path.
- **Fix direction:** make the new build wait for the next launch (finding 9a) so the running build never loses its chunks; keep a reading anchor (finding 6) so a recovery reload lands on the same line. Size: S-M.

### 13. Desktop installed app (D)

- Verified in headless Chromium only: the same data gating (findings 1, 2, 7). The manifest asks for `window-controls-overlay`; `shell/panels.css` marks the bar `app-region: drag` and `installed-desktop.spec.ts` exercises it with a modelled overlay. The real standalone window (title-bar drag, controls overlap, resize with a full-height sidebar) is not verifiable headless.
- Desktop opens in Window mode with an empty tile and "Create a group…" copy before data (finding 2). Settings > Computers jumps are being fixed elsewhere and are not repeated here: in this audit Computers > host shows "Checking smart reading…" and "Checking…" for about 380 ms on a 300 ms network, so reserve their space as well.

### Things that pass (so the plan does not touch them)

- Resume from background (`life.mjs`): 4 requests (`/auth/status`, push subscriptions, windows), no frames changed, no shift; the lease check holds traffic instead of reattaching sessions.
- Dark theme: the ground is dark from the first frame (9 ms); no light flash.
- Navigation between already-loaded pages: first change 30-60 ms, zero layout shift (`pages.mjs`: Assistants, Windows, Me, Advanced, back, search, details).
- Composer font is 16 px (no focus zoom there); one WebSocket at home; 337 DOM nodes at home; reduced motion is honoured in the push/pop rules.
- Drafts survive reload and show as "Draft …" in the roster row.
- Settings sections push a history entry and `history.back()` returns to the list; deep links open the conversation with a Back button.

## Controlled inputs whose value round-trips through a lagging owner (IME audit)

The question card's bug (fixed on `fix/question-ime`, 9a340cad) needs three things: a controlled field; a value that the owner hands back after a render of its own (state in a parent, published through the conversation-surface contribution, then a portal re-render); and a render in between that writes the old value into the field while an input method composes. Every text input and textarea in `packages/agent-remote-lab/src` and `packages/agent-client-web/src` was traced to its value source.

- **At risk, now fixed:** `QuestionCard` custom answer, value from `questionDrafts` owned by `SessionDocks`/`owner-input.ts` (App state) or `SessionConversation`/`SideConversation` (`setQuestions`), then through `ConversationSurface` and `ConversationTimeline`. These are the only app inputs whose value travels through the registry/portal path.
- **Same shape, safe today because the owner is synchronous:**
  - `AgentComposer` plain textarea (`agent-client-web/src/react/AgentComposer.tsx:191`, `if (controlledDraft !== undefined) currentDraft.text = controlledDraft;` on every render) and the rich `ComposerEditor` (ProseMirror; its layout effect at `ComposerEditor.tsx:196-201` rewrites the document whenever `props.parts` differs, and `useImageDraft.ts:89-96` rewrites `parts` whenever the owner's `text` changes and differs). Both are correct only because the owner is `DraftStore` read through `useSyncExternalStore` (`draft-store.ts`, `DraftComposer.tsx`, `LabWorkbench.tsx:72`), which notifies inside the typing event. The fallback `props.messageDraft` / `onMessageDraftChange` branch (`DraftComposer.tsx:6`, `LabWorkbench.tsx:72`) hands an owner-supplied string to the same code and would break the same way with any owner that publishes late; no production caller uses it today (only a store binding is passed). Recommendation: delete the unbound branch, or give `AgentComposer` the same "render from your own state, accept the owner's only when it changed on its own" rule as the question card, with a test that drives composition through a lagging owner.
  - `AskDraft` (`features/team/AskConversation.tsx:124`): `useBoundDraft` store, synchronous.
  - Shared multi-device drafts (`conversation/shared-draft-sync.ts`): a remote draft is applied only while the composer has nothing unpublished (`clean()`), so typing is not overwritten; the one window is a composition that starts when the text still equals the last agreed text (clean) and a newer remote draft arrives within the first keystroke. Low risk, worth a unit test.
- **Safe (local `useState`, changed inside the event):** `FormCard` fields and `PlanApprovalCard` feedback (note: both lose their text if the card remounts, unlike the question card whose drafts persist in the owner), `RoomView`, `TimelineSearch`, `SessionReferences` filter, `SessionDirectory` search, `SessionConfiguration` cwd/model (value is the parent sheet's own state, updated in the same event), `WorkspaceFolderPicker`, `WindowToolbar` title, `WindowWorkspaces` rename, `RenameSessionDialog`, `FavoriteDialog`, `BotActions` label, `GroupSheets` name, `MemoryList`, `MissionEditor`, `BoardList`, `BotAudit` numbers, `HostPairing` filter, `SessionLink` paste, `TraceView` search.
- **Other IME hazard to keep in mind:** `ComposerEditor key={editorIdentity}` and the plain-to-rich switch (`richEnabled` depends on `capabilities`) remount the field; a remount while composing drops the composition. Today `imageDraftBinding` makes `richEnabled` true from the first render in the app, so the switch does not happen, but a change of `editorIdentity` mid-session (succession, handoff) would.

## Fix plan

**Step 1. Render from local state; never a loading replacement (findings 1, 2, 3, 7, 10, 5 in part).** This is the shared pattern; most of the "unstable" feeling goes here.
1. Split `accessReady` into `canRead` (a stored lease exists) and `canWrite` (confirmed); the roster, window workspace and device-store reads use `canRead`; sends and mutations keep `canWrite` and queue otherwise. Size M-L.
2. `Loadable` (`unknown | loaded`) for every list with empty copy; sweep the empty-state keys. Size M.
3. Wordless shell for the first-visit `checking` state. Size S.
4. Honest status in words on the page when stale or offline ("Offline, showing saved chats"), reusing the device-link notice. Size S.
Exit check: warm launch at 1500 ms shows stored rows at the first frame, CLS under 0.02, and an offline launch lists the stored chats and opens one.

**Step 2. Launch never waits for the network (findings 4, 9, 12).**
1. Stale-while-revalidate for `/` in the service worker; the new build takes over on the next launch with a quiet "Update ready" row in Settings, never a reload under the person's hands. Size S-M.
2. Split the `App` chunk (roster and conversation core first); inline logo and ground in `index.html`. Size M.
3. Re-run the lie-fi and 1500 ms profiles; target shell under 100 ms at any latency.

**Step 3. Navigation stack keeps views and the reading place (findings 6, 8, 5).**
1. Persist and restore a reading anchor per conversation; keep the previous conversation mounted with `visibility`/`content-visibility` rather than `display: none` if memory allows. Size M.
2. Two-layer push/pop transition and, if wanted, an owned edge-swipe back. Size M.
3. Skeleton bubbles and the roster preview as first bubble for an unseen conversation; newest page first. Size M.

**Step 4. Touch chrome (finding 11) and IME hardening.** Global `user-select`/tap-highlight/`touch-action` rules with opt-ins (S); `AgentComposer` and `ComposerEditor` render from their own state with a lagging-owner composition test, drop the unbound draft branch (S-M).

**Order:** 1 before 3 (anchors and skeletons assume local-first reads), 2 independent of 1 and can run in parallel, 4 any time.

## Only a real iPhone can confirm

- Keyboard: `interactive-widget=resizes-content` is ignored by WebKit ("Viewport argument key ... not recognized"); the composer relies on `useVisualViewport.ts` setting `--lab-viewport-height/top`. Headless WebKit has no on-screen keyboard, so "composer stays above the keyboard, no jumps" is unverified, as is the scroll-into-view of the caret and the behaviour with the Chinese IME candidate bar.
- Safe areas and `viewport-fit=contain`: `env(safe-area-inset-*)` is 0 in emulation; whether the standalone web view already stops above the home indicator and below the status bar (`apple-mobile-web-app-status-bar-style: default`) and what the landscape insets are.
- Standalone behaviour: the system splash colour (the manifest has one light `background_color`; dark users may see a light splash), process eviction and cold start after hours in the background, bfcache and the service worker's life, the edge-swipe back against the history entries, rubber-band at the top of the roster (`overscroll-behavior: none` on `html/body`, but the scrollers use `contain`), text selection callout, double-tap zoom, tap highlight, status-bar tint, the app badge and push permission.
- Storage: the ITP seven-day rule is addressed by `keepInstalledAppStorage()`; whether WebKit grants it is device-only.
- Desktop installed window: window-controls-overlay geometry and drag regions, title-bar overlap, resize.

## Not covered

Settings > Computers jumps and the question card's IME (other agents). Approvals and attachment previews were checked only through code and existing component suites, not for loading behaviour. Real-network (Cloudflare) latency and a large account (hundreds of sessions) were not measured; the local instance has six sessions, so every number here is a lower bound for the gating cost and an upper bound for layout shift per row.
