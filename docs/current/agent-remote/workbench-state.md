# Workbench state

The Workbench decides what to show in pure modules under `packages/agent-remote-lab/src/state`. The shell is the hooks under `src/app` (`use*.ts`, one per concern, composed in order by `App.tsx`; `useSessionOpening`, `useCommunicationsAndForks` and `useSideNavigation` are composers that call their concern hooks in the order of the original function), each with a hook test on a mock scope (`src/test/render-hook.tsx`) and the views under `src/app/views`: they hold the browser objects (sockets, timers, storage, the DOM), dispatch events into a module, and run the effects it returns. A module imports no React, DOM, timer or storage; its input is data and its output is data. Every module declares its contract at the top of its file, has a unit table beside it (`*.test.ts`, node environment, mock data from `src/test/window-builders.ts`), and each unit test runs in single-digit milliseconds.

A rule has one owner. A change to a rule runs that module's table and nothing else: `pnpm test:unit agent-remote-lab src/state/<module>` (about 0.5 s, including start-up). A change to wiring runs the whole-app composition tests that mount `App`.

| Module | Owns | Shape | Shell |
|---|---|---|---|
| `panels` | Which surfaces are open: compact drawer, desktop sidebar and page, inspector, header, Workbench or Trace view, the sessions panel. Layout changes, focus-return and favorites-refresh effects | `reducePanels(state, event)` returns the next state and effects as data; selectors `contextVisible`, `pageOpen`, `supportingRailOpen`, `windowStageVisible` | `hooks/usePanels.ts` |
| `creation-choice` | The Host and provider the New session form targets; why creation is unavailable (requested Host, loading, offline, quota, no providers); restoring the Host a link or the remembered session names | Pure functions over the Host list, the catalog and the restored identity | `app/useProviderCreation.ts`, `app/useRemoteHostState.ts` |
| `pane-folding` | How a pane folds, sleeps, closes and restores: bots fold where they stand, compact layouts do not fold, a missing session never folds, restoring selects the pane and wakes a sleeping bot | Pure decisions returning Window operations | `app/useSessionViewPresentation.ts` calls `authority.operate` |
| `quote-targets` | Which views the selected messages can be quoted into | Pure projection of Windows | `app/useQuotesAndReferences.tsx` |
| `quote-selection` | The selection of messages being quoted, its busy and error state, and the notice after quoting | `reduceQuote(state, event)` | `hooks/useSyncReducer.ts` |
| `source-currency` | Whether the session an Ask, Side or quote was captured from is still what its view shows | `viewStaleness`, `fixtureStaleness` over a binding lookup | `app/useFocusedAsk.ts` |
| `draft-ownership` | Which stored draft a pane's composer reads and writes; managed panes keep their origin session's draft | `paneDraftOwners`, `storeFor` | `app/useViewSessionState.ts` |
| `mode-steps` | Work queued for when a Workbench mode is in front: dropped for another mode, held until the Window is confirmed | `drainModeSteps` | `app/useCommandSearch.ts` |
| `palette-actions` | Which commands the palette offers, in what order, and what each does first | `paletteActions(facts, runs)` | `app/useCommandSearch.ts` |
| `side-layout` | Which Side sessions a source shows, the document's selection, what a change of selection means for a shared Window (select or attach steps) and for a local document (edges), and following a replaced Side | Pure functions over session keys and lookups; `selectionSteps` returns steps as data | `app/useSideSelection.ts`, `app/useSessionTitles.ts` |
| `attention-targets` | Which sessions attention watches and shows, the sessions a person is reading, where a notification leads, and where Bot mode finds sessions that are not bots | `attentionSets`, `readableSessions`, `attentionDestination`, `botDirectorySources` | `app/useAttentionAndRoster.ts` |
| `session-titles` | How a confirmed title reaches the lists, the Window and the bot group; which sessions are asked for a native title | `confirmTitle`, `retitleSessions`, `titledSessions`, `windowProjectionTitles`, `groupProjectionTitles` | `app/useSessionTitles.ts` |
| `session-binding` | Where opening a session lands when a view or bot already holds a conversation (rule 6): focus the visible one, return to the parent, bind in place, select the existing bot view or open beside | `focusesVisibleSession`, `returnsToParent`, `bindPlan` | `app/useSessionBinding.ts` |
| `letter-navigation` | Where following a letter between two sessions leads: the other endpoint, the title of a participant, the shared Window's view plan and the stack plan of a plain layout | `otherEndpoint`, `participantTitle`, `windowLetterPlan`, `stackPlan` | `app/useLetterNavigation.ts` |
| `ask-visibility` | Which sessions have an Ask, which of them the page watches (shown or live), when an Ask may restore, and why the Ask launcher is disabled | `askSourcesOf`, `askActivityOf`, `askRestoreAllowed`, `askUnavailableReason` | `app/useAskActivity.ts`, `app/useFocusedAsk.ts`, `app/useQuotesAndReferences.tsx` |
| `child-session-plan` | How a subagent opens: beside its parent or in its place, which open session is its direct parent, the opened child, and whether a late answer is still wanted | `childOpensBeside`, `knownChildOf`, `directParentOf`, `besideChildSession`, `replacingChildSession`, `childRequestCurrent` | `app/useChildSessions.ts` |
| `agent-creation` | When a session may be created or resumed, which reservation a retry reuses, how a failure is classified (release, notice, line, bot sheet), the resumed session, the quota | `mayCreate`, `reservationFor`, `planningOption`, `classifyCreationFailure`, `mayResume`, `resumedSession`, `sessionQuotaReached` | `app/useAgentCreation.ts`, `app/useProviderCreation.ts` |
| `fork-plan` | How `/fork`, `/side` and `/ask` become a session: the route of the command, the attempt key, the options of the new session, the forked session, the first input | `forkCommandRoute`, `forkKey`, `forkSettings`, `forkCreateOptions`, `withForkContext`, `forkedSession`, `firstInputPending` | `app/useForks.ts` |
| `quote-flow` | Whether a quote may start, the id of a created destination, the options of a new destination session, where the quote lands | `quoteStart`, `quoteCreationId`, `quoteSessionOptions`, `quoteLanding` | `app/useQuotesAndReferences.tsx` |
| `succession-gates` | When a command may go out, which actions a session offers, when the main conversation offers Handoff, what unsent messages block, when a Handoff holds the conversation, and whether a settled Handoff still matches its view | `commandRefusal`, `conversationActionsAvailable`, `canHandoffPrimary`, `handoffInputBlocker`, `primaryHandoffGated`, `successionAccessible`, `handoffCompletionMatches` | `app/useSendingAndSuccession.tsx` |

