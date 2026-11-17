# Module boundaries and test layers: assessment and plan

Status: assessment and plan for the owner's decision, 2026-11-17. Analysis only; no code was changed and nothing here is implemented.
Scope: branch `design/im-session-service`, 252 commits ahead of `main` at `0aaefda9`.
Order set by the owner: finish the current Codex and Claude work first, which becomes the baseline; restructure the tests after that.

## The owner's words

- "你现在任何一个改动要跑非常非常多的tests，但实际上tests应该是分层的，至少分块的，目的就是要隔离，改哪里测哪里而不是代码一团，都测"
- "各个模块之间没有明确的界线，就没办法用大量的mock data来加速测试"
- "我理解一遍的测试是单侧，单侧都是有mock data的，集成测试也是有mock data的，得知道各个模块打算怎么集成才对。然后是e2e测试，我理解应该只需要主流程"
- "单侧和集成测试一定要有mock data，e2e测试一般只需要测主流程或者本地测试遇到问题的case加进去"

## 1. Summary

1. The package graph is better than the test habits. `agent-remote-web` depends only on the protocol package, and the protocol, SDK, journal and web packages test in 1 to 36 seconds. The cost sits in `agent-remote-lab` (85 s wall), `agent-host` (74 s), `agent-remote-cloudflare` (65 s), and in routing every task through all of them.
2. The slowness is a few files, not thousands of tests. `App.succession.test.tsx` alone takes 74 s (163 tests that render the whole `App` over a real server). Five `agent-host` process and timer files take about 115 s of worker time.
3. Redundancy points at nine missing modules (section 5): client succession, Relay session control, the journal window decision, an account-state storage contract, a Host Session module, a Workbench state reducer, a send-state machine, a Controller facade, and the broker state object. The rules live inside two closures (`createHostBroker`, 2,570 lines; `createAgentHostRuntime`, 1,350 lines) and inside `App.tsx` (3,765 lines), so every layer re-tests them through its own entry. Extracting them (section 6) removes about 640 tests and 20,000 test lines, and the new unit tests use mock data.
4. Boundary leaks that block mock data: packages export from `dist`, the Controller reads provider fixtures by relative path, shared types are deep-imported from the Relay and the Controller-side `agent-remote-relay`, and the latter has a misleading name.
5. `scripts/verify-changed.sh` is a full run on this branch: it changed `pnpm-lock.yaml`, `scripts/`, `deploy/` and `compose.yaml`, and the merge base is 252 commits back.
6. Test layering (section 7) follows from the extractions: unit, integration (per-seam contract, fixtures and transcripts), main-flow e2e (35 to 60 tests, from about 400), and an opt-in native tier. Per-task time falls from 3 to 10 minutes to 10 to 40 seconds. Quick wins (7.9) land in a day; extractions are ordered in 6.1 and start after the Codex and Claude baseline.

## 2. The module map

### 2.1 Packages, sizes and workspace dependencies

Sizes are non-test TypeScript and TSX lines under `src/`. Test counts are `it` and `test` calls; Vitest's own count is a little higher for `it.each` (for example 422 against 274 for the protocol package).

| Package | Src lines | Test files | Tests | Workspace dependencies |
|---|---:|---:|---:|---|
| `agent-remote-lab` | 29,971 | 296 | 2,293 | sdk, codex, dsh provider, hosted, journal, journal-sqlite, protocol, relay, web, tunnel, controller |
| `agent-host` (Controller) | 18,057 | 163 | 1,297 | claude, codex, copilot, opencode, sdk, hosted, journal, protocol, relay, tunnel, platform |
| `agent-remote-web` | 13,788 | 94 | 775 | protocol |
| `agent-remote-hosted` (Relay broker) | 12,784 | 76 | 809 | journal, protocol, tunnel, relay |
| `agent-remote-relay` (Controller-side session manager) | 6,830 | 43 | 362 | sdk, protocol, platform |
| `agent-provider-codex` | 5,632 | 53 | 390 | sdk, codex-daemon-client |
| `agent-remote-protocol` | 4,289 | 48 | 274 | none |
| `agent-provider-dsh` | 3,950 | 16 | 131 | sdk |
| `agent-remote-debugger` | 2,593 | 13 | 127 | nearly everything |
| `agent-provider-claude` | 2,756 | 46 | 267 | sdk |
| `agent-provider-opencode` | 2,114 | 15 | 142 | sdk |
| `agent-provider-copilot` | 1,911 | 20 | 159 | sdk |
| `agent-provider-sdk` | 1,228 | 10 | 58 | none |
| `codex-daemon-client` | 1,233 | 3 | 11 | none |
| `agent-remote-journal` | 1,117 | 17 | 169 | protocol, relay |
| `agent-remote-tunnel` | 1,011 | 7 | 39 | none |
| `agent-remote-dsh` | 962 | 7 | 67 | dsh provider, sdk, relay |
| `agent-remote-cloudflare` | 621 | 37 | 131 | hosted, journal-sqlite, tunnel |
| `agent-remote-journal-sqlite` | 205 | 1 | 14 | journal |
| `agent-platform` | 66 | 2 | 7 | none |

Total: about 109,000 source lines, 1,016 test files, about 7,600 counted tests (Vitest reports about 9,000).

### 2.2 The mapping to the intended boundaries

| Intended boundary (AGENTS.md) | Package(s) | Observation |
|---|---|---|
| Provider SDK | `agent-provider-sdk` | Clean leaf. The `./testing` entry exists (`testing.ts`, `contract.test.ts`, `journal-recording.ts`). |
| Public Remote protocol | `agent-remote-protocol` | Clean leaf. Codecs, guards and versioned messages. Almost no fixture directory (two legacy-team files). |
| Relay state | `agent-remote-hosted` (broker, gateway, journals, teams, previews) | Imports only protocol, journal, tunnel and (twice) relay. No provider or web imports. Good direction. |
| Native adapters | `agent-provider-claude`, `-codex`, `-copilot`, `-opencode`, `-dsh` | Each depends only on the SDK (Codex also on `codex-daemon-client`). Good. |
| Client renderer | `agent-remote-web` (library) and `agent-remote-lab/src` (workbench app) | The web library depends only on protocol. The workbench app is a second renderer of 16,000 lines that also owns a server (`src/server`, 2,700 lines). |
| (not named) Controller | `agent-host` | Depends on everything: four providers, hosted, relay, journal. It is the integration point, not a module with a small surface. |
| (not named) Session projection | `agent-remote-relay` | Despite the name this is the Controller's session manager, timeline projector and session wire. It is imported by `agent-host` (48 imports), `hosted` (2), `journal` (2 deep imports into `timeline-projection`). |

### 2.3 Inside the big packages

`agent-remote-hosted` (12,784 lines):

- `broker.ts`, 2,737 lines. One function, `createHostBroker`, from line 160 to the end. It holds Host registration and heartbeat, pairing, device keys, bindings and creation, succession associations, relations, sharing, Call For Support, team delivery, journal serving, journal deletion and the controller upgrade bridge. About 40 inner functions close over the same maps (`hosts`, `bindings`, `keys`, `attached`, `creations`, `pairings`, `associations`). It imports 45 sibling modules. Its tests (`broker*.test.ts`, 9 files, about 3,200 lines) call the whole closure.
- Already split well: `host-journals.ts` (636), `journal-session-stream.ts` (485), `journal-uplink.ts`, `journal-host-stream.ts`, `stream-control.ts`, `record-codec.ts`, `teams.ts`, `succession-capacity.ts`, `host-sharing.ts`, `window-workspaces.ts`. These have their own tests and take `JournalStore` or a scheduler as a port.
- `gateway.ts`, 1,222 lines: HTTP, auth and routing in front of the broker.

`agent-host` (18,057 lines):

