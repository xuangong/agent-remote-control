# Module split for parallel work

Status: proposal for the owner, 2026-11-22; items 1 to 3 implemented the same day (last section).
Inputs: `architecture/modules.json`, `scripts/arch-check.mjs`, sections 1 to 3 and 13 of the [target architecture](2026-11-18-target-architecture-and-tests.md), `docs/current/agent-remote/components.md`, `AGENTS.md`, the write-tests skill, `scripts/compatibility.mjs`.

**Data.** `main` at `a75001d9`: 381 non-merge commits since 2026-11-19, the 4 merge commits, the 12 cherry-picked task branches (`ts/*`, `work/o*`, `test/security-pins`, matched by subject) and the reflog of `design/im-session-service`.
- **Tasks** come from commit tags (`I3a-A3`, `I3b-B4`, `(I4)`, `O47`, `gap 3`, `B1`, `smoke`) and branch membership: 71 named tasks.
- **A window** is a period in which several tasks ran at once (W1 to W7). **A same-window pair** is two tasks of one window that changed the same file; it counts the serialisation a file forces.
- **Conflicts** were reproduced with `git merge-tree` on each merge's parents and on the three cherry-picks that stopped. The feature map of 3.4 is a path-rule mapping of the 375 Workbench source files, applied to the same history.

## Summary

| # | Change | Payoff, measured since 2026-11-19 | Cost |
|---|---|---|---|
| 1 | The compatibility digest is regenerated once on `main` after a merge, never in a task; a merge driver as a net | 76 of 381 commits touched it, 44 changed nothing else; it conflicted in 4 of 4 merges | 1 to 2 h; the owner changes one AGENTS.md rule |
| 2 | Ledger documents become one file per item (open items, clause tables) | the two highest pair counts of any file, 47 and 28; one merge conflict | 1 h, documents only |
| 3 | Ratchets and registries that no task edits (legacy token budget, component projects, CLI simulator) | 20 and 16 commits; 13 pairs on the budget, 6 on each simulator file | 2 to 3 h |
| 4 | `SessionWorkbench` split into parts, `useSessionViewPresentation` into per-feature contributions | 37 commits, 25 pairs, one merge conflict | 1 to 1.5 days |
| 5 | Test selection by module, then Workbench feature modules behind a kernel and a `uses` rule | a Workbench edit runs 67 to 113 s of tests, a module a few seconds; 22 of 46 Workbench tasks stayed in one or two features | 0.5 to 1 day, then a session per two or three features |

Items 1 to 3 remove serialisation that has no reason in the code; item 4 removes it where features meet; item 5 gives feature tasks owners. The Orchard design passes (I1 to I4) cut across every feature, so item 5 does not help them; items 1 to 4 do.

## 1. The collision map

### 1.1 The parallel windows

| Window | Tasks | Task pairs | Pairs sharing a code file | Real conflicts |
|---|---:|---:|---:|---|
| W1 test speed, 11-19 11:24 to 12:50 (the seven `ts/*` branches and the main line) | 14 | 91 | 4 | 2 cherry-picks, both on `scripts/slow-test-allowlist.json` |
| W2 O-items, 11-19 14:12 to 16:25 | 5 | 10 | 0 | 1 cherry-pick, on `packages/agent-controller/package.json` |
| W3 I2 and phone launchers, 11-20 05:40 to 10:45 | 4 | 6 | 5 | merge `379e1548`: the digest only (`shell.css`, `window-workspaces.css` and the component config merged cleanly) |
| W4 I3a, A1 to A10, 11-20 11:20 to 16:10 | 10 | 45 | 23 | none: the sub-agents committed in turn on one branch |
| W5 I3b, B1 to B9, and the I3a tail, 11-20 16:10 to 20:05 | 12 | 66 | 38 | merge `bcb317ae`: `SessionWorkbench.tsx`, the E10 flow, the digest |
| W6 I4, 11-21 00:30 to 06:10 | about 7 sub-agents, one tag | n/a | n/a | 64 commits on one branch: 23 touched catalogue areas, 9 the global CSS, 7 the legacy budget, 6 the two hotspots |
| W7 clauses, e2e convergence, B1 and B2, O47 to O49, gaps 3 to 5, 11-21 14:40 to 11-22 02:15 | 26 | 325 | 35 | merge `62dd2cf8`: the target architecture document, the digest |