Other rules the Workbench already kept in pure modules beside `App.tsx` and that are unchanged: `live-budget`, `bot-roster`, `window-composition`, `window-fold`, `composition-views`, `composer-draft-owner`, `side-tree`, `session-composition*`. The succession rules live in `agent-client` (`reduceRefresh` and the rest of `agent-client/src/succession`).

## Rules for adding to a module

1. Write the contract at the top of the file before the code: inputs, outputs, ordering, errors.
2. Add the table-driven test beside it. Name the rule in the title; use builders, never a mounted `App`.
3. Run the mutation check: break each rule once, see the new test fail, list the old whole-app tests that fail under the same break, and delete an old test only if every break it catches is caught by the new one and its subject is the rule rather than the composition.
4. Keep the shell thin: no rule in a hook; if a hook needs an `if`, the module is missing an event.

## Whole-app tests and their owners

A whole-app test (`src/App*.test.tsx`) stays only when it checks composition: several modules, the shell and the DOM together. The check that decides, for a rule that now has a module: break the module one line at a time (`===`/`!==`, `&&`/`||`, `>=`/`<`, `!`, `??`, `.some`/`.every`, `true`/`false`), run the module's tests, and run the old whole-app tests that touch the rule for every mutation. An old test may go only if every mutation it catches is caught by the module's tests and what else it asserts has a named owner.