- `host.ts`, 1,807 lines; `createAgentHostRuntime` is a closure of about 1,350 lines (lines 416 to 1,765): session catalog, attach, create, binding, outbox delivery, directory, succession, journal publication wiring, tunnel, TPM.
- Siblings: `tpm.ts` (836), `session-succession-store.ts` (813), `journal-publication.ts` (676), `cli.ts` (631), `session-succession-context.ts` (587), `team.ts` (495), `stdio-directory.ts` (476), `session-succession-boundary.ts` (461), `session-routes.ts` (346), `local-session-runtime.ts` (333).
- 28 of its non-test files import `agent-remote-relay` or `agent-remote-hosted`. Its processes (CLI, OpenCode server supervisor, Codex daemon runner, systemd, Windows autostart, VS Code tunnel) live in the same package and the same Vitest run as the session logic.

`agent-remote-web` (13,788 lines): `client/` 3,792 (connection and replica protocol client), `react/` 7,818 (hooks and views), `replica/` 1,174, plus device store, image and resource drafts. One dependency, the protocol. Six export entries (`.`, `headless`, `browser`, `react`, `device-store`, `styles.css`), which is a real contract; `headless` is the framework-free layer.

`agent-remote-lab` (29,971 lines):

- `src/components` 8,771, `src/hooks` 7,076, `src/server` 2,739, `src/shell` and `src/ui` 800, and about 10,000 lines of top-level view-model and store modules (`window-workspace*.ts`, `session-*.ts`, `conversation-*.ts`).
- It is three things in one package: the Workbench application, a local Relay or Gateway server (`src/server/gateway*.ts`, `recorded.ts`, `local.ts`), and the harness for 93 Playwright specs.
- Imports across the intended boundaries: `@orchardworks/agent-remote-web/{react,headless,browser,device-store}` (about 107 imports, a proper contract), and `hosted` (9 test files), `relay` (4), `provider-codex` (4), `provider-dsh` (2) in tests.

`agent-remote-journal` (1,117 lines): journal store interface, session journal, items; in its sqlite sibling 205 lines. Depends on the protocol and, for two files, on `agent-remote-relay/timeline-projection`, so a store package depends on the Controller-side projector (see leak L5).

Providers: 1,900 to 5,600 lines each, one SDK dependency, 18 (Claude), 12 (Codex) and 8 (Copilot) recorded journal fixtures. These are the best seams in the repository.

## 3. Seams

### 3.1 Contract and fixture presence per boundary

| Seam | Explicit contract | Fixture or mock data at the seam | Tests that cross it with real neighbours |
|---|---|---|---|
| Provider SDK to adapters | Types in `provider.ts`, `observation.ts`, `control.ts`; `contract.test.ts` (204 lines) as a shared conformance suite; `testing.ts` helpers | Journal recordings of the real CLIs: Copilot 8, Codex 12, Claude 18 JSON files, written by each provider's recorder (`journal-recording.ts`). Other provider tests use scripted fakes. | `agent-host/src/journal-continuity.recordings.test.ts` replays recordings through the Controller publisher. Good use. `*.local.test.ts` (14 in host, 19 Claude, 13 Codex) use the real CLIs. |
| Adapters to Controller (`agent-host`) | `AgentProviderAdapter` interface | `test-utils/` harnesses (842 lines): scripted session, relay-host loopback, journal window | Most `host*.test.ts` build real `createAgentHostRuntime` with scripted providers. Reasonable. |
| Controller to Relay (uplink) | Protocol: `remote-host-uplink`, `remote-host-journal`, `session-channel*`, codecs, `PROTOCOL_VERSION` | No wire fixture corpus: `agent-remote-protocol/test/fixtures` holds two legacy-team files. Wire examples live inline in tests. | `agent-host/test-utils/relay-host-harness.ts`, `journal-relay-loopback.ts` and 9 hosted tests wire both ends in-process; lab `remote-host-broker.test.ts` and `hosted-runtime.test.ts` use real sockets. |
| Relay state internals | `JournalStore`, `BrokerScheduler`, `RelaySocket`, `TeamResourceStore` ports; `journal-partition.contract.json` | In-memory stores in tests; `agent-remote-journal` ships a memory store | `broker*.test.ts` drive the whole closure for each rule. |
| Relay to client (session wire) | Protocol session channel (`session-channel`, `session-control`); web `client/` as the reference client | No recorded wire transcripts; web tests build their own fake servers | Lab `*.transport.test.ts` and `App.*.test.tsx` use a real in-process Gateway. |
| Client library to Workbench | `agent-remote-web` export map (`headless`, `react`, `browser`, `device-store`) | Web has its own `src/test` helpers | Lab App tests render with the real web library. Correct direction, but with a real server underneath. |
| Journal store to Relay | `JournalStore` interface; `journal-sqlite` implements it | `journal-partition.contract.json` | `agent-remote-cloudflare` (37 files) runs the Worker with real SQLite journals (65 s). |
| Compatibility manifest | `compatibility.json` plus `scripts/compatibility.mjs` | n/a | See 4.4. |

Summary: the Provider SDK seam is the only one with recorded real-world fixture data. The protocol seam has types and codecs but no corpus of messages shared by both ends; every consumer invents its own.

### 3.2 Leaks

L1. Fixtures read across packages by relative path. `agent-host/src/test-utils/recordings.ts` reads `../../../agent-provider-codex/src/journal-fixtures/`, `agent-provider-claude/src/journal-fixtures/` and `agent-provider-copilot/tests/fixtures/journal/`. The Controller tests are coupled to where each provider happens to keep a directory, and a recording is not part of any package's published contract. A Provider-owned `./recordings` export would fix it.

L2. Cross-package imports go through `dist`. Every package's `exports` point to `./dist/*.js`, with no Vitest alias to `src`. A test in `hosted` that imports the protocol package runs against the last build. A task that changes the protocol must build it before any dependent's test is valid, and a forgotten build gives a stale pass or a confusing failure. This is also why `verify:changed` builds all 20 packages first.

L3. Deep imports into other packages' internals. About 96 subpath imports exist, of which the web library's are intentional entries. Others reach into the Relay broker's internals: `@orchardworks/agent-remote-hosted/{controller-location (14), session-relations (6), relay-diagnostics (6), favorites (3), access-page (3), session-star-schema (2), succession-capacity, sessions, session-errors, request, journal-uplink}` from the lab and the Controller. The Controller (`agent-host`) imports Relay-broker modules (`hosted/journal-uplink`, `hosted/relay-diagnostics`, `hosted/controller-location`) and Relay-side projection code (`relay/timeline-projection`, 4 imports). Those are shared types that belong in the protocol package or in a small neutral package.

L4. Shared mutable state inside two closures. `createHostBroker` holds 20 or more `Map` and `let` variables that about 40 inner functions read and write (bindings, `nativeBindings`, `attached`, `creations`, `hosts`, `pairings`, `associations`, `revokedHosts`, `journalDeletions`). `createAgentHostRuntime` does the same for sessions, bindings, publications and succession. A change to one concern can change another, so tests can only enter by building the whole closure. The new J-modules (`host-journals`, `journal-session-stream`) show the way out, but the old concerns were not extracted.

L5. Names hide the layers. `agent-remote-hosted` is the Relay; `agent-remote-relay` is the Controller-side session manager, projector and wire. `agent-remote-journal` depends on `agent-remote-relay/timeline-projection`, so the journal store depends on the projector that lives next to Controller code. `agent-remote-relay` depends on the Provider SDK, so the "Relay" package knows provider types. A reader cannot tell from the graph which of these may call which.

L6. The Workbench is also a server. `agent-remote-lab/src/server` (2,739 lines) is a Gateway, a recorded-scenario server and a Controller bootstrap. Its tests start real servers: 53 lab test files use `listen`, `createServer` or a WebSocket server, and 7 `src` tests import `./server/*` directly. The client renderer is therefore tested against a real Relay when it needs only a transcript.

L7. Native runtime interpretation outside adapters. The Controller's `host.ts` holds one map that attaches journaled unowned Claude and Codex sessions (S6a release gate), and `session-succession-*` (2,000+ lines) interprets provider identities. These are intended Controller rules over SDK types, but they also mean provider behaviour is tested through the Controller. Keep them behind SDK types and test them with recordings.

