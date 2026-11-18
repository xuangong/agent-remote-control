# Workbench state

The Workbench decides what to show in pure modules under `packages/agent-remote-lab/src/state`. React hooks and `App.tsx` are the shell: they hold the browser objects (sockets, timers, storage, the DOM), dispatch events into a module, and run the effects it returns. A module imports no React, DOM, timer or storage; its input is data and its output is data. Every module declares its contract at the top of its file, has a unit table beside it (`*.test.ts`, node environment, mock data from `src/test/window-builders.ts`), and each unit test runs in single-digit milliseconds.

A rule has one owner. A change to a rule runs that module's table and nothing else: `pnpm test:unit agent-remote-lab src/state/<module>` (about 0.5 s, including start-up). A change to wiring runs the whole-app composition tests that mount `App`.

| Module | Owns | Shape | Shell |
|---|---|---|---|
| `panels` | Which surfaces are open: compact drawer, desktop sidebar and page, inspector, header, Workbench or Trace view, the sessions panel. Layout changes, focus-return and favorites-refresh effects | `reducePanels(state, event)` returns the next state and effects as data; selectors `contextVisible`, `pageOpen`, `supportingRailOpen`, `windowStageVisible` | `hooks/usePanels.ts` |
| `creation-choice` | The Host and provider the New session form targets; why creation is unavailable (requested Host, loading, offline, quota, no providers); restoring the Host a link or the remembered session names | Pure functions over the Host list, the catalog and the restored identity | `App.tsx` |
| `pane-folding` | How a pane folds, sleeps, closes and restores: bots fold where they stand, compact layouts do not fold, a missing session never folds, restoring selects the pane and wakes a sleeping bot | Pure decisions returning Window operations | `App.tsx` calls `authority.operate` |
| `quote-targets` | Which views the selected messages can be quoted into | Pure projection of Windows | `App.tsx` |
| `quote-selection` | The selection of messages being quoted, its busy and error state, and the notice after quoting | `reduceQuote(state, event)` | `hooks/useSyncReducer.ts` |
| `source-currency` | Whether the session an Ask, Side or quote was captured from is still what its view shows | `viewStaleness`, `fixtureStaleness` over a binding lookup | `App.tsx` |
| `draft-ownership` | Which stored draft a pane's composer reads and writes; managed panes keep their origin session's draft | `paneDraftOwners`, `storeFor` | `App.tsx` |
| `mode-steps` | Work queued for when a Workbench mode is in front: dropped for another mode, held until the Window is confirmed | `drainModeSteps` | `App.tsx` |
| `palette-actions` | Which commands the palette offers, in what order, and what each does first | `paletteActions(facts, runs)` | `App.tsx` |

Other rules the Workbench already kept in pure modules beside `App.tsx` and that are unchanged: `live-budget`, `bot-roster`, `window-composition`, `window-fold`, `composition-views`, `composer-draft-owner`, `side-tree`, `session-composition*`. The succession rules live in `agent-client` (`reduceRefresh` and the rest of `agent-client/src/succession`).

## Rules for adding to a module

1. Write the contract at the top of the file before the code: inputs, outputs, ordering, errors.
2. Add the table-driven test beside it. Name the rule in the title; use builders, never a mounted `App`.
3. Run the mutation check: break each rule once, see the new test fail, list the old whole-app tests that fail under the same break, and delete an old test only if every break it catches is caught by the new one and its subject is the rule rather than the composition.
4. Keep the shell thin: no rule in a hook; if a hook needs an `if`, the module is missing an event.