| Module (mutations) | Mutations the unit tests catch | Old whole-app tests that catch a mutation the unit tests miss |
|---|---|---|
| `ask-visibility` | 18 of 19 (1 equivalent) | none |
| `child-session-plan` | 18 of 23 (5 equivalent defaults) | none |
| `agent-creation` | 26 of 31 (5 equivalent) | none |
| `fork-plan` | 22 of 25 (3 equivalent defaults) | none |
| `quote-flow` | 9 of 11 (2 equivalent) | none |
| `succession-gates` | 90 of 90 | none |
| `handoff-command` | 2 of 2 | none |
| `agent-client` `reduceRefresh` / `settlementOf` / `sessionSuccessionHistory` | 35 of 40 / 23 of 26 / 40 of 49 | none after a gap in the history table was closed (a chain that returns to a session, and an unknown session asked for with history intent) |
| `useAgentCreation` hook | 26 of 35 | none (the double activation test, deleted, caught 3 mutations and the hook and module tests catch all 3) |
| `useSessionSuccession` effects (`hooks/useSessionSuccession.effects.test`, 25 tests, fake ports and clock) | 18 of 30 (12 survive: 2 redundant guards that must fail together, 4 limits and guards of the replay read, the resume of image recipients, the abort that the sequence check already covers, the evidence restore, the attach effect while discovering, the refresh wait deadline, the authority reset) | none: the 8 mutations an old test catches (mount discovery, the feed hint, the stale retry, the rediscover effect, the attach once rule, the attach-failure report, the settlement deadline, the live-budget release) are all caught here |
| `useQuotesAndReferences` hook (`app/useQuotesAndReferences.test`, 17 tests) | 21 of 24 (3 equivalent: a client for another Host, a missing directory, the capture time) | none: the 7 mutations an old test catches are all caught here |

Deleted, each after that check: `App.succession` "keeps the Handoff chooser available while pending input blocks preparation" (owners `succession-gates`, `useSendingAndSuccession.test`, `SessionSuccessionDialog.test`), "rejects malformed Handoff provider arguments" (2 tests; owners `handoff-command.test`, `useSendingAndSuccession.test`) and `App.test` "starts only one Agent transition when the create control is activated twice before rerender" (owners `agent-creation.test`, `useAgentCreation.test`).

Deleted after the hook tests above: `App.succession.opening-and-refresh` "waits for the original native session to recover after a %s handoff" (calls `refreshSettled` on the hook; the mutations it catches, the discovery on mount and the settled-discovery sequence, are caught by `useSessionSuccession.effects.test` "after a cancelled Handoff reads again and settles", which also holds the wait while the session recovers) and `App.succession.handoff-and-discovery` "keeps ordinary fixed navigation available when initial HTTP discovery reports unsupported %s" (its mutations, the discovery on mount and the rediscover effect, are caught by the "route_not_found" test; the reducer table owns the rule).

Not deleted although the owner catches everything the old test catches: the tests below still check wiring or UI that has no unit owner yet. The next cut is a view-model test for the Handoff command list of docks and Team members.

The hook mutation check (30 mutations of `useSessionSuccession`, 24 of `useQuotesAndReferences`, one line each, all reverted): an old test catches a mutation the hook tests miss in no case. Mount discovery is caught by 138 old tests, so the count says nothing about a test's subject; each old test is judged by the rule it names. Two mutations are caught by the hook tests only as a hang under the outer deadline (the live-budget release and the settled-discovery sequence).

### The 161 `App.succession` tests

100 test declarations, 161 tests before this step, 156 now. Each line: file and line, tests the declaration runs, name, disposition.

#### Window, Track and owner stores: 46 tests, 0 deleted, 46 kept

Kept: each test mounts the App with the Window document, the composition document and several owner stores (drafts, outbox, image lifetimes) and checks how they persist and fall back together, which no single module owns. Owners: `session-composition-model`, `window-composition`, `draft-ownership` unit tables; `useSessionSuccession.window.test`.