L8. `compatibility.json` is read from `process.cwd()` by several lab tests (`live-plugin.test.ts`, `dsh-plugin-package.test.ts`), so they depend on the working directory and on the current provider matrix and protocol version.

## 4. Test inventory

### 4.1 Counts and wall time

Measured on this machine (Apple silicon, Node 22 as in CI) with `vitest run` per package, excluding `*.local.test.ts`. Another agent was working in the same worktree, so loads varied; read the numbers as one sample.

| Package | Files | Tests (Vitest) | Wall |
|---|---:|---:|---:|
| `agent-remote-lab` | 292 run | 2,853 | 85 s |
| `agent-host` | 149 run | 1,795 | 74 s |
| `agent-remote-cloudflare` | 37 | 239 (1 failed in this run: load, not investigated) | 65 s |
| `agent-remote-web` | 94 | 956 | 36 s |
| `agent-provider-copilot` | 20 | 169 | 18 s |
| `agent-remote-hosted` | 76 | 981 | 10 s |
| `agent-remote-relay` | 43 | 445 | 9 s |
| `agent-provider-codex` | 53 | 506 | 7 s |
| `agent-provider-opencode` | 15 | 190 | 4 s |
| `agent-remote-protocol` | 48 | 422 | 3 s |
| `agent-remote-journal` | 17 | 199 | 3 s |
| `agent-provider-claude` | 46 | 247 | 2 s |
| `agent-provider-dsh` | 16 | 191 | 1 s |
| `agent-provider-sdk` | 10 | 97 | 1 s |

Test suite subtotal for the packages above: about 9,300 tests in roughly 320 s of wall time when run one after another, which is what `pnpm test` does (`--workspace-concurrency=1`). With the build (`pnpm -r run build`), `pnpm typecheck` and `compatibility:check` in front, a full `pnpm verify` is more than the 540 s outer deadline of a single suite and takes several minutes longer. Not measured: debugger, remaining small packages, build and typecheck.

Playwright (not run here): 93 spec files, 375 tests, 18,000 lines; plus 20 `*.browser.ts` files (27 tests) under `vitest.preview.config.ts`. They need a browser and a started Vite and fixture Relay.

### 4.2 The biggest sources of time

| Source | Cost | Notes |
|---|---:|---|
| `lab/src/App.succession.test.tsx` | 74 s (163 tests) | Renders the whole `App` against a real in-process server. Sets the lab wall time alone. |
| Other lab `App*.test.tsx` | 54 s cumulative across 27 files | Whole-app renders; 28 files, 425 tests, 128 s cumulative (50 percent of lab worker time). |
| Lab `src/server/*` | 79 s cumulative, 42 files | `preview-tunnel` 16 s, `hosted-runtime` 15 s, `devbox-preview` 10 s, `connection-diagnostics` 8 s, `gateway-lifecycle` 7 s. Real sockets and timers. |
| Host process tests | 138 s cumulative, 25 files | `opencode-server-supervisor` 43 s, `cli-bootstrap` 20 s, `opencode-server` 16 s, `cli-codex` 15 s, `codex-daemon-runner` 12 s. Child processes, real timers. |
| Host succession tests | 91 s cumulative, 20 files | `session-succession-capacity` 19 s, `session-source-witness` 17 s, `session-succession-runtime` 16 s. |
| Cloudflare worker tests | 65 s | `--maxWorkers=1`; durable-object style runtime. |
| Web | 36 s, of which 23 s is jsdom environment setup | 94 files each paying jsdom start. |
| Build and typecheck | not measured | `verify` and `verify:changed` build every package (`pnpm -r run build`) and typecheck every package before any test. |

The cumulative figures sum worker time across parallel workers (lab 252 s of file time for 85 s wall; host 331 s for 74 s).

### 4.3 Classification into tiers

The owner's model: unit and integration tests always use mock data; e2e covers main flows and cases found by `pnpm local`; native tests stay opt-in. Today's tests, classified by what they actually do (estimates from file imports and names, accurate to about 10 percent):

| Tier | Where | Files | Tests (approx.) | Share of tests |
|---|---|---:|---:|---:|
| Unit, pure, mock data | protocol (all), journal, SDK, tunnel, platform, providers (scripted), web `client/` `replica/` `react/` hooks, relay projector and manager, lab view-model modules in `src/` (about 100 files, 774 tests), `src/hooks`, `src/components` (80 files, 781 tests, jsdom) | about 640 | about 6,200 | 66 percent |
| Integration with mock data | hosted `broker*.test.ts`, journal streams, host `host*.test.ts` with scripted providers, recordings replay (`journal-continuity.recordings`), `test-utils` harnesses, cloudflare worker tests | about 130 | about 1,700 | 18 percent |
| Integration that builds a real stack (should be mock-data integration or unit) | lab `src/*transport*.test.ts`, `src/server/*` (43 files, real Gateway, sockets, tunnels), 28 `App*.test.tsx` rendering the whole app over a real server, host process tests (CLI, OpenCode server, Codex runner) | about 120 | about 1,500 | 16 percent |
| E2E (Playwright, browser) | 93 specs, 375 tests; 46 of the specs render one component on a fixture page; 20 `*.browser.ts` | 113 | about 400 | not counted above |
| Local and native (real CLIs) | 14 host, 19 Claude, 13 Codex, 1 DSH, 2 lab `*.local.test.*`; `test:claude`, `test:opencode:native` | 49 | not measured | opt-in already |

The e2e figure is the right order of magnitude for a main-flow tier only if it shrinks to about 35 to 60 tests. See 7.3.

### 4.4 Couplings that force broad runs

1. `verify:changed` is a full run on this branch. It defaults to the merge base with `origin/main` (`0aaefda9`), 252 commits back. The branch changed `pnpm-lock.yaml`, `scripts/*`, `deploy/*`, `compose.yaml` and `README.md`, and any such file outside `packages/` and `docs/` triggers `exec pnpm verify`. Even when it does not, the dependents filter `...@orchardworks/agent-remote-protocol` selects 8 of 20 packages. Protocol, SDK and relay changes reach 7 to 11 packages each.
2. Every `pnpm test` goes through `-r --workspace-concurrency=1` with no per-package opt-out. The standard task (change a function, run its tests) has no documented command narrower than a package.
3. The implementation digest. `scripts/compatibility.mjs` hashes every tracked file under `packages/*`, `scripts/`, `package.json`, the lockfile and the workspace file into `compatibility.json`, so any commit changes it and `compatibility:check` fails until `compatibility:update`. As read from the code, the lab tests named in the task (`codex.test.ts`, `live-launcher.test.ts`, also `compatibility.test.ts`, `live-plugin.test.ts`, `dsh-plugin-package.test.ts`) do not hash the repository: they write a temporary `implementation.txt`, a fixed digest `sha256:d8fdc7cc...` and a temporary manifest. The two tests that copy the real `compatibility.json` (`live-plugin`, `dsh-plugin-package`) replace its `implementation` block the same way. So those tests should survive a source change, and they fail only on a real change of the protocol version or provider matrix. I did not edit code to prove this; run `pnpm --filter @orchardworks/agent-remote-lab exec vitest run src/server/codex.test.ts src/server/live-launcher.test.ts` after a source-only change to confirm. The digest still forces `pnpm compatibility:update` into `pnpm build`, so any build rewrites a tracked file and produces a one-line diff in every commit.
4. Lab tests that build the whole stack: 53 files start a server; whole-app tests pay for a Gateway, a Relay broker, a journal store and often a scripted Host each.
5. `dist` exports (L2) make dependents' tests depend on a build.
6. Lab has 93 Playwright specs that share one fixture Relay and one Vite dev server (`playwright.config.ts` with modes `recorded`, `interactions`, `codex`, `dsh`); a layout test needs the same stack as a flow test.
7. `agent-host` mixes session logic and process management in one package and one Vitest project, so a change to a pure rule runs the OpenCode supervisor tests (43 s).

## 5. Redundancy as a symptom: the modules that are missing