The fourth merge, `f589e2c6` (Claude history order, 11-20 05:09), conflicted on the digest only. "Code file" leaves out documents and the four registries of 2.1 and 2.3, which the next table counts.

### 1.2 Files, ranked by the serialisation they force

| File | Kind | Commits | Tasks | Same-window pairs | Conflicts |
|---|---|---:|---:|---:|---|
| `agent-relay-node/compatibility.json` | generated digest | 76 (44 alone) | 21 | every branch that updates it | 4 of 4 merges |
| `docs/superpowers/specs/2026-11-18-target-architecture-and-tests.md` | ledger (open items, results) | 38 | 27 | 47 | 1 merge |
| `docs/current/agent-remote/components.md` | ledger (clause tables) | 11 | 9 | 28 | |
| `scripts/slow-test-allowlist.json` | ratchet | 15 | 9 | 22 | 2 cherry-picks |
| `agent-remote-lab/src/ui/legacy-token-budget.json` | ratchet | 20 | 11 | 13 | |
| `agent-remote-lab/src/app/useSessionViewPresentation.tsx` | integration hook | 15 | 11 | 13 | |
| `agent-remote-lab/src/components/SessionWorkbench.tsx` | integration component | 22 | 16 | 12 | 1 merge |
| `agent-client-web/src/react/AgentTimeline.tsx` | integration component | 10 | 7 | 10 | |
| `agent-remote-lab/src/components/BotWorkspace.tsx` | integration component | 10 | 8 | 10 | |
| `agent-remote-lab/e2e/fixtures/assistant-layouts.tsx` | shared fixture page | 9 | 7 | 10 | |
| `agent-client/src/presentation/messages.ts`, `presentation/index.ts` | catalogue core, barrel | 10, 7 | 9, 7 | 9, 7 | |
| Controller `test-utils/simulated-cli.ts`, `provider-faults.test.ts` (replaced by the B3 conformance kit on 11-22), seams `S2/support/simulated-stack.ts` | test registry | 4 to 5 each | 4 | 6 each | |
| `agent-client-web/src/styles.css`, Workbench `app.css`, `shell/shell.css` | global CSS | 10, 14, 10 | 7, 9, 5 | 6, 3, 3 | |
| `agent-client-web/src/react/AgentComposer.tsx`, `AgentComposer.pending.test.tsx` | send path | 13, 8 | 8, 7 | 4, 6 | |
| `agent-remote-lab/playwright.components.config.ts` | registry | 16 | 7 | 2 | |
| `agent-controller/package.json` | manifest | 6 | 6 | 4 | 1 cherry-pick |

The five source files over 1,000 lines had 1 to 4 commits each and 0 to 3 pairs (3.6). The catalogue's central files changed at most once after I4 split it into areas (2.4).

**Modules of `modules.json`**, by tasks and same-window pairs (W6 left out, as I4 carries one tag): `workbench` 45 and 73, `e2e` 39 and 50, `controller` 12 and 36, `client` 23 and 30, `client-web` 23 and 25, `seams` 14 and 24, `relay-core` 15 and 22, `controller-session-core` 9 and 21; every other module under 16 pairs.

### 1.3 What the numbers say