- `ask-and-reconnect:21` (1) keeps post-upgrade view preferences and owners when opening the same Window in a new tab — kept
- `ask-and-reconnect:375` (1) persists adopted Window mappings across reload without changing native owners or Ask references — kept
- `ask-and-reconnect:567` (1) keeps both primary conversations mounted with separate drafts and creates an empty dock without a primary sele — kept
- `handoff-and-discovery:412` (1) commits the first role Track view before a later role participant fails — kept
- `handoff-and-discovery:443` (2) rejects an accepted but queued Track publication after %s without native observation — kept
- `handoff-and-discovery:534` (1) restores a selected Side path and focus while the primary changes from A to B — kept
- `handoff-and-discovery:570` (2) retains a completed old-source creation before rejecting new configuration, input and navigation after %s chan — kept
- `owners-and-attachment:23` (1) rejects a retired source after awaiting Ask relations before creating any native target — kept
- `owners-and-attachment:46` (2) retains independent B stores and selected Track through an Ask %s before publishing the role — kept
- `owners-and-attachment:146` (1) keeps A outbox, question drafts and reading cursor concrete through B confirmation and explicit A history — kept
- `owners-and-attachment:196` (3) preserves %s composition bytes without attaching the saved predecessor — kept
- `owners-and-attachment:205` (1) retains desired B and the editable owner when the composition checkpoint cannot be saved — kept
- `owners-and-attachment:220` (1) permanently retires primary image lifetimes across page resume and same-native recovery — kept
- `owners-and-attachment:268` (1) opens retained B and the role through local view entries without sharing their owners or replacing the native  — kept
- `owners-and-attachment:356` (2) restores the legacy Side primary without overriding explicit history intent %s — kept
- `owners-and-attachment:370` (2) restores the selected Window owner while a new %s Window keeps independent owners — kept
- `owners-and-attachment:414` (1) reattaches a restored Side to its new runtime binding while preserving the view and draft owners — kept
- `owners-and-attachment:438` (1) reopening an attached Side preserves its existing draft owner despite an unowned legacy slot — kept
- `owners-and-attachment:474` (2) leaves a focused unlinked Side through %s navigation and keeps its independent view — kept
- `owners-and-attachment:567` (1) retries a transient composition import failure through the synchronization button and restores shared owners — kept
- `windows-and-teams:21` (4) opens a %s session beside the selected bot as a new primary group and keeps every other group — kept
- `windows-and-teams:82` (1) selects another primary group while a native attachment is pending without restoring stale selection — kept
- `windows-and-teams:116` (2) opens the global directory selection in a focused empty dock, or beside a focused dock bot (empty=%s), without — kept
- `windows-and-teams:145` (2) uses the focused mobile dock for Favorites context, opening beside a dock bot (empty=%s) — kept
- `windows-and-teams:269` (1) rejects Track replacement of the selected managed view without changing primary — kept
- `windows-and-teams:291` (1) opens Track beside a dock bot whose replacement is still saving, leaving that dock to its own save — kept
- `windows-and-teams:224` (7) opens Track into the selected empty $placement view, or beside a bot there, and preserves primary — kept

#### Native attachment and recovery: 40 tests, 0 deleted, 40 kept

Kept: each test drives a fixture socket, the real RemoteSessionClient, the succession hook and the view state together, with the real deadlines made inputs. Owners: `RemoteSessionClient` tests in `agent-client`; `useSessionSuccession.effects.test` for attach and binding.

- `ask-and-reconnect:49` (1) keeps a synchronized native binding alive while composition replay is pending — kept
- `ask-and-reconnect:98` (3) keeps a matching session alive while %s is still recovering — kept
- `ask-and-reconnect:133` (1) reconnects automatically when the initial snapshot does not arrive before the public deadline — kept
- `ask-and-reconnect:153` (1) clears an identity error as soon as a matching snapshot arrives while history is still pending — kept
- `ask-and-reconnect:170` (1) retires a slow attachment when navigating away and ignores its late identity updates — kept
- `handoff-and-discovery:244` (1) access suspension keeps hot B ownership and resumes only after authoritative recovery — kept
- `handoff-and-discovery:356` (2) keeps the opaque draft editable and refuses native input for snapshot identity %s — kept
- `handoff-and-discovery:364` (1) confirms only B through the real session channel in StrictMode and keeps its view during native recovery — kept
- `opening-and-refresh:16` (3) keeps sharing the selected session while %s — kept
- `opening-and-refresh:42` (1) retains a local resume command for a session that cannot be opened — kept
- `opening-and-refresh:57` (2) keeps native takeover visible from failed initial binding %s until explicit takeover is confirmed — kept
- `opening-and-refresh:91` (1) retains an uncertain initial takeover and checks status without repeating the interruption — kept
- `opening-and-refresh:116` (1) shows exact cached content while replay and native attachment wait without granting control — kept
- `opening-and-refresh:141` (1) retains edits made beside cached content before initial checks and native attachment finish — kept
- `opening-and-refresh:170` (1) retains the selected session draft while cached navigation waits for checks and binding — kept
- `opening-and-refresh:204` (1) opens a selected session beside with its cached content at once, and an uncached one without content — kept
- `opening-and-refresh:233` (1) keeps already visible content during workspace access recovery with no usable native binding — kept
- `owners-and-attachment:243` (1) reconciles metadata on page resume without retrying an HTTP attachment failure — kept
- `owners-and-attachment:254` (1) reports a failed attachment once in the workbench with its Retry action — kept
- `owners-and-attachment:325` (2) rejects an explicit %s view without a native fallback or retry attachment — kept
- `owners-and-attachment:340` (1) reselecting an explicitly failed view retains its error until Retry — kept
- `ask-and-reconnect:244` (4) fences shared prompt editing from $initial after awaiting $stage over HTTP and WebSocket — kept
- `handoff-and-discovery:580` (8) fences held $operation work from source $initial after its successor is confirmed — kept

