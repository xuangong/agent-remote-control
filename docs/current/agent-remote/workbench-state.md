# Workbench state

The Workbench decides what to show in pure modules under `packages/agent-remote-lab/src/state`. The shell is the hooks under `src/app` (`use*.ts`, one per concern, composed in order by `App.tsx`) and the views under `src/app/views`: they hold the browser objects (sockets, timers, storage, the DOM), dispatch events into a module, and run the effects it returns. A module imports no React, DOM, timer or storage; its input is data and its output is data. Every module declares its contract at the top of its file, has a unit table beside it (`*.test.ts`, node environment, mock data from `src/test/window-builders.ts`), and each unit test runs in single-digit milliseconds.

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
| `session-binding` | Where opening a session lands when a view or bot already holds a conversation (rule 6): focus the visible one, return to the parent, bind in place, select the existing bot view or open beside | `focusesVisibleSession`, `returnsToParent`, `bindPlan` | `app/useSessionOpening.ts` |
| `letter-navigation` | Where following a letter between two sessions leads: the other endpoint, the title of a participant, the shared Window's view plan and the stack plan of a plain layout | `otherEndpoint`, `participantTitle`, `windowLetterPlan`, `stackPlan` | `app/useCommunicationsAndForks.ts` |

Other rules the Workbench already kept in pure modules beside `App.tsx` and that are unchanged: `live-budget`, `bot-roster`, `window-composition`, `window-fold`, `composition-views`, `composer-draft-owner`, `side-tree`, `session-composition*`. The succession rules live in `agent-client` (`reduceRefresh` and the rest of `agent-client/src/succession`).

## Rules for adding to a module

1. Write the contract at the top of the file before the code: inputs, outputs, ordering, errors.
2. Add the table-driven test beside it. Name the rule in the title; use builders, never a mounted `App`.
3. Run the mutation check: break each rule once, see the new test fail, list the old whole-app tests that fail under the same break, and delete an old test only if every break it catches is caught by the new one and its subject is the rule rather than the composition.
4. Keep the shell thin: no rule in a hook; if a hook needs an `if`, the module is missing an event.