The owner's rule: redundant tests mean the module division is unclear. Where one rule is checked through several entry points, the rule has no home of its own, so every layer that touches it re-tests it. This section groups the repetition and names the module that should own each cluster.

Evidence method: keyword counts of test files and test titles across all packages (`grep` on the rule's vocabulary), plus per-package file inventories. Counts are lower or upper bounds depending on the keyword, so read them as orders of magnitude. One cluster (C1) was read in detail; the others need a per-file pass before any test is deleted.

### 7.1 Clusters and the missing module behind each

| # | Behaviour re-tested through many entries | Evidence | Missing module (no home today) |
|---|---|---|---|
| C1 | Succession, handoff, takeover, native attachment and refresh recovery | 160 test files and 150 titles mention handoff or succession. Source: `App.tsx` (3,765 lines), `broker.ts`, `host.ts`, `gateway.ts`, `useSessionSuccession.ts` (1,152), `session-succession-store.ts` (813) each hold part of it. Tests: lab `App.succession.test.tsx` (3,428 lines, 163 tests, 74 s) plus 41 other lab files, 40 host files (20 `session-succession-*`, 91 s cumulative, 4,944 lines), 11 hosted, 8 cloudflare, 4 protocol, 3 e2e specs | A client-side succession model (pure state machine: roles, committed operations, refresh and recovery states, deadlines) and a Relay-side association module with a stable function interface |
| C2 | Session control: lease, refusal reasons, native owner, restoring, offline Host | 50 files and 50 titles in host (25 files), lab (21), hosted (5), relay (5), web (2). Source: `broker.ts`, `agent-manager.ts` (1,124), `session-control.ts` in relay (105), `hosted/control.ts` (51), `remote-session-client.ts` (1,068), host session routes. S5 moved the lease to the Relay but its rules are spread over four packages | A Session Control module (lease state machine: acquire, hold, release, refuse with a reason, Host offline) with one transition table |
| C3 | The journal window decision: identical, extension, replacement; how a replica absorbs it | 192 files and 187 titles mention journal and replace or window. Tests in host (`journal-publication`, recordings, window harness: 26 files), hosted (18), journal (9), web replica (18), lab (67 files mention replacement), cloudflare (4), protocol (5), e2e `journal-replacement.browser.ts` | A pure journal-window module: `decide(tail, newest) -> unchanged, append or replace` and `absorb(replica, outcome)`, with shared vector fixtures that every layer consumes |
| C4 | Per-feature account state: outbox, drafts, reads, relations, rename, stars, favorites, migrations | The same feature has a test in up to six packages: outbox 7 files (protocol, hosted, cloudflare, web twice, host, lab), drafts 7, relations 7, reads 4, rename 4, stars 4. About 40 files. Cloudflare re-drives the Relay rule through a Worker socket: `cloudflare/test/session-outbox.test.ts` (108 lines) repeats the offline-Host outbox flow that `hosted/src/session-outbox.test.ts` covers | A storage contract for account state: the broker's commit and restore, tested once as a conformance suite for the memory store and for Durable Object storage. The Worker then proves persistence, not rules |
| C5 | Workbench rules driven through the whole `App`: cached content while checks wait, draft ownership, selection, recovery notices, window composition | 28 `App*.test.tsx` files, 425 tests, 8,593 lines, 50 percent of lab worker time; `App.tsx` has 3,765 lines of state and effects; 42 hook tests repeat parts | A Workbench state module (reducer: windows, selection, cached versus authoritative content, recovery notice) separate from rendering. Partial modules exist (`window-workspace.ts`, `conversation-recovery.tsx`) but `App.tsx` still owns the glue |
| C6 | Composer send states: pending, queued in the outbox, delivered, uncertain, failed, retry | 86 files and 61 titles mention composer, pending or send. Tests in web, 5 lab hooks and components, `App.outbox`, 6 e2e specs (`pending-send` spec and browser, `message-delivery`, `composer-send-press`, `composer-actions`), host and hosted outbox | A send-state machine in `agent-remote-web/headless`: transition table plus a view mapping. `message-recovery.ts` is a start |
| C7 | Host registration, capability negotiation, heartbeat deadlines | 303 files mention register, capability or heartbeat; heartbeat is tested in hosted (`broker-heartbeat`, 15 tests, 348 lines), cloudflare, relay (7 files), host (11), protocol, lab (5). Source: `register()` in `broker.ts` is about 280 lines, plus `disconnected` and `expire` | A Host Session module in the Relay: registration handshake, capability set, heartbeat and expiry, with `onMessage` and `tick` as its only inputs and the scheduler as a port. The Controller side of the same handshake is a mirror module in `host.ts` |
| C8 | Provider rules tested in the adapter and again in the Controller | 12 host test files import real provider packages (6 are `*.local`); 24 host test files build `createAgentHostRuntime`, and 4 build a real `createHostBroker` (`host.test.ts`, `host-journal.test.ts`, `session-succession-runtime.test.ts`, `tpm-host.test.ts`). A Controller test should never need a real Relay | A Controller-side provider facade that a test replaces with a recording: a scripted `AgentProviderAdapter` built from I1 recordings. Provider rules stay in the adapters; the Controller tests assert only the facade's calls |

Not clusters but worth noting: pairing is named in 97 files but only 32 titles, mostly auth plumbing in cloudflare (27 files) and lab server (38); the Controller update flow is 68 files and 26 titles, close to what it needs.

### 7.2 Why the same rule ends up in every layer

Three structural reasons, each visible in the counts:

1. The rule is inside a closure that cannot be entered alone. `createHostBroker` and `createAgentHostRuntime` close over their state, so the only way to test a succession or control rule is to build the whole broker or runtime (19 test files build the broker, 24 build the runtime) and drive it through messages, which is also how the next layer up tests it.
2. The rule's state transitions are not separate from I/O. `useSessionSuccession.ts` (1,152 lines) and `App.tsx` mix reducer logic with effects, so a state rule is reachable only by rendering `App` with a real Gateway.
3. The test of the rule at the lower layer has no shared fixtures, so each layer writes its own scenario. A shared vector fixture (C3) or a conformance suite (C4) turns N copies into one table plus N one-line consumers.

## 6. The extractions, ordered by value

For each extraction: what it owns, its public contract, what moves, its unit tests, the integration contract it exposes, and the tests and lines that go away elsewhere. Numbers are estimates: lines are "moved" (production) or "removed" (tests, replaced); test counts are what to remove or merge once the new unit suite exists.

Ranking criteria: redundancy removed, test time saved, risk. Effort is for one agent in a worktree. No extraction changes behaviour; each lands as a move plus its tests, then the duplicate tests are deleted in a later commit after a mutation check (break the rule, see the new unit test fail, see the old tests also fail, then delete the old ones).

### X1. Client succession model (C1, client side)

- Responsibility: the state of a session's succession on the client: roles, which operation is committed, refresh and recovery states, deadlines. Pure: events in, state and effects (as data) out.
- Public contract: `session-succession-model.ts` in `agent-remote-lab/src` (or `agent-remote-web/headless` if the Workbench is not the only client): `reduce(state, event) -> { state, effects }`; events are `replay_result`, `native_status`, `refresh_outcome`, `deadline`, `user_action`.
- Moves: the decision logic from `useSessionSuccession.ts` (about 700 of its 1,152 lines) and from the succession parts of `App.tsx`; the hook becomes about 300 lines that run effects.
- Unit tests with mock data: a table of event sequences replaces the scenarios of `App.succession.test.tsx`. About 120 of its 163 tests become table rows (each about 5 lines instead of about 20).
- Integration contract: the client-side effect list (`fetch replay`, `ask Relay for status`) maps to I4 transcripts; 8 to 10 integration tests over the fake Relay client.
- Removed elsewhere: about 3,000 lines of `App.succession.test.tsx`, and about 30 of the 41 other lab files' succession tests; 74 s to about 3 s in the lab critical path.
- Effort and risk: 4 to 5 days; medium risk (logic is entangled with effects), so extract with characterization: first run the existing App tests against the new hook, then add the table.

### X2. Relay session control (C2)

- Responsibility: the control lease of a session: acquire, hold, release, refuse with a reason (`owned`, `offline`, `restoring`, `read_only`), and the effect on journal-served and forwarded reads.
- Public contract: `session-control.ts` in `agent-remote-hosted`: `createSessionControl({ now, scheduler })` with `acquire`, `release`, `hostDisconnected`, `hostReturned`, and a pure `transition` table exported for tests; messages in the protocol package (already there).
- Moves: the lease code and the `hosted/control.ts` leftovers from `broker.ts` and `journal-sessions.ts` (about 250 lines), the matching Controller registry code that S5 deleted on one side, and the client's refusal-to-view mapping into `remote-session-client.ts` as one table.
- Unit tests with mock data: a transition table (each state, each event, the reason); about 40 rows replace about 35 tests spread over host (25 files mention it), hosted (5) and lab (21) that restate the transitions.
- Integration contract: I4 (session channel transcripts: `control refused`, `control granted`) and I3 for the Host going offline.
- Removed elsewhere: about 30 tests (estimate) in host, hosted and lab; about 800 test lines.
- Effort and risk: 3 days; low to medium. S5 just landed this rule, so the knowledge is fresh and the extraction can be cheap.

### X3. Journal window decision (C3)

- Responsibility: given the Relay's tail and the Controller's newest window, decide `unchanged`, `append` or `replace`; given a replica and that outcome, absorb it by item key. No I/O.
- Public contract: `agent-remote-journal/window.ts`: `decideWindow(tail, newest)`, and the client-side `absorbWindow(replica, outcome)` in `agent-remote-web/replica`; both exported from one fixture set `journal-window-vectors.json` (input, expected outcome), consumed by journal, web and the publisher tests.
- Moves: the compare logic in `journal-session-stream.ts` and `journal-publication.ts` (about 150 lines) and the absorption in the replica reducer (already about 200 lines there).
- Unit tests with mock data: about 40 vectors (S2 and S4a rules: identical, extension, anything else becomes replacement, prepend below a replacement, key-stable rows).
- Integration contract: I2 (recordings through the publisher into the memory store) and I4 (the open transcript). Keep `journal-continuity.recordings.test.ts` as the proof.
- Removed elsewhere: about 45 of the 187 titles that restate the decision in host, hosted, web and lab (estimate), and the lab `journal-served-reconnect` real-server variants (about 6 tests, 6 s).
- Effort and risk: 2 to 3 days; low, because the code is already split into small functions and S2 and S4a just defined the rule.

### X4. Account state storage contract (C4)

- Responsibility: committing and restoring the broker's account state (the `commit()` and `committedBrokerState` path), independent of where it is stored.
- Public contract: `AccountStateStore` conformance suite exported from `agent-remote-hosted/testing`; memory and Durable Object stores run it. The Worker keeps only tests that need the Workers runtime (socket upgrade, alarms, retention, storage envelope).
- Moves: no production code; the work is in tests: a shared conformance suite, and one smoke test per feature in `agent-remote-cloudflare`.
- Unit tests: the rules of outbox, drafts, reads, relations, rename, stars, favorites and migrations are tested once in `agent-remote-hosted` against the memory store (already true).
- Removed elsewhere: about 15 of the 37 `agent-remote-cloudflare` test files (outbox, drafts, reads, relations x2, rename, stars, favorites, migrations, session-states, parts of channels) collapse to one smoke file; about 60 tests and 1,500 lines; Cloudflare suite 65 s to about 25 s. The protocol and web-client copies of per-feature tests remain, because they test codecs and clients, not rules.
- Effort and risk: 2 to 3 days; low (test-only), but the owner must accept that Worker tests no longer re-run feature rules.

### X5. Host Session module on the Relay (C7)

- Responsibility: one Host connection's registration handshake, capability set, heartbeat and expiry.
- Public contract: `host-session.ts` in `agent-remote-hosted`: `createHostSession({ socket, scheduler, onRegistered, onClosed })` with `onMessage(message)` and `tick()` as inputs. The scheduler is already a port.
- Moves: `register()`, `disconnected()`, `expire()`, `send()`, `rpc()` and the heartbeat code from `broker.ts` (about 450 lines, lines 790 to 1,130), with their Host state fields (`generation`, `pending`, `streams`).
- Unit tests with mock data: `broker-heartbeat.test.ts` (15 tests, 348 lines) and the registration tests move to the new module and run with a fake scheduler and a fake socket, 1 to 2 s.
- Integration contract: I3 uplink transcripts.
- Removed elsewhere: heartbeat tests in cloudflare, relay and lab (about 12) become one transcript test; `broker.ts` drops by about 450 lines.
- Effort and risk: 4 to 5 days; medium: `register()` touches nearly every map of the closure, so it must go after the state object of X6 exists.

### X6. Broker state object and the remaining concerns (C1 server side, L4)

- Responsibility: pass the broker's shared maps as one explicit `BrokerState` that each concern receives, so each concern is a module with its own tests.
- Order of extraction from `broker.ts`: journal deletion (about 100 lines), device keys and pairing (about 300), succession associations (about 600, lines 279 to 686 and the freeze and prefix code), session relations (about 250), Call For Support (about 250), team delivery (about 200), sharing and previews (about 150).
- Public contract: each concern exports `createX(state, ports)` and pure `validX` guards; `broker.ts` becomes composition, expected under 900 lines.
- Unit tests: each concern's tests move out of `broker*.test.ts` (9 files, about 3,200 lines) into per-concern files at unit speed.
- Removed elsewhere: about 80 of the 809 hosted tests become cheaper (not removed); the 11 hosted and 8 cloudflare succession tests restating association rules fall to one per rule (about 15 tests).
- Effort and risk: 8 to 12 days in 7 independent steps; medium. Each step lands with its own tests; no behaviour change in a split commit.

### X7. Workbench state module (C5)

- Responsibility: windows, selection, cached versus authoritative content, recovery notice and draft ownership as a reducer.
- Public contract: `workbench-state.ts`: `reduce(state, event) -> state`; selectors for views. `App.tsx` renders and runs effects.
- Moves: the state logic of `App.tsx` (3,765 lines; about 1,500 of them are state and effects), merging the partial modules `window-workspace.ts`, `conversation-recovery.tsx`, `workbench-mode.ts`.
- Unit tests with mock data: table-driven; replaces about 260 of the 425 `App*.test.tsx` tests (the rest are render smoke tests, about 25 kept).
- Integration contract: I5, the fake Relay client playing I4 transcripts.
- Removed elsewhere: about 5,000 lines of `App*.test.tsx`; lab cumulative worker time 128 s to about 25 s.
- Effort and risk: 10 to 15 days; high, because `App.tsx` is the largest file in the lab and every Workbench feature touches it. Start after X1 because the succession part is the largest slice, then extract one slice at a time.

### X8. Send-state machine (C6)

- Responsibility: the composer's send states and retry rules.
- Public contract: `agent-remote-web/headless/send-state.ts`: `transition(state, event)` with states `idle`, `pending`, `queued`, `delivered`, `uncertain`, `failed`; and `describe(state)` that returns the plain words the UI shows.
- Moves: `message-recovery.ts` and `recovery-writes.ts` from lab, and pending logic from the composer hooks (about 400 lines).
- Unit tests: about 30 transition rows replace about 25 tests across web, lab and four e2e files; e2e keeps `pending-send` for one real send and one reconnect.
- Removed elsewhere: about 25 tests, about 600 lines; e2e `pending-send.spec.ts` shrinks from a 6-test spec to 2.
- Effort and risk: 2 to 3 days; low.

### X9. Controller facade and runtime split (C8, `host.ts`)

- Responsibility: separate "what the Controller does to a session" (catalog, attach, create, outbox delivery, directory, succession wiring, journal publication wiring) from process management.
- Public contract: `createSessionCore({ providers, relayLink, clock, store })` with the provider facade; `createAgentHostRuntime` composes it with processes.
- Moves: the 1,350-line closure of `createAgentHostRuntime` in 5 steps, as in X6; the tests that build a real `createHostBroker` (4 files) switch to the `relayLink` fake that replays I3 transcripts.
- Unit tests: 24 runtime-building test files keep working through the facade; 4 stop needing the Relay.
- Removed elsewhere: provider rules restated through the Controller (estimate about 40 tests) collapse to I1 conformance runs; process tests move to their own project (Q6: 138 s cumulative out of the default run).
- Effort and risk: 6 to 8 days for the runtime, 2 days for the process project; medium.

### 6.1 Order by value

| Rank | Extraction | Redundancy removed (tests) | Time saved (typical run) | Risk | Effort | Notes |
|---|---|---:|---|---|---|---|
| 1 | X4 Account state storage contract | about 60 (cloudflare) | cloudflare 65 s to 25 s | low | 2 to 3 days | Test-only. Biggest cost for the least code. |
| 2 | X1 Client succession model | about 150 | lab 85 s to about 30 s | medium | 4 to 5 days | Removes the single 74 s file; C1 is the largest cluster |
| 3 | X3 Journal window decision | about 50 | small; large in clarity | low | 2 to 3 days | Cheap and the rule is fresh from S2 and S4a. Do with the wire transcripts |
| 4 | X2 Relay session control | about 30 | small | low to medium | 3 days | Fresh from S5; best done right after S5 lands |
| 5 | X8 Send-state machine | about 25 | small | low | 2 to 3 days | Removes an e2e spec and a main-flow ambiguity (F2) |
| 6 | X9 Controller split (process project first) | about 40 | host 74 s to about 35 s | medium | 2 days for the project, 6 to 8 for the runtime | The project split is a quick win (Q6) |
| 7 | X5 Host Session module | about 12 | small | medium | 4 to 5 days | Needs X6's state object first |
| 8 | X6 Broker state object and concerns | about 15 | hosted 10 s to about 6 s | medium | 8 to 12 days | Largest effort; each step independent |
| 9 | X7 Workbench state module | about 260 | lab cumulative 128 s to about 25 s | high | 10 to 15 days | Largest removal; leave for after X1 and after the Codex and Claude baseline |

Totals if all nine land: about 640 tests removed or merged and about 20,000 test lines out, 1,000 to 1,500 production lines moved (not added), `broker.ts` below 900 lines, `host.ts` below 900 lines, `App.tsx` below 2,000 lines. These are estimates; the per-file pass before each step may move them by a third either way.

The order interleaves with the S-steps: X2 after S5, X3 with S6b, X4 and X8 at any time (no wire change), X1 before the next Workbench feature that touches succession.

### 6.2 Supporting boundary changes

These make the extractions testable at their seams.

| Step | Change | Effort | Serves |
|---|---|---|---|
| B1 | Vitest `resolve.alias` from workspace packages to `src` in test configs | 0.5 day | All; dependents stop needing a build |
| B2 | Provider-owned recordings export; `agent-host/test-utils/recordings.ts` reads through it | 0.5 day | I1, C8, L1 |
| B3 | Wire transcripts with a player and recorder in `agent-remote-protocol/testing` | 2 to 3 days | I3, I4, I5; X1, X2, X5, X7, X9 |
| B4 | Move shared types the Controller imports from hosted and relay into the protocol package | 2 days | L3, L5 |
| B8 | Take `src/server` out of the Workbench package | 4 to 6 days | L6; after X7 |
| B9 | Rename or document `agent-remote-relay` versus `agent-remote-hosted` | 0.5 day docs, 3 days renames | L5 |
| B10 | `compatibility.json` resolved from an explicit path, never `process.cwd()` | 0.5 day | L8 |

## 7. Test layering and runs (they follow from the extractions)

### 7.1 The model: three tiers plus a native tier

| Tier | What it tests | Neighbours | Data | Runs |
|---|---|---|---|---|
| Unit | One module's behaviour through its public functions | None; ports replaced by stubs | Mock data, small literals or the module's own fixtures | Always, on every save or task; target under 10 s per package |
| Integration | Two or more real modules wired through a written contract | Real modules inside the seam; everything outside replaced by fixtures | Seam fixtures: recordings, wire transcripts, in-memory stores | After a change to a module that is on a seam; per seam, target under 30 s |
| E2E | A main flow through the real client in a browser against a real Relay and Controller with scripted provider | Real, in one process tree | Scripted provider, not a live model | At stage end, before a merge or release, and for a regression found by `pnpm local` |
| Native (opt-in) | A real CLI, a real model, real terminals | Real | None | By hand or nightly (`pnpm test:local`, `test:claude`, `test:opencode:native`); never in a task loop |

Rule 1: unit and integration tests never start a network listener, never spawn a process, never read the clock or home directory. The ports exist for that (`BrokerScheduler`, `RelaySocket`, `JournalStore`); the work is to apply them.
Rule 2: a new e2e test is added for a main flow, or for a defect found with `pnpm local`, together with the unit or integration test that explains why it broke. The e2e test then stays short.

### 7.2 The integration map: contracts per seam

Each seam below needs one short contract document (who calls whom, which messages, which guarantees), one fixture set that both sides consume, and a small integration suite. "Doc" can be a section in an existing document; the point is that it exists and is linked from the test.

| # | Seam | Who calls whom | Contract document (new or existing) | Mock and fixture data | Integration tests (keep) |
|---|---|---|---|---|---|
| I1 | Adapter to SDK | Controller calls `AgentProviderAdapter`; adapter emits observations | `docs/current/agent-remote/providers.md`, `provider-onboarding.md`; add the observation ordering and the "never live-only at open" rule from S6a | Recordings per provider (Claude 18, Codex 12, Copilot 8) exposed as `@orchardworks/agent-provider-<x>/recordings` | One shared conformance suite (`contract.test.ts`) run against each adapter with its recordings |
| I2 | Controller publisher to journal | `journal-publication.ts` offers windows to the Relay journal service; the Relay answers `unchanged`, `appended` or `replace` | `docs/superpowers/specs/2026-11-16-journal-simplification.md` plus a short seam page | Recordings replayed through the publisher against the in-memory `JournalStore` (already in `journal-continuity.recordings.test.ts`) | Recordings x publisher x memory journal; sequence gaps; replacement |
| I3 | Controller uplink to Relay broker | Controller sends `remote-host-uplink` messages; broker sends RPC requests and control | `docs/current/agent-remote/relay.md` plus a message table generated from protocol types | Wire transcripts: JSON-lines files of one scripted session per scenario (connect, heartbeat, attach, journal open, control acquire, revoke) recorded once from the in-process loopback; both ends replay them | Host runtime against a transcript player; broker against a transcript recorder. One loopback test with both real ends over a `RelaySocket` pair |
| I4 | Relay broker to client | Client opens a session channel; Relay serves journal-backed and forwarded reads, control leases | Protocol session-channel docs plus `2026-11-17-s5-relay-owned-session-control.md` | Session-channel transcripts: server frames for open, replace, append, control refused, offline Host | Web `client/` against a transcript server; broker against a scripted client |
| I5 | Client library to Workbench | Workbench components call `agent-remote-web` hooks | The export map (`headless`, `react`, `browser`, `device-store`) | A fake Relay client that plays the I4 transcripts in-process, no Gateway | Component and hook tests over the fake client |
| I6 | Relay to journal store | Broker calls `JournalStore`; Worker uses the sqlite store | `journal-partition.contract.json` and `JournalStore` docs | In-memory store; one shared store conformance suite | `journal-sqlite` and the memory store run the same suite; Cloudflare tests only cover the Worker glue |
| I7 | Compatibility and release | Controller reports version; Relay compares; the deploy checks the manifest | `controller-updates.md`, `protocol-upgrade-runbook.md` | Release metadata fixtures | The Controller update flow (also an e2e main flow) |

The new artefact is the wire-transcript fixtures (I3 and I4). They also make protocol changes testable by updating one fixture: the owner's complaint that "no clear boundary, no way to use mock data" lands exactly here.

### 7.3 E2E: the main flows and what to do with today's tests

The owner's list of main flows, with today's tests that cover them:

| # | Main flow | Today's tests (approx. tests) | Keep as e2e |
|---|---|---|---|
| F1 | Open and read a session | `simple-conversation`, `workbench`, `timeline-time`, `markdown-reading`, `trace-inspection` specs (29 tests); `timeline-scroll.browser.ts`, `timeline-tools.browser.ts` | 4 to 6 |
| F2 | Send a message and receive the reply | `message-delivery`, `composer-send-press`, `pending-send`, `ask-session` specs (23 tests); `pending-send.browser.ts` | 4 to 6 |
| F3 | Reconnect and return | `session-connection-errors`, `seamless-access` specs (7); `session-recovery.browser.ts`, `journal-replacement.browser.ts`, `device-store*.browser.ts`, `session-live-cache.browser.ts` | 6 to 8 |
| F4 | Take over a session | `session-succession`, `session-succession-joined`, `session-view-ownership`, `native-session-commands` specs (25); `session-control-refusals.browser.ts` | 4 to 6 |
| F5 | A terminal-driven session stays current | Currently only `local` and `*.local.test` (Claude, Codex terminals); S6a gate | 2 to 3 (scripted provider that writes a journal line; real terminals stay native) |
| F6 | Update a Controller | `controller-updates.spec.ts` (1 test), `controller-updates*` suites | 1 to 2 |
| Local findings | S4 reading-anchor drift, Claude terminal fork, Codex terminal holes under debugging | Partly `session-forks`, `timeline-scroll` | Add each as one e2e test plus the unit test that explains it (rule 2) |

Total target: 35 to 60 e2e tests (from about 400), run against one shared stack per run.

Everything else moves down:

- Component layout tests (82 tests in `layout`, `viewport`, `mobile`, `resize`, `overflow`, `placement`, `responsive`, `sidebar` specs, plus 201 tests in 46 specs that render a single component on a fixture page): these do not need a Relay. Keep them as browser-component tests with their own Vitest or Playwright project, on a fixture page with mock data (no Relay, no recorded scenario). About 200 tests stay in this "browser component" tier, outside the main-flow e2e. They need a browser, so they run on demand and at stage end, not per task.
- Lab `App*.test.tsx` (28 files, 425 tests): move to mock data. Replace the real Gateway with the fake client that plays I4 transcripts (B3, B8). The 163 tests in `App.succession.test.tsx` are the first target; they should become table-driven transcripts at the client seam (about 120 of them) and about 10 integration tests at the Relay seam.
- Host process tests (25 files): keep, but run in a separate Vitest project (X9, Q6) and only when `cli`, process or service files change.

### 7.4 Test moves outside the extractions

Beyond the extractions in section 6 (about 640 tests removed or merged), these tests move tier. Counts are estimates from file names and one measured profile.

| Move | From | To | Tests |
|---|---|---|---:|
| Lab server tests that use real sockets for logic (`gateway-*`, `connection-diagnostics`, `session-directory`, `pairing-lifecycle`) | lab `src/server`, real Gateway | broker unit or integration with a fake `RelaySocket`; about 60 real-socket tests stay | about 120 of 299 |
| Transport tests in lab `src/` (`*transport*`, `journal-served-reconnect`, `conversation-connections*`) | real server | I4 transcript tests in `agent-remote-web` | about 40 |
| Duplicate Playwright specs once the lower tier exists (`session-succession*`, `session-forks`, `session-stars`, `session-title-*`, `favorites*`, `pairing-keys`, `session-unlink`) | e2e | delete after a mutation check | about 60 to 90 |
| Layout e2e (201 fixture-page tests) | e2e | stay as the browser-component tier | 0 |
| Main-flow e2e | about 400 e2e and browser tests | 35 to 60 flow tests plus about 200 component tests | about 110 to 140 move down or go |

Deletions need the owner's agreement per area; "duplicate" is a candidate, verified file by file before deleting.

### 7.5 Test layering scheme

Naming (no new directories needed):

| Suffix | Tier |
|---|---|
| `*.test.ts` | Unit |
| `*.integration.test.ts` | Integration (seam name in the first `describe`, for example `describe('I3 uplink', ...)`) |
| `*.process.test.ts` | Unit tests that need child processes or real timers (host process tests, `preview-tunnel`) |
| `*.browser.ts` and `e2e/*.spec.ts` | Browser; main-flow specs go in `e2e/flows/`, component layout specs in `e2e/components/` |
| `*.local.test.ts` | Native (already the convention) |

Vitest projects per package (`vitest.workspace.ts` or `projects` in the config):

```
unit         include: **/*.test.ts(x)  exclude: *.integration.*, *.process.*, *.local.*
integration  include: **/*.integration.test.ts
process      include: **/*.process.test.ts   (maxWorkers=1, long timeouts)
local        include: **/*.local.test.ts     (opt-in)
```

Root scripts:

| Command | Runs | When |
|---|---|---|
| `pnpm test:unit [pkg]` | unit project of the selected packages | every task |
| `pnpm test:seam I3` | the integration suites tagged for one seam (a `--project` plus a name filter) | after a change on that seam |
| `pnpm test:affected` | unit and integration of changed packages and, one level up, their direct dependents' integration only | before commit |
| `pnpm test:e2e:flows` | `e2e/flows` | stage end, merge, release, after an F-flow change |
| `pnpm test:e2e:components` | `e2e/components` | after a CSS or component layout change |
| `pnpm test:local`, `test:claude`, `test:opencode:native` | native | by hand or nightly |
| `pnpm verify` | everything above except native, plus compatibility, build and typecheck | stage end, merge, release |

Which tier a change needs:

| Kind of change | Required |
|---|---|
| A pure function, a codec, a view model | Unit of that package (about 1 to 5 s) |
| A provider adapter | Unit and I1 conformance with its recordings; native only when the CLI version changes |
| Journal publisher or store | I2 and I6 |
| A broker concern (pairing, journals, succession) | Unit of the extracted piece, plus I3 |
| A protocol message | The transcript fixtures (I3, I4), then the producing and consuming unit suites; both ends run on the same fixture |
| A Workbench component or hook | Unit and I5; browser-component only for layout |
| A reconnect, takeover or pairing behaviour | Integration over a real transport (a `RelaySocket` pair or a local socket) plus the matching F-flow e2e |
| A Controller process or service | The `process` project |

### 7.6 Change-scoped runs

1. `verify:changed` with a task base. Accept a base commit or a tag written at the start of a task (`git tag task-base` or `pnpm task:start`, which records `HEAD` in `.git/arc-task-base`). Default to that file; fall back to `origin/main` only when absent. On this branch it would pick the files changed in the last task, not 252 commits.
2. Drop "outside `packages/` and `docs/` means full `pnpm verify`" for `scripts/` that tests cover (`scripts/*.test.mjs`): run only those node tests. Keep the full run for `pnpm-lock.yaml`, `package.json` and workspace files.
3. Build only what the tests need: with B1 aliases, unit tests do not need a build. `verify:changed` builds the changed packages and their dependents only for the typecheck; `pnpm -r run build` becomes `pnpm --filter ...[base] run build`. The `...[commit]` filter is broken in nested worktrees (as the script notes), so use the existing `affectedFilters` helper.
4. Vitest `--changed <base>` or `related <files>` inside one package: after B1, `vitest run --changed <base>` selects tests whose imports changed. Use `related` for a single-file save loop. Both depend on the import graph being honest: the lab's whole-app tests import almost everything, so they run on any change until they are moved down (section 6, 7.4).
5. Digest. Remove `compatibility:update` from `pnpm build` and run it only in `pnpm verify`, the stage-end gate and the release. Make `compatibility:check` the only consumer of the digest: confirm that no test reads the real digest (L8, B10). Then no commit changes `compatibility.json` implicitly, no task rebuilds after a source edit just to refresh it, and the lab's compatibility tests assert only the manifest's shape.
6. Per-task loop: edit, `pnpm test:unit <package>` (or `vitest related`), then the seam suite if on a seam. The Vitest per-test and the outer process deadlines in `scripts/run-tests.mjs` stay, applied to every new command.

### 7.7 The full gate

Run `pnpm verify` (compatibility update, build, typecheck, all unit and integration projects, process project, e2e flows, e2e components) only:

- at the end of a stage (S-step) and before a merge to `main`;
- before a release (`pnpm verify` is already the release gate);
- after a change to a shared package (protocol, SDK) that touches more than three dependents, as a single run, not per commit.

Native tests (`test:local`) stay opt-in, run per provider upgrade and after a change to an adapter's native handling, as already documented.

### 7.8 Expected effect (typical per-task time)

Typical tasks, measured baseline versus target. The baseline for a protocol-touching or branch-wide task is `pnpm verify:changed` (full run here); for a package-local task it is `pnpm --filter <pkg> test`. The after numbers are estimates.

| Task | Today | After quick wins | After restructuring |
|---|---|---|---|
| Edit a pure function in `agent-remote-web` | 36 s package run, or full `verify:changed` | 36 s package run, or 8 s `related` | 2 to 5 s |
| Edit a broker rule in `agent-remote-hosted` | 10 s package, but lab and host dependents run via `verify:changed` | 10 s, scoped base | 3 s unit + I3 4 s |
| Edit a provider adapter | 2 to 18 s package; host dependents via `verify:changed` | 2 to 18 s plus I1 against recordings | 5 s |
| Edit a Workbench component | 85 s lab suite (whole-app tests dominate) | 15 s with `related` (excluding `App.succession`) | 5 to 10 s |
| Change a protocol message | Full verify, 8 to 12 minutes with build | Dependent unit suites only, about 3 minutes | Transcript fixture + both ends, 20 to 40 s |
| Stage end or merge | Full verify | Full verify | Full verify, expected 5 to 7 minutes after the moves in sections 6 and 7.4 (e2e flows 4 to 6 minutes included) |

Typical per-task time: about 3 to 10 minutes now (a package suite, or `verify:changed` that becomes full) to 10 to 40 seconds after both phases; about 1 minute after the quick wins alone for tasks in one package.

### 7.9 Quick wins (a few hours each; none needs the Codex and Claude work to be finished, but they touch config and scripts only)

| # | Win | Effort | Effect |
|---|---|---|---|
| Q1 | `verify:changed` takes a task base from `.git/arc-task-base` (or `$ARC_TASK_BASE`); a `task:start` helper writes it; keep `origin/main` as fallback | 1 to 2 hours | Removes the "tests everything on a long branch" cost |
| Q2 | In `verify:changed`, only `package.json`, the lockfile and workspace files force a full verify; `scripts/*.test.mjs` run alone; `deploy/` and `README.md` run nothing | 1 hour | Branches with infra edits stop going full |
| Q3 | Add `pnpm test:unit -- <package> [file]` that runs one package's Vitest (with `--changed`) under the existing deadline | 1 hour | The per-task loop has a documented command |
| Q4 | Move `compatibility:update` out of `pnpm build` and into `verify` and release scripts | 1 to 2 hours (check `scripts/` callers and CI first) | No implicit tracked-file change from a build |
| Q5 | Vitest alias from workspace packages to `src` in test configs | 3 to 4 hours | Dependents' tests stop needing a build (B1); verify with one package first |
| Q6 | Exclude process tests (`cli-*`, `opencode-server*`, `codex-daemon-runner`, `vscode-tunnel*`) from the default host run through a name list, with a separate `test:host:process` command | 2 hours | Host default run drops from 74 s to about 35 s |
| Q7 | Split `App.succession.test.tsx` into 4 to 6 files by describe block | 2 to 3 hours | Lab wall time from 85 s to about 30 s (the 74 s file is one worker today; splitting lets 50 percent workers share it) |
| Q8 | Skip jsdom for web tests that do not use the DOM (`// @vitest-environment node` per file for `client/` and `replica/`) | 2 hours | 23 s of environment start in web; web 36 s to about 20 s |
| Q9 | Write the layer table (7.2 first column, plus the package-to-layer mapping) into AGENTS.md or a linked doc | 1 hour | Removes the naming confusion (L5) at no code cost |

Q1 to Q4 and Q6 to Q9 do not touch product code. Q5 changes Vitest configs only; per the current instruction, do none of this while the Codex and Claude debugging is still using this worktree.

## 8. Risks and what isolation can miss

| Risk | Mitigation | Minimal seam-crossing tests to keep |
|---|---|---|
| Mock data drifts from what the real side sends | Fixtures are recorded from the real thing, not written by hand; B3 transcripts come from a loopback run with both real ends; a native job re-records recordings on a provider upgrade and fails on a diff | One loopback test per seam with both ends real (I3 over a `RelaySocket` pair; I4 over a local WebSocket) |
| A protocol change passes both lower-tier suites but the ends disagree | Both ends consume the same transcript fixture, so they cannot disagree about it | The loopback test above; version negotiation test across `PROTOCOL_VERSION` |
| Timing and ordering (reconnect, heartbeat, replacement) is only visible with real clocks and sockets | Keep a handful of tests with real sockets and a deterministic scheduler for reconnect and takeover, as AGENTS.md requires for protocol, pairing and reconnect changes | About 15 tests: reconnect after socket close, heartbeat timeout, pairing key use and revoke, control lease takeover, journal replacement while connected, Controller restart |
| The browser behaves differently from jsdom (focus, scroll anchors, IME, keyboard) | Layout and scroll tests stay in the browser-component tier; S4's reading-anchor drift stays an e2e case | `timeline-scroll`, `mobile-keyboard-controls`, composer input tests |
| Real CLIs change their output | Native tier stays opt-in per provider; recordings are versioned with the CLI version in `compatibility.json` | `test:claude`, `test:opencode:native`, `test:codex-shared` on upgrade |
| Deleting duplicates removes the only test of a behaviour | Verify each candidate by breaking the rule and watching the lower tier fail first | n/a |
| Change-scoped runs miss a dependent that did not import the changed file | The import graph is honest only after the alias (B1) and after whole-app tests stop importing everything; full gate at stage end catches the rest | The full gate |
| The digest removal hides a drift of `compatibility.json` from the source | `compatibility:check` remains in `verify`, release and CI | n/a |
| Splitting broker and Controller closures changes behaviour | One concern per commit with its extracted unit tests; the old closure tests stay green until the last step; no behaviour change in a split commit | The existing `broker*.test.ts` and `host*.test.ts` become integration tests rather than being deleted |

## 9. Decisions for the owner

1. Approve the three-tier plus native model and the 35 to 60 e2e target, and name the main flows for sure (the list in 7.3 is the coordinator's; F5 and F6 are thin today).
2. Approve deletion of duplicate e2e tests after their lower tier exists (about 60 to 90 tests; per-area sign-off).
3. Approve moving the Workbench server out of the lab package (B8) and renaming the Relay and Controller packages (B9), which touch every import.
4. Choose whether the browser-component tests (about 200) stay with the lab or move into `agent-remote-web`.
5. Choose when the digest leaves `pnpm build` (Q4): before or after Codex and Claude baselining.
7. Approve test deletion per extraction only after its mutation check (6, intro).
8. Confirm the order: Codex and Claude work first as the baseline, then Q1 to Q9, then the extractions in the order of 6.1 (X4, X1, X3, X2, X8 first), with B3 and B4 beside the next wire change.

## 10. What I did not verify

- Per-test times beyond Vitest's per-file totals; the Playwright and browser suites were not run; the build and typecheck times were not measured; `agent-remote-debugger` and the remaining small packages were not timed. One `agent-remote-cloudflare` test failed in my run under load and was not investigated.
- The tier shares and the move counts are estimates from imports and file names; they need a per-file pass before any deletion.
- The digest claim in 4.4 is from reading the tests; I did not run them after a source edit because I was not to change code.