#### Refresh, settlement and discovery effects: 27 tests, 2 deleted, 25 kept

Kept: the reducers are unit-owned, and the test checks the hook that runs their effects (timers, attach, the Relay feed). The mutation check found no mutation of `reduceRefresh` (35 of 40 caught by its table) or `settlementOf` (23 of 26) that an old test catches and the tables miss. The effects are now owned by `useSessionSuccession.effects.test`; what stays here is scenario composition with the real transport, the committed-refresh evidence (`refreshCommitted`, not yet mutated in the hook test), the composition saved by a hint, and the Retry UI. Owners: `reduceRefresh`, `settlementOf`, `committedRefreshOf`, `handoffOutcome`, `newerFavoritesHints`, `classifyFailure` in `agent-client/src/succession`.

- `handoff-and-discovery:177` (2) first complete A-B-C discovery retains the origin owners with independent B=%s — kept
- `handoff-and-discovery:208` (2) reopening current B preserves its %s outcome until explicit Retry — kept
- `handoff-and-discovery:286` (1) newer Favorites progress with the same tree revision recovers missed succession once — kept
- `handoff-and-discovery:327` (1) discovers desired B over HTTP before any A attach, retains its owner on failure and retries only explicitly — kept
- `handoff-and-discovery:343` (1) uses C when current advances during initial A enrollment after the discovery page reported B — kept
- `handoff-and-discovery:382` (2) keeps prompt-edit behavior independent of succession history owners: %s — kept
- `handoff-and-discovery:394` (1) treats succession notifications as hints until authorized HTTP recovery completes — kept
- `handoff-and-discovery:522` (1) keeps ordinary fixed navigation available when initial HTTP discovery reports unsupported %s — deleted (owner `useSessionSuccession.effects.test`, `reduceRefresh` table)
- `handoff-and-discovery:528` (1) does not treat authorization-hidden succession as an unsupported transport — kept
- `handoff-and-discovery:557` (1) retains an authorized desired B after its replay endpoint becomes unavailable — kept
- `opening-and-refresh:311` (1) removes handoff navigation when fresh authorized replay is denied — kept
- `opening-and-refresh:324` (1) waits for the selected native successor before reporting a committed refresh complete — kept
- `opening-and-refresh:344` (1) finishes committed recovery when an earlier native attachment synchronizes during replay — kept
- `opening-and-refresh:373` (1) waits for the original native session to recover after a %s handoff — deleted (owner `useSessionSuccession.effects.test`, `settlementOf` table)
- `opening-and-refresh:397` (1) does not complete a committed refresh while its previously confirmed native session is restoring — kept
- `opening-and-refresh:415` (1) allows a manual refresh to confirm the retained source after a native restoration deadline — kept
- `opening-and-refresh:444` (1) keeps the last confirmed locator when a refresh after the feed reopened cannot reach the Relay — kept
- `opening-and-refresh:474` (1) does not restore the confirmed locator after a refresh %s — kept
- `opening-and-refresh:506` (1) retries a failed metadata refresh without retaining its old error on a healthy native binding — kept
- `opening-and-refresh:522` (3) rejects a committed refresh with %s evidence instead of reporting success — kept
- `opening-and-refresh:532` (1) confirms an older committed operation after C while leaving an unrelated selected session alone — kept
- `opening-and-refresh:547` (1) does not verify another role operation through the current historical role evidence — kept

#### History chain navigation: 3 tests, 0 deleted, 3 kept

Kept: the chain rule is unit-owned (`sessionSuccessionHistory`: 40 of 49 mutations caught after one gap was closed, none of the 9 survivors caught by an old test); the test checks the predecessor view, its reloaded content and the owners it keeps. Owners: `sessionSuccessionHistory`, `resolveLocator` in `agent-client/src/succession`.