- **The backend is right-sized.** W1 and W2 ran 19 tasks (101 pairs); 4 pairs shared a code file, and their conflicts were in an allowlist and a `package.json`, never in a module's code.
- **The UI waves collide where features meet.** In I3a 23 of 45 pairs shared a file, in I3b 38 of 66: integration files (the conversation surface and its presentation hook, the timeline, Bot mode's layout, one fixture page) and global registries (the catalogue core, the CSS, the legacy budget).
- **Process files cost the most.** The digest, the two ledgers and the ratchets are edited by every task for no reason of the task's own.
- **Size is not the cause.** The hotspots are 134 to 440 lines and each takes many features; the files over 1,000 lines stayed quiet.
- **46 Workbench tasks**, by the feature map of 3.4: 15 stayed in one feature module and 7 in two; 19 touched three or more and 5 only the shell. The wide ones are the Orchard passes (I1, I2, I3a-A6, I3b-B2, B3, I3c, I4) and the restructuring (O16, e2e convergence). A feature split alone would still have left 30 of I3a's 45 pairs and 51 of I3b's 66 in a shared module (34 and 56 today); those passes need 3.1 and 3.2.

## 2. Shared-file fixes, ranked by payoff and cost

### 2.1 The compatibility digest (payoff highest, cost 1 to 2 h)

**Why it changes on every source edit.** `scripts/compatibility.mjs` hashes, into one sha256, the path and bytes of every file git tracks under `packages/*` (without `node_modules`, `dist` and local state), plus `package.json`, the lockfile, the workspace file and `scripts/`. The result is the single line `borgee.implementation.digest` of `packages/agent-relay-node/compatibility.json`.
- Any edit in that scope changes the line, so two branches always write two values on it. Git cannot merge two values of one line, and the merged tree has a third digest anyway.
- Every task commits it because `pnpm verify` starts with `compatibility:check` and the AGENTS.md rule (line 9) asks for `compatibility:update` after each reviewed change.
- Who reads it: `compatibility:check` (`pnpm verify` and the two release workflows) and `loadCompatibilityManifest` (the live DSH and Codex validation and the DSH plugin pack, run by hand). Unit tests write temporary manifests, and `pnpm build` no longer reads it.

| Option | Effect | Verdict |
|---|---|---|
| A. Regenerate only on `main`: tasks never run `compatibility:update`; `pnpm verify` drops the digest check, which stays in a `verify:release` and the release workflows; whoever merges to `main` regenerates once, in or right after the merge | No task branch touches the file: no conflict, no chore commit on a branch | Recommended. The rule becomes "regenerate on `main` after merging reviewed changes, and before a release" |
| B. A merge driver: `.gitattributes` gives the file `merge=arc-digest`; the driver merges the hand-written parts (protocol version, providers) and keeps one side's `implementation`, which A regenerates | Merges, rebases and cherry-picks no longer stop on it | With A, as a net for a branch that still carries an update. `git config` is not versioned, so `pnpm task:start` registers the driver |
| C. A post-merge hook or a CI job regenerates it | A hook cannot amend a merge it did not make; CI here runs only releases | Not alone; A covers it |
| D. One digest per package | Unrelated packages merge cleanly | Not worth it: each of the 4 merges shared a package (one, one, three and six packages), so all 4 would still conflict |
| E. Untracked, generated at release | Removes the file from history | Changes what Borgee reads in the source tree; not needed after A |

### 2.2 Ledger documents, one file per item (cost 1 h)

- **Open items.** Section 10 of the target architecture is one table whose rule is "update this table in the commit that closes or moves an item", and results sections are appended the same way. Every O-task edits a row next to another task's row; git takes changes on adjacent lines as a conflict, and new rows land at the same end. Fix: one file per item (`docs/superpowers/open-items/O57.md`: status, owner step, evidence) and one results file per step; the table keeps links and changes only when an item opens.
- **Clause tables.** `components.md` holds those of the nine session-path components; eight W7 tasks edited it. Fix: one file per component (`docs/current/agent-remote/components/<component>.md`) under a short index.

### 2.3 Ratchets and registries that no task edits (cost under 1 h each)

- **Legacy token budget.** `stylesheets.test.ts` requires each stylesheet's count of legacy variables to equal its budget, so every task that removes a use edits the `app.css` line (501) or the `styles.css` line (381), and two such tasks disagree on the number. Fix: at most the budget; the 9 stylesheets at 0 stay exact; a `--write` mode lowers the budgets, run on `main` with the digest. The count still never rises, and the JSON changes only when a stylesheet is added. It retires once 2.5 has split `app.css` and `styles.css`.
- **Component projects.** `playwright.components.config.ts` names spec files in the `testMatch` arrays of eight browser projects (16 commits). Fix: each spec declares its projects as tags (`test(name, { tag: ['@webkit-mobile', '@phone'] }, ...)`) and each project selects by `grep`. Proof: `playwright test --list` per project is the same before and after.
- **Provider behaviours (B2, B3).** Each behaviour task (O48, O49, gaps 3 to 5) added a fault to `simulated-cli.ts`, the S2 `simulated-stack.ts` and a Controller test. Since 11-22 the B3 conformance kit holds the checks, and a new behaviour still edits the kit's list of checks (`agent-provider-sdk/src/conformance.ts`, `conformance-checks.ts`), the simulator and every adapter's native fake. Fix: one file per behaviour in the kit (its finding, its fault, its check), collected by the kit, so a behaviour task adds files. The area is in flight; do it after B3 settles.
- **Vector tables** (`session-presentation-vectors.ts`: 5 commits, 3 pairs) take rows at the end; split one by clause group when two tasks need it at once. Not yet.

### 2.4 The message catalogue (done; align later)

I4's first commit (`bbc69c57`) split the catalogue into areas. Before, `messages.ts` had 10 commits and 9 pairs and the barrel 7 and 7; since, `en.ts`, `zh.ts` and the barrel changed once each, and `messages.ts` and `types.ts` not at all. The areas are cut by screen, not by owner: during I4, `sessions.en.ts` and `settings.en.ts` took 6 commits each and `navigation.en.ts` 5, from different sub-agents. Fix: one area per Workbench feature module (3.4), moved with the feature; the merge files change only when an area is added.

### 2.5 CSS by feature (part of each feature step)

The Workbench's `app.css` (1,497 lines) holds rules under 37 selector prefixes with five rules or more, across nearly every feature (`lab-session` 114 rules, `lab-timeline` 77, `lab-favorite` 64, `lab-host` 41, `lab-folder` 30, `lab-fork` 25); the client's `styles.css` is 1,080 lines. Each feature's rules move into its stylesheet with the feature, and `styles.css` splits by component (timeline, composer, previews, interactions). Checks: the component tier for the cascade order, the stylesheet tests, the production CSS line count unchanged.

### 2.6 Long import lines and barrels (a formatter rule)

The I3a and I3b merge conflicted in `SessionWorkbench.tsx` on one import line of 10 to 13 names from `@orchardworks/agent-client`, which both sides changed. Write multi-name imports one name per line and keep barrel lines sorted, so two additions rarely touch adjacent lines.

## 3. Module splits

### 3.1 The conversation surface: `SessionWorkbench.tsx` into parts

It is 440 lines with 58 props and six concerns: the heading in four modes (inline, toolbar, assistant, tile) with the tile's details panel; action feedback; which actions the session's operations allow; the timeline stage (search, scroll, reveal, empty states); the composer region; command details. Its 22 commits mix all six: I1's notice, I3a-A3, A5 and A8 in the timeline, A6 in the view options, B2 and B4 in the heading, B3 in the details, and I4's capsule, O44 and gap 3 in the composer.
- **Files.** `src/conversation/ConversationSurface.tsx` (frame and composition, keeping the export `SessionWorkbench`), `ConversationHeading.tsx`, `ConversationTimeline.tsx` (today's memoised `WorkbenchTimeline`), `ConversationComposer.tsx`, `useActionFeedback.ts`, and `session-actions.ts`, a pure rule from session state to allowed actions with a vector table. Module `workbench` until step 7, then `workbench-conversation`; no dependency changes direction.
- **Tests.** `SessionWorkbench.test.tsx` and the `LabWorkbench.*` tests stay as the public behaviour; `session-actions.test.ts` is new; a mutation check only if an old assertion is narrowed.
- **Gain, cost.** The timeline, heading, details and composer tasks of W4 and W5 land in different files; the one I3 merge conflict was here. Half a day; the timeline's memo boundary stays (the `App.render-budget` tests check it).

### 3.2 Session view presentation as per-feature contributions

`useSessionViewPresentation.tsx` (308 lines) reads 69 fields of 19 slices and the App inputs, and builds every prop of a session view in one function: identity and details, process mode, quotes, references, forks and Sides, handoff, send-later, console commands, heading actions, title and rename, folding. Only the `App.*` mounts test it.
- **New seam, inside the Workbench.** A contribution is `(view: SessionViewContext) => Partial<SessionWorkbenchProps>`. It reads only the inputs it declares; `actions` passes through the contributions in a stated order (references after quotes, as today), and no contribution reads another's other output. The contract goes in `docs/current/agent-remote/workbench-state.md`.
- **Files.** `src/conversation/contributions/{identity,quotes,references,forks,handoff,outbox,heading-actions,folding}.ts`; the hook merges them.
- **Tests.** A unit test per contribution on a mock `SessionViewContext`; the `App.*` mounts stay; where a contribution test replaces an `App.*` assertion, the mutation check of write-tests section 5 applies.
- **Gain, cost.** I2, A5, A6, B2, B3, B4, B5, B7, I3c and I4 each changed this one function; they would have changed different files. One day.

### 3.3 Other integration files: split on next touch

`AgentTimeline.tsx` (client-web, 366 lines, 10 pairs in I3a): the parts of a turn (bubble, work line, approvals, live line, session-change line) move to `react/turn/` and `AgentTimeline` maps turns to parts; its tests and S6 stay. `BotWorkspace.tsx` (213 lines, 10 pairs in I3b): its three panels become three files. `e2e/fixtures/assistant-layouts.tsx` (10 pairs): one fixture page per layout.

### 3.4 Workbench feature modules

The `workbench` module has 375 source files (33,032 lines), 329 test files and 3,417 tests; its suite takes 67 s, or 113 s with the speed rule's re-measurement (section 13.2), and `verify:changed` runs all of it for any Workbench edit. Its layout is flat: 96 source files at the root, 90 in `components/`, 49 each in `hooks/` and `app/` (plus 22 in `app/views/`), 20 in `state/`.

| Module (`modules.json` name) | Path after the move | Source, test files now | One reason to change |
|---|---|---:|---|
| `workbench` (the shell: what remains) | `src/**`: `App.tsx`, `main.tsx`, the `app/` composition, `shell/`, the 34 `App.*` composition tests | 58, 67 | navigation and composition |
| `workbench-kernel` | `src/kernel/**`, `src/ui/**` | 15 moved, 7 | keys, types, clients and contexts every feature reads |
| `workbench-conversation` | `src/conversation/**` | 58, 55 | the conversation surface both views draw |
| `workbench-chats` | `src/features/chats/**` | 22, 11 | Bot mode, roster, Assistants directory |
| `workbench-windows` | `src/features/windows/**` | 40, 39 | Window mode, docks, panes, folding |
| `workbench-team` | `src/features/team/**` | 34, 30 | Team, TPM, Ask, Call for Support |
| `workbench-sessions` | `src/features/sessions/**` | 53, 41 | directory, favorites, stars, titles, tracking, creation |
| `workbench-session-links` | `src/features/session-links/**` | 27, 24 | forks, Sides, children, quotes, references, letters |
| `workbench-succession` | `src/features/succession/**` | 25, 23 | handoff, prompt edit, migrations, composition restore |
| `workbench-computers` | `src/features/computers/**` | 25, 15 | Hosts, pairing, Controller updates, previews, tunnels, security |
| `workbench-settings` | `src/features/settings/**` | 20, 11 | the Settings page and device choices |
| `workbench-diagnostics` | `src/features/diagnostics/**` | 8, 3 | Trace, Replica Inspector, playback |

- **What moves.** Each feature takes its components, hooks, `app/` slices, `state/` rules, CSS (2.5) and catalogue area (2.4), and its colocated tests unchanged. The kernel takes the 15 files most features import: `session-tree.ts`, `directory-client.ts`, `conversation-storage.ts`, `app/types.ts`, `app/helpers.ts`, `window-workspace.ts`, `workspace-access.ts`, `view-binding.ts`, `session-composition.ts`, `draft-store.ts`, `session-view-navigation.ts`, `components/Toast.tsx`, `SessionLink.tsx`, `SessionConnectionNotice.tsx`, and the `RemoteHost` type out of `HostPairing.tsx`.
- **Direction.** Features import the conversation module and the kernel; the shell imports everything; no feature imports another. A new module field enforces it: a module that lists `"uses": ["workbench-kernel", "workbench-conversation"]` may import a module of its own package only from that list, and anything else is a new violation kind, `sibling` (test files exempt, as for every edge). About 20 lines in `scripts/lib/arch-check.mjs`, with cases in `arch-check.test.mjs`. Two of the entries, for example (the shell keeps today's `workbench` entry and its flows):

  ```json
  { "name": "workbench-kernel", "layer": 4, "paths": ["packages/agent-remote-lab/src/kernel/**", "packages/agent-remote-lab/src/ui/**"],
    "uses": [], "seams": ["S6"], "flows": [], "invariants": [] },
  { "name": "workbench-team", "layer": 4, "paths": ["packages/agent-remote-lab/src/features/team/**"],
    "uses": ["workbench-kernel", "workbench-conversation"], "seams": ["S6"], "flows": ["E7"], "invariants": [] }
  ```
- **Coupling today.** The proposed feature modules import each other in 820 statements, 418 of them type-only (mostly the slice types of `Pick<... & XSlice>`); 23 module pairs import each other. The kernel cuts the 402 value imports to 228. Then diagnostics (3 out, 0 in), settings (12, 6) and computers (5, 13) can move at once; team (45, 27), windows (43, 38) and conversation (42, 41) need ports first.
- **New seam: the Workbench feature seam.** A feature's slice hook takes an input interface the feature declares, never another feature's slice type. Actions across features (open a session, reveal a view, open in Bot mode, show a view) are a `WorkbenchNavigation` port in the kernel that the shell implements. Session view props come from the contributions of 3.2.
- **Tests.** Moved tests do not change and need no mutation check; a slice-hook test rewritten onto the input interface does. The `App.*` tests stay in the shell: about 320 tests, with 169 of the repository's 305 tests over 300 ms. Section 13.1 measured Workbench selections of 91 and 121 tests at 3.3 and 3.6 s, so a feature of 18 to 420 tests should take about 3 to 10 s (an estimate; measure it in the step).
- **Parallelism gained.** Feature tasks own a module: 22 of the 46 Workbench tasks stayed in one or two features (O29 sessions, O32 computers and sessions, O33 succession, I3b-B8 chats, the Team roster period). Team, Computers, Settings and diagnostics work stops sharing files with Window and Bot mode work. Cross-cutting design passes still touch several modules (1.3).
- **Against the four criteria.** A task owns a feature end to end; its tests run in about 3 to 10 s; it changes for the reason in the table; a feature task edits shared files only to wire a new slice into `App.tsx` or to add a catalogue area. The shell misses the test-time criterion while its `App.*` mounts stay.
- **Cost and risk.** One session for the kernel and `uses`; one per two or three loosely coupled features; one each for team, windows and conversation with their ports. A move breaks in-flight Workbench branches, so move a feature only while none is open.

### 3.5 Test selection by module (no split; it makes the splits pay)

`verify:changed` selects a changed package and every dependent: a Workbench edit runs the whole Workbench suite, an `agent-client` edit also runs `agent-client-web`, the Workbench, the Node Relay, the debugger, the seams and the e2e package's unit tests, with their builds. Parallel sessions load the machine: section 12 records `verify` runs that failed only on the speed rule under another worktree's load. Section 5.9 already designed `pnpm test:changed` by module; build it: changed files to modules through `modules.json`, `vitest related` on the changed files in each changed package plus the seam suites in the module's `seams`, and the `App.*` composition tests only when the shell or a feature's public entry changes, and at the end of a step. Proof: for the eleven changes of section 13.1 it selects at least the recorded tests. Half a day to a day.

### 3.6 The files over 1,000 lines

| File | Lines | Commits since 11-19 (since 10-01) | Verdict |
|---|---:|---|---|
| Codex `session.ts` | 1,899 | 3 (21); 3 pairs in W7 | Split on next touch, behind the same class: history refresh, turns and input, settings, interactions, runtime info and limits |
| relay-core `gateway.ts` | 1,228 | 2 (41) | Routes by concern (`edge/`, target architecture 3.3) on next touch |
| session-runtime `agent-manager.ts` | 1,138 | 1 (14) | Not now |
| Workbench `useSessionSuccession.ts` | 1,075 | 4 (34) | Moves with `workbench-succession`; its rules go to `agent-client` succession (X1) |
| client `remote-session-client.ts` | 1,094 | 4 (24) | Not now; the lease-view table is already separate |

## 4. Splits that are not worth it

| Split | Why not |
|---|---|
| One digest per package | Each of the 4 merges shared a package (2.1 D) |
| Further splits of relay-core, the Controller, the session runtime, the providers or the protocol | In W1 and W2, 4 of 101 task pairs shared a code file and no conflict was in module code |
| Breaking up the files over 1,000 lines now | 1 to 4 commits each since 11-19 and no conflict (3.6) |
| A slow-test allowlist per package | Its 2 conflicts came from W1, whose tasks removed entries; 8 entries remain and the list only shrinks |
| Splitting the catalogue further than 2.4 | The central files changed at most once since the area split |
| A package per Workbench feature | `uses` gives the same boundary inside one package; packages would add 11 manifests, builds and export maps, which are shared files too |
| A pure `workbench-rules` module at layer 1 | The `state/` rules import Workbench types (`RemoteHost`, `OpenedSession`); possible after the kernel, with little gain for parallel work |
| Splitting the `e2e` module | Of its 50 pairs, 25 shared a file: 10 on `assistant-layouts.tsx` (3.3), and one pair each on 15 specs and fixtures, 6 of them since deleted by the e2e convergence |
| Splitting the composer's send path (`AgentComposer.tsx`, 770 lines) | 4 pairs in 13 commits, and its rule already lives in the client's send state (X8); watch it |

## 5. Steps that each ship alone

Each step preserves behaviour, keeps `arch:check` at 0 failing findings and changes no protocol. Moved tests are not edited; where a test is rewritten or replaced, the mutation check of write-tests section 5 decides what is deleted.

| Step | Change | Proof | Cost |
|---|---|---|---|
| 1 | The digest only on `main` (2.1 A) with the merge driver (B); the AGENTS.md rule; `verify:release` | A test merge of two branches that both changed the digest merges cleanly; `compatibility:check` passes on `main` after the regeneration | 1 to 2 h |
| 2 | Open items, results and clause tables one file per item (2.2) | Documents only | 1 h |
| 3 | Legacy budget "at most" with `--write`; component projects by tag; one name per import line (2.6); later, once B3 settles, one file per provider behaviour in the conformance kit (2.3) | The stylesheet test fails on an added legacy use and passes on a removal; `playwright test --list` per project unchanged; the kit runs the same checks for each adapter | 2 to 3 h |
| 4 | `test:changed` by module inside `verify:changed` (3.5) | It covers the eleven selections of section 13.1; timings recorded | 0.5 to 1 day |
| 5 | `SessionWorkbench` into parts and the `session-actions` rule (3.1) | Workbench suite, render budgets, component tier; mutation check of the new vectors | 0.5 day |
| 6 | Session view contributions (3.2) | A unit test per contribution; `App.*` unchanged; mutation check where an `App.*` assertion goes | 1 day |
| 7 | The kernel, the `uses` field in `arch:check`, the Workbench entries in `modules.json` (3.4) | `arch-check.test.mjs` cases; `arch:check` | 1 session |
| 8 | The features, in order of coupling: diagnostics, settings, computers; chats, session-links, succession, sessions; team, windows; each with its CSS (2.5) and catalogue area (2.4) | Per move: typecheck, the feature's tests, the component tier, `arch:check` | 1 session per 2 or 3 features |
| 9 | On next touch: the turn parts, the Bot mode panels, a fixture page per layout (3.3), Codex `session.ts`, the `gateway.ts` routes (3.6) | The owning suites | per touch |

**Decision point.** After step 6, measure the next parallel wave with this document's method. Steps 7 and 8 add eleven modules; take them if feature tasks still share Workbench files.

## Owner decision (2026-11-22)

Item 1 is approved, including the change to the compatibility rule on line 9 of `AGENTS.md`. Task branches no longer update the compatibility digest. It is regenerated and checked once a branch is merged to `main`, and a merge driver handles any conflict that remains. The release gates are unchanged.

Item 1 is implemented after the two tasks now in flight (the provider kit and the phone/platform gaps) are merged, so those tasks are not caught by a rule change halfway through. Items 2 to 5 follow in the document's order.

## Implemented: items 1 to 3 (2026-11-22)

- **1. The digest.** `pnpm compatibility:check` reports a stale digest on a task branch and passes; it fails on `main`, on a detached HEAD, in GitHub Actions and with `--strict`, so the release gates are unchanged. After a merge, `pnpm postmerge` on `main` regenerates the digest, commits it alone and checks it. The merge driver of `compatibility.json` (`.gitattributes`; `pnpm install` and `pnpm task:start` register it) keeps this side's digest and merges the hand-written parts as text. The rule is line 9 of `AGENTS.md`; the merge and release steps are in the README ("Merging into main") and `docs/controller-npm-release.md`.
- **2. The ledgers.** Section 10's open items are `docs/superpowers/open-items/O1.md` to `O60.md` (O60 from the 0.3.4 release record), with an index that `pnpm postmerge` generates on `main` and `pnpm open-items` prints anywhere. The clause tables are one file per component in `docs/current/agent-remote/components/`, under `components.md`, which holds no counts.
- **3. The registries.** The legacy token budget is a ceiling: the stylesheet test fails on an added legacy use and passes on a removal, and `pnpm postmerge` lowers the budgets to the counts on `main`. Each component spec names its WebKit and phone projects in its first line, and the projects select by it; `playwright test --list` is the same for every project. Not done in step 3: one name per import line (2.6), and one file per provider behaviour in the conformance kit, which waits for B3 to settle.
- **Proof.** In a scratch clone: this branch fast-forwarded onto `main`, then two task branches that changed different source files, one opening O61, the other closing O13 and removing a legacy variable, merged with no conflict; `pnpm compatibility:check` failed on `main` until `pnpm postmerge` committed the digest, the index and the budget, then passed. Two branches that both committed a digest update conflicted without the driver and merged cleanly with it.
