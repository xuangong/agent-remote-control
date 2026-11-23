# Open items

Every shortfall of a finished step is tracked here, one file per item (`O<n>.md`), with the step that owns it and its status.
The list began as section 10 of the [target architecture](../specs/2026-11-18-target-architecture-and-tests.md); section
numbers in an item refer to that document.

- **Open an item** as a new file, numbered after the highest item here and on `main`: its title, three fields, then the item
  with its evidence.
- **Close or move an item** in its own file, in the commit that does it: the `Status` field starts with `open`,
  `partly closed` or `closed`, and the `Status` section says what was done and how it was checked.
- **The table below is generated** from the files, and task branches never edit it: `pnpm postmerge` writes it on `main`
  after a merge, and `pnpm open-items` prints it on any branch. Two branches that took the same number meet as an add/add
  conflict on that file when the second merges; that branch renumbers its item.

An item file:

```markdown
# O61: <title>

- Found in: <the step, gate or run that found it>
- Owner step: <the step or person that owns it>
- Status: open

## Item

<what is wrong, with its evidence>

## Status

open
```

<!-- open-items:start (generated from the item files by scripts/open-items.mjs; pnpm postmerge writes it on main) -->
5 open, 5 partly closed and 58 closed.

| # | Item | Found in | Owner step | Status |
|---|---|---|---|---|
| [O1](O1.md) | The relay-core package run did not get faster | M11 | M12 | closed |
| [O2](O2.md) | The Controller's slowest files are disk and fsync bound, not Relay bound | M11 | M12 | closed |
| [O3](O3.md) | Only 10 duplicate tests were deleted in M11 | M11 | M12 | closed for the decision |
| [O4](O4.md) | The teams and Call For Support wiring is still in `broker.ts` | M11 | M12 | closed |
| [O5](O5.md) | The browser socket edge is still in `broker.ts` | M11 | M12 | closed |
| [O6](O6.md) | 46 `session-succession-runtime` tests still start a real `createHostBroker` | M11 | M12 | closed |
| [O7](O7.md) | Four relay-core `cross-package-relative` exceptions | M11 | M12 | closed in M12 |
| [O8](O8.md) | Smoke scenarios M4, M5 and M8 need journal limits and a separately stoppable Controller | M4 | M12 | closed |
| [O9](O9.md) | The Worker tier still has 157 tests against a target of about 20 | M3 | M12 or later | closed |
| [O10](O10.md) | Far fewer duplicates were deleted than estimated in M5 to M9 | M5 to M9 | M13 | closed |
| [O11](O11.md) | The Controller's session-core modules read shared state through a typed context | M10 | later | closed |
| [O12](O12.md) | Slow-test enforcement is opt-in | M0 | M12 | closed |
| [O13](O13.md) | Privacy display-lease decision | M8 | owner | open |
| [O14](O14.md) | The transport tier in the seams package is 108 tests against a target of about 30 | M8 to M11 | M12 | closed |
| [O15](O15.md) | `App.tsx` is 3,649 lines against the target of 2,000 | M13 | M13b | closed in M13b |
| [O16](O16.md) | State rules still inside `AppContent` with no module | M13 | M13b | closed |
| [O17](O17.md) | 18 Workbench test files start a real listener and are relabelled `.transport` | M13 | M14 | closed |
| [O18](O18.md) | The 160 `App.succession.*` tests were not mapped test by test | M13 | M13b | closed |
| [O19](O19.md) | 20 Workbench and 6 debugger `cross-package-relative` exceptions remain | M13 | M14 | closed |
| [O20](O20.md) | The smoke probe fails when the instance's Window already holds another view | M13 | M14 | closed in M14 for the probe |
| [O21](O21.md) | The 30 hooks of `src/app` are cut where the old function could be cut, so several mix concerns | M13b | M14 | closed |
| [O22](O22.md) | On the e2e stack the page's 'Take control' did not return control from a terminal | M14 | M15 | closed |
| [O23](O23.md) | E5, E7 and E8 are not written | M14 | M15 | partly closed in M15 |
| [O24](O24.md) | With smart reading off for a provider, a Controller restart moved a reader to the first row | M14 | M15 | closed |
| [O25](O25.md) | No Playwright spec was deleted or rewritten as a unit or seam test | M14 | M15 | partly closed |
| [O26](O26.md) | Smoke M1 (full profile, 1,500 ms and 10% loss, seed 48323) showed no rows in 90 s | M14 | M15 | closed |
| [O27](O27.md) | The page shows nothing when the code-split `App` chunk fails to load once | M14 | M15 | closed |
| [O28](O28.md) | A second tab or a later open of a session in a shared Window shows 'Session composition needs synchronization (retired)' | M15 | owner | closed |
| [O29](O29.md) | Two findings of deleted tests have no pin | M15 | owner | closed |
| [O30](O30.md) | On a phone profile the movable floating controls sit over the header controls | M15 | owner | closed |
| [O31](O31.md) | WebKit with the iPhone profile empties the composer after a synthetic Shift+Enter | M15 | owner | closed |
| [O32](O32.md) | Relay-backed specs never ran green on a phone or in iPhone Safari | M15 | owner | partly closed |
| [O33](O33.md) | A bot view whose session is missing, opened over from the directory, now opens a new primary beside it | M15 | owner | closed |
| [O34](O34.md) | On a phone with the keyboard up, the floating Window control sits over 'Hide message input' | M15 end gate | owner | closed |
| [O35](O35.md) | An interrupted agent left an unreviewed change that narrows O28's automatic re-discovery | e2e cleanup | open-items sweep | closed |
| [O36](O36.md) | The Relay refuses a window larger than the journal budget whole, and the publisher sends it again on each reopen | open-items sweep | owner | closed |
| [O37](O37.md) | `App.succession.owners-and-attachment` expects 'needs synchronization' after a local edit | open-items sweep | owner, with O35 | closed |
| [O38](O38.md) | The 30-minute M8 soak fails `memory-flat` | sweep end gate | owner | closed |
| [O39](O39.md) | The debugger's `./testing/*` exports point at directories the published package does not contain | O19 | final slice | closed |
| [O40](O40.md) | The E3 flow 'the reader keeps their line when a Controller restart replaces the journal...' fails intermittently | final end gate | owner, before deployment | closed |
| [O41](O41.md) | Relay authorization, origin, access, lease and credential checks that no owner test fails on | final census | owner, before deployment | closed |
| [O42](O42.md) | At 390 x 844 the floating Track, TPM, Window and Team launchers cover the conversation text again | I1 | owner | closed |
| [O43](O43.md) | Smoke quick after the Orchard steps: M2 and M7 errored on two composers | I4 smoke | owner | closed |
| [O44](O44.md) | A message sent at once after a session link opens over a 300 ms round trip never reaches the session | I4 smoke | owner | closed |
| [O45](O45.md) | The default Concise process display folds tool calls into their turn, so the smoke sees no tool-call row | I4 smoke | owner | closed |
| [O46](O46.md) | A terminal `codex exec resume` fails with "thread … already has an active writer" while a page shows the session | M6 | owner | closed as expected behaviour |
| [O47](O47.md) | Our side holds a Codex thread longer than Codex needs | M6 | owner | closed |
| [O48](O48.md) | When Codex refuses the Controller because a separate process writes the session, the page shows none of its rows | M6 | owner | closed |
| [O49](O49.md) | A Claude Code page turn and a terminal turn at the same time fork the transcript | M6 | owner | closed |
| [O50](O50.md) | With the managed terminal, the journal-served page is not told that a terminal holds the session | M6 (exploration) | owner | open |
| [O51](O51.md) | Full smoke M1 (seed 70621): the revisit painted after the Relay's first page, not from the device store | full smoke 2026-11-21 | harness | closed |
| [O52](O52.md) | Full smoke M2 (seed 70621): the follow-up message of rounds 8 and 10 never left the page | full smoke 2026-11-21 | harness | closed |
| [O53](O53.md) | The session-path components have 187 design clauses and 43 without a test | component statements, 2026-11-21 | owner | partly closed |
| [O54](O54.md) | In WebKit the page stays empty when the first fetch of the code-split `App` chunk fails | e2e convergence | owner | closed |
| [O55](O55.md) | Settings > Computers: a long unbroken computer name makes Settings scroll sideways on a phone | e2e convergence | owner | closed |
| [O56](O56.md) | Bot mode: opening a bot from the roster with the keyboard does not move focus to its title | e2e convergence | owner | closed |
| [O57](O57.md) | A multi-line message sent before E2's offline case leaves the offline message waiting | e2e convergence | owner | closed |
| [O58](O58.md) | Phone overlaps seen in fixtures, to check on the real page | e2e convergence | owner | partly closed |
| [O59](O59.md) | The page compares the Relay's absolute lease expiry with the device's clock | gap 7 | owner | closed |
| [O60](O60.md) | The App test 'edits a real App managed Team window…' failed once in the 0.3.4 release gate | 0.3.4 release gate, 2026-11-22 | owner | closed |
| [O61](O61.md) | `BotWorkspace.test.tsx` 'compact Back restores the roster row…' failed once under the full suite | `pnpm verify` on `design/im-session-service`, 2026-11-22 (module split, items 1 to 3) | owner | closed |
| [O62](O62.md) | A discovery during a prompt edit's restoration ends it with "Refresh the conversation to continue" | O60's investigation, 2026-11-22 (module split items 4 and 5) | owner | closed |
| [O63](O63.md) | Two Workbench tests still fail about once in 30 runs under heavy load | the load runs that proved O60 and O61, 2026-11-22 (module split items 4 and 5) | owner | closed |
| [O64](O64.md) | The E3 flow 'a session the Host no longer has…' fails about one run in three | the 0.3.4 release gate and the module split's end gate, 2026-11-22 | owner | closed |
| [O65](O65.md) | Three WebKit component tests time out in the full component tier and pass alone | the 0.3.4 release gate (3 WebKit timeouts, recorded in the release record) and the module split's two end gates, 2026-11-22 | owner | open (not reproducible in a clean worktree; investigation recorded) |
| [O66](O66.md) | Bot mode's panel widths are applied over the chats module's stylesheet, and Window mode's sidebar keeps its own handle | I5a, desktop panels (2026-11-22), which could not edit the chats and windows feature modules while the IM audit worked in them | the next change to `workbench-chats` or `workbench-windows` | open |
| [O67](O67.md) | The WebKit composer-owner component test loses its own selection now and then | the I5a end gate, `pnpm test:components` at `5e924da3` (2026-11-22) | owner | closed |
| [O68](O68.md) | Deeper screens still drawn with the legacy controls | the I5d finish pass (2026-11-22), which restyled the main screens and Settings' General, Privacy and data, Advanced and the support profiles | the next change to `workbench-computers`, `workbench-windows`, `workbench-sessions` or the toast | open |
| [O69](O69.md) | Tasks on the Team path lack the rest of the task model | step T2a of the assistant tasks design (2026-11-23) | T2 and T3 of that design, after the P2 operation queue | open |
| [O70](O70.md) | Assistants are a directory over the Window groups, not their own record | M3 of the assistant tasks plan (2026-11-23) | T1 of the assistant tasks design | open |
| [O71](O71.md) | Rooms live in the Teams panel and are opened only by an assistant | M4 of the assistant tasks plan (2026-11-23) | T6 of the assistant tasks design | open |
<!-- open-items:end -->