- `handoff-and-discovery:121` (1) old desktop A notification still opens concrete A history after B and C confirmation — kept
- `opening-and-refresh:249` (1) opens predecessor A from current B, reloads its concrete history and returns to B without moving draft ownersh — kept
- `opening-and-refresh:280` (1) shows A-B-C handoff history once in reverse order while ordinary A navigation still resolves current C — kept

#### Handoff offering, dialog and command: 16 tests, 3 deleted, 13 kept

Kept: the gates (90 of 90 mutations caught), the command parser (2 of 2) and the dialog are unit-owned; the kept tests check the chooser opened from the command, the Host eligibility, the requests it does or does not send, and the restriction of docks and Team members, which the primary gate does not own. The history variant of "does not expose or execute Handoff" is not caught by any `canHandoffPrimary` mutation, so another module gates it. Owners: `succession-gates`, `handoff-command`, `SessionSuccessionDialog.test`, `useSendingAndSuccession.test`.

- `intent:10` (1) lets an offline or retired primary hide and reopen its original Handoff without clearing or replacing it — kept
- `handoff-and-discovery:29` (1) does not silently replace an unavailable requested Handoff provider — kept
- `handoff-and-discovery:43` (1) opens Handoff while the native session is working and respects the Host blocked eligibility — kept
- `handoff-and-discovery:54` (1) keeps the Handoff chooser available while pending input blocks preparation and recovers when cleared — deleted: owners `succession-gates` (`handoffInputBlocker`), `useSendingAndSuccession.test`, `SessionSuccessionDialog.test`
- `handoff-and-discovery:75` (1) refreshes successor context after Composer delivery without waiting for a native timeline echo — kept
- `handoff-and-discovery:112` (2) does not expose or execute Handoff from the %s native view — kept
- `opening-and-refresh:561` (4) hands off a current %s view with pending-input protection and advances every live binding — kept
- `opening-and-refresh:588` (2) does not offer Handoff from an ordinary window restricted by %s — kept
- `opening-and-refresh:595` (1) opens the Handoff chooser from its command, resolves claude and sends no native input — kept
- `opening-and-refresh:607` (2) rejects malformed Handoff provider arguments %s before choosing or sending — deleted: owners `handoff-command.test`, `useSendingAndSuccession.test`

#### Ask: 10 tests, 0 deleted, 10 kept

Kept: the Ask lists and gates are unit-owned (18 of 19 mutations caught, the survivor is equivalent); the old tests catch only mutations the table catches, but each also checks the Ask overlay, its draft and its read state through the tracking hook. Owners: `ask-visibility`, `useAskActivity.test`, `ask-presentation`, `attention-targets`.

- `ask-and-reconnect:186` (1) follows an Ask native prefix with an execution recipient while preserving the association anchor — kept
- `ask-and-reconnect:398` (1) restores an open Ask with its original source after rebinding main and opening a fresh page — kept
- `ask-and-reconnect:446` (1) keeps one global Ask launcher and retains the original Ask draft when another primary root is selected — kept
- `ask-and-reconnect:494` (3) tracks Ask read state from its global presentation when %s — kept
- `ask-and-reconnect:544` (1) opens the global Ask overlay from the foreground session on a narrow screen — kept
- `handoff-and-discovery:470` (1) retains closed and nested Ask owners, and supplies T with its own replaceable native image recipient — kept
- `windows-and-teams:172` (2) keeps the global Ask preference independent of the focused dock and prevents creation from an empty dock (empt — kept

#### Team and bot groups: 16 tests, 0 deleted, 16 kept

Kept: the Team layout and group binding rules are unit-owned in part; the test checks the roster evidence, the managed view, the Track and the owners together. Owners: `team-layout`, `window-composition`, `session-binding`, `useTeamOpening.test`.

- `ask-and-reconnect:215` (1) fences a warm Team main view immediately when its public execution locator disappears — kept
- `ask-and-reconnect:294` (3) restores a cold managed Team window only from public roster evidence: %s — kept
- `ask-and-reconnect:326` (1) edits a real App managed Team window into its retained origin owner and admits input only to the successor — kept
- `windows-and-teams:404` (2) offers Side and Handoff in a Team member view, keeping the member name as its title (handed off: %s) — kept
- `windows-and-teams:517` (1) selects a managed Team view directly for pointer and focus without first selecting primary — kept
- `windows-and-teams:550` (1) keeps the selected shared attached child on repeated pointer and focus without selecting its dock root — kept
- `windows-and-teams:572` (1) opens an existing Team from a managed view by selecting its new ordinary source on mobile — kept
- `windows-and-teams:336` (6) creates $feature from the selected $destination binding without falling back to primary — kept

#### Quotes: 3 tests, 0 deleted, 3 kept

Kept: the start, landing and target rules are unit-owned (9 of 11 mutations caught, the survivors are equivalent) and the old tests catch only those; they also check the selection in the timeline, the excerpt and the next message sent from the target, and they are the only check of the quote bar's destination lists, its attachment chips and the sent frame. The hook test (`useQuotesAndReferences.test`) catches all 7 mutations of the hook they catch (the dock placement, the window edit, the destination of the stored quote, the quoted event, the landing choice, the selected-only excerpt, the select event), so the rules no longer need them; the UI has no unit owner yet. Owners: `quote-flow`, `quote-selection`, `quote-targets`, `useQuotesAndReferences.test`.

- `windows-and-teams:441` (1) quotes messages of several turns selected in one session view into another view, which sends them with its nex — kept
- `windows-and-teams:480` (2) quotes into a session view of the %s — kept

### The other whole-app tests

| File | Tests | Rule and owner | Disposition |
|---|---|---|---|
| `App.test.tsx` | 50 (was 51) | session shell, creation, resume, transport switch: `panels`, `creation-choice`, `agent-creation` (`mayCreate`, `mayResume`, `planningOption`) | 1 deleted (double activation), 50 kept: the App shell on an injected transport |
| `App.children.test.tsx` | 31 | subagents and letters: `child-session-plan`, `useChildSessions.test`, `useLetterNavigation.test`, `letter-navigation` | kept: breadcrumbs, drafts and browser history with the timeline; the old tests catch only mutations the owners catch |
| `App.sharing.test.tsx` | 10 | creation allowance, reservation reuse, Side quota: `agent-creation`, `fork-plan`, `creation-choice` | kept: Host selection and allowance text with the form |
| `App.sides.test.tsx`, `App.side-migration.test.tsx`, `App.unlink.test.tsx` | 2, 2, 3 | Side creation, edited Side, unlink: `fork-plan`, `side-layout`, `useSideUnlinking.test`, `useSideSessions.test` | kept: delivery, layout and configuration with the stored fork |
| `App.tracking.test.tsx` | 24 | tracked views and Sides: `attention-targets`, `side-layout`, `useSideUnlinking.test` | kept: the Track document with attachment |
| `App.bot-mode.test.tsx`, `App.bot-attention.test.tsx`, `App.bot-succession.test.tsx` | 25, 3, 19 | bots: `bot-roster`, `useBotRoster.test`, `attention-targets`, `pane-folding` | kept: Bot mode with groups and succession |
| `App.window-actions.test.tsx`, `App.window-toolbar.test.tsx`, `App.window-fold.test.tsx`, `App.window-retention.test.tsx` | 12, 19, 3, 5 | Window layout: `pane-folding`, `window-composition`, `useOpenWindows.test` | kept: layout and focus in the DOM |
| `App.command-palette.test.tsx` | 6 | `palette-actions`, `mode-steps` | kept: keyboard and focus |
| `App.host-providers.test.tsx`, `App.hosts-page.test.tsx` | 13, 2 | `creation-choice` | kept: Host pages with providers |
| `App.attributions.test.tsx`, `App.tpm.test.tsx` | 5, 7 | attribution targets, TPM: `useTpmMainOpening.test`, `session-binding` | kept: navigation with documents |
| `App.outbox.test.tsx`, `App.shared-drafts.test.tsx`, `App.transport-ownership.test.tsx`, `App.compact-sleep.test.tsx` | 4, 2, 2, 2 | outbox, drafts, transport ownership, sleeping panes: `draft-ownership`, `pane-folding` | kept: persistence across mounts |
| `App.performance.test.tsx`, `App.render-budget.test.tsx`, `App.attach-budget.test.tsx` | 1, 3, 1 | render and attach budgets of the whole App | kept: they measure the composition itself |
