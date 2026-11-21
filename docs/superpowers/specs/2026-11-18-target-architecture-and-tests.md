# Target architecture and test architecture

Status: design for the owner's decision, 2026-11-18. Analysis and target only; no code was changed.
Baseline: tag `baseline/im-session-2026-11-18` on `design/im-session-service`.
Inputs: [module boundaries and test layers](2026-11-17-module-boundaries-and-test-layers.md) (the assessment; its X1 to X9 and Q1 to Q9 are used by name), [IM session service design](2026-11-15-im-session-service-design.md), [journal simplification](2026-11-16-journal-simplification.md), and the plans S1 to S6a.
Quick wins already landed before this document (read from the repository): `workspaceSource` Vite alias to `src`, `pnpm test:unit <package>`, `pnpm task:start` with a task-based `verify:changed`, the Controller `process` Vitest project, `.test.tsx` files that need no DOM running in `node`.

## The owner's goal and model

"为当前的项目梳理出更加合理的抽象，使得修改影响到的测试范围也合理，组件内的测试要有单元测试，单元测试要有mock data，组件和组件之间要有集成测试，也是靠mock data，e2e测试其实不用太多，主流程覆盖到就可以。smoke test可以有，就类似于我们现在的本地测试，只是模拟的更加极端。目前的问题是修改代码影响到的测试范围太大，测试的时间有太长，很多冗余测试的同时，测试也没有章法，必须要梳理清晰，配合这件事情要梳理项目的抽象概念和结构。"

"项目的架构和模块可以为了层次更清晰而重构" (the owner, later the same day). This document therefore designs the target as it should be, and sequences the move to it in small steps. Package renames and splits are allowed where they make a layer or a dependency direction clearer. The public Remote protocol and the Provider SDK stay as the stable published boundaries; changes to them follow the upgrade rule (compatibility only through an upgrade, and the owner updates every Controller).

The house model, which every rule below serves:

- Every component has a purpose designed before assembly, so it is tested alone with mock data: a **unit test**.
- How components connect is specified in advance, so each connection is tested with mock data against that specification: an **integration test** of a **seam**.
- **E2E** covers the main flows and the cases that local real-world testing found. **Smoke** tests are `pnpm local` with real CLIs and a real browser, under more extreme conditions.
- Redundant tests mean an unclear module division: extract the missing module. A mock-data test over 1 s is wrong; over 300 ms needs a look.

## 1. Layers and rules

### 1.1 Layers

| Layer | Contains | May import |
|---|---|---|
| L0 Contracts | Public wire protocol, Provider SDK port | Nothing in the workspace |
| L1 Domain | Pure rules: timeline projection, the journal, lease and window decisions, replica reduction, send and succession state machines | L0, L1 |
| L2 Application | Use cases that own state behind ports: Relay core, Controller session core and publisher, session runtime, client connection and session client | L0, L1, L2 (by public entry) |
| L3 Adapters | One technology implementing a port: providers, SQLite and Cloudflare stores, Node and Workers hosts, browser and React bindings | L0, L1, L2 of the package that declares the port |
| L4 Apps | Composition roots and entry points: Controller process, Relay hosts, Workbench, debugger CLI | Any lower layer |
| Test support | Mock data, seam tests, e2e and smoke | Anything, through public entries |

A "port" is an interface declared by the application module that needs it (`JournalStore`, `AccountStateStore`, `Scheduler`, `RelaySocket`, `Clock`, `ProviderFacade`, `RelayLink`, `DeviceDatabase`, `Transport`). The adapter implements it; the application never imports the adapter.

```mermaid
flowchart TB
  apps["L4 Apps: Controller process, Relay Node host, Relay Cloudflare host, Workbench, debugger"]
  adapters["L3 Adapters: providers, SQLite store, Cloudflare partition, browser and React client"]
  application["L2 Application: relay-core, controller session core and publisher, session-runtime, client"]
  domain["L1 Domain: timeline, journal, lease table, window decision, replica reducer, state machines"]
  contracts["L0 Contracts: protocol, provider-sdk"]
  apps --> adapters --> application --> domain --> contracts
  apps --> application
  adapters --> contracts
```

### 1.2 Rules

Each rule is checked by `pnpm arch:check` (section 5.9) and fails the build.

1. **Direction.** Imports run down the table only. A package imports another only through its `exports` map; no deep imports, no relative paths across packages, no `dist` paths.
2. **Contracts are leaves.** Protocol and SDK import nothing from the workspace. Types that two sides share (controller location, diagnostics, session-relation, star and error schemas) live in the protocol, never in a Relay or Controller package.
3. **The domain is pure.** No `node:*`, DOM, timers, `Date.now`, `Math.random`, sockets or storage. Time and ids are injected values; decisions return effects as data.
4. **Application modules own state behind ports.** One module owns each piece of mutable state; others receive it through a port or a function. No `Map` or `let` shared by closure across concerns.
5. **Adapters implement one port family and know one technology.** They never import each other. Provider adapters import only the SDK and their native client library.
6. **The Relay does not know the Controller or the client.** Relay core never imports providers, the session runtime, the Controller or the client library.
7. **The Controller does not know the Relay's code.** It talks to the Relay only through the protocol and its own `RelayLink` port. It names concrete providers only in `providers.ts`, its composition root.
8. **The client does not know the Relay or the Controller.** It imports the protocol only. The headless client imports no React, DOM, IndexedDB or global `fetch`; those are adapter ports.
9. **Native runtime interpretation lives in adapters.** Controller modules that act on provider identity (succession, native owner) read SDK types only.
10. **Composition roots wire and do not decide.** A root is under 900 lines and holds no rule state.
11. **Test support crosses layers only through public entries.** A test never reads another package's files by path. Mock data comes from the owning package's `./testing` entry or from `agent-remote-fixtures`.
12. **A rule has one owner.** If the same rule is asserted in the unit tests of two modules, one of them is not the owner; move the rule or the test (section 5.8).

## 2. Glossary

Each term has one meaning and one owner module (target names, section 3). "Retired" names stay in old code until the migration step that renames them; new code and documents use the chosen name.

### 2.1 Deployment and roles

| Term | Meaning | Owner | Decision |
|---|---|---|---|
| Relay | The service between browsers and Controllers: accounts, bindings, journals, control leases, outbox, sharing | `agent-relay-core` | Gateway is only its HTTP edge module; Broker is retired: `createHostBroker` becomes `createRelay` |
| Host | A machine registered at the Relay: `hostId`, capabilities, binding to an account. A record, not a process | relay-core `host-session` | One meaning. Never used for the process |
| Controller | The process on a Host that runs providers and keeps the uplink | `agent-controller` | Retires "agent host", `createAgentHostRuntime` (becomes `createController`) and the directory name `agent-host` |
| Uplink | The Controller's one authenticated socket to the Relay | protocol `remote-host-uplink` | |
| Provider adapter | Implementation of the SDK port for one native runtime; owns all native interpretation | `agent-provider-*` | |
| Native session | The provider's own session record and id (a Codex thread, a Claude session file) | the adapter | |
| Session | The public session: `[hostId, providerId, nativeSessionId]` (`SessionIdentity`) | protocol | `agentId` is a Controller-local handle to a runtime; no new code calls a session an "agent" |
| Runtime | The resident adapter handle for a session on a Controller (`AgentSession`); absent while the session sleeps | `agent-session-runtime` | |
| Native owner | Who holds the native session now: a terminal (`native_cli`) or the Controller. Detected by the Controller, held by the Relay as a per-stream fact | controller `native-owner` | |
| Control lease | The Relay-issued right of one browser stream to mutate a session: `revision`, `token`, `access`, `available` | relay-core `session-control` | One owner after S5; the lease registry in the runtime package is direct-serve only |
| Take over | A person interrupts a terminal owner and attaches the Controller | controller `native-owner` | Not "succession" |
| Succession | Moving a conversation to another provider or native session, keeping its identity in the Workbench | controller `succession`, relay-core `succession-associations`, client `succession` | "Handoff" survives in product text only |
| Pairing key | A temporary, process-local credential that binds a Controller or browser | relay-core `pairing-keys` | |

### 2.2 Conversation data

| Term | Meaning | Owner | Decision |
|---|---|---|---|
| Row | One provider-level canonical timeline row (`CanonicalTimelineRow`) before folding | `agent-timeline` | |
| Item | The folded unit a reader sees (a message, a tool call, reasoning), made of rows | `agent-timeline` | |
| Item key | The stable identity of an item across reopen, assigned by the adapter (`ProviderItemIdentity.key`); also the client's row key | SDK (type), `agent-timeline` (use) | Retires row source keys and `${epoch}:...` keys |
| Timeline | The ordered projected entries of a session as a client reads them (`ProjectedTimelineEntry`) | protocol (shape), `agent-timeline` (projection) | |
| Journal | The Relay's durable store of one session's items, in sequence, under a generation and an epoch | `agent-remote-journal` | One journal per session |
| Epoch | One rewrite-free run of a journal's sequence; a replacement starts a new epoch | journal | Not a generation |
| Generation | The fencing number of the current publisher connection; a stale generation cannot write | journal | |
| Sequence | Dense position within an epoch (negative for prepended older history) | journal | |
| Item window | The newest bounded run of items a Controller offers on open; the Relay answers unchanged, append or replace | journal `window-decision` | The bare word "window" is not used for this; code names it `ItemWindow` |
| Head | The latest Snapshot the Controller published plus presence the Relay computes | journal | |
| Snapshot | The display state of a session: status, pending interactions, usage | protocol | |
| Publisher | The Controller module that offers item windows and live rows to the Relay journal | controller `publisher` | |
| Stream | One session's live feed over one connection. Qualified as the browser's session stream or the Relay-Controller host stream | relay-core `journal-service` and `edge` | |
| Outbox | The Relay's durable per-session queue of operations accepted for a Host that is offline or busy | relay-core `session-outbox` | The client's list of unsettled sends is **pending messages**; `message-outbox.ts` is renamed |
| Replica | The client's in-memory copy of a session's timeline and Snapshot, built by absorbing frames | `agent-client` `replica` | |
| Device store | The replicas' newest windows persisted on the device, keyed by Relay URL and session | `agent-client` `device-store` | "Cache" is not a noun for it |
| Renderer | The views that draw replica selectors | `agent-client-web`, Workbench views | Trace and Replica Inspector are diagnostics over the same state |

### 2.3 Product

| Term | Meaning | Owner | Decision |
|---|---|---|---|
| Group | One grouping of sessions: today's Window document. Window mode shows it as a Window; Bot mode as a roster group | protocol `window-workspace`, Workbench `state` | Product word Group; the code and protocol keep `window-workspace` and the `bots` appearance until a protocol change |
| Window mode, Bot mode | The desk (panes, details) and the team chat (roster, Content only) over the same groups | Workbench `views` | |
| Bot | A long-lived identity in a group: name, picture, role tag, one conversation | Workbench `state` | A session is at most one bot |
| Role tag, Ask, Side | Derived position label; a side discussion owned by one bot; a session forked from a source | Workbench `state` | |
| Live, Folded, Asleep | Subscription states of a bot in a large group | Workbench `state` (live budget) | |
| Team | A Leader and members created from a bot; Relay routes messages among them | controller `team`, relay-core `teams` | Not an account team |
| TPM, Support | A scheduled main-session service; a Call For Support coordinator | controller `tpm`, relay-core `support` | |

### 2.4 Test words

| Term | Meaning | Owner |
|---|---|---|
| Builder | A function that constructs mock data from overrides: `buildTimelineEntry({ ... })` | the owning package's `./testing` |
| Recording | A capture of a real provider CLI, with its CLI version, plus the golden rows it must produce | `agent-provider-*/recordings` |
| Transcript | A normalized JSON-lines capture of one wire scenario, with direction and logical time | `agent-remote-fixtures` |
| Vector | A decision table (`input`, `expected`) for one pure function | `agent-remote-fixtures/vectors` or the module's `./testing` |
| Seam | A written connection contract between two modules, named S1 to S7 (section 4) | `docs/current/agent-remote/seams.md` (written in M1) |
| Scenario | An ordered, named script reused by transcripts, e2e flows and smoke | `agent-remote-fixtures/scenarios` |

## 3. Target module structure

### 3.1 Packages

Names are decided once. A rename moves a directory and rewrites imports in one mechanical commit with no logic change (steps M2, M3, M7, M12).

| Target package | Today | Layer | Purpose |
|---|---|---|---|
| `agent-remote-protocol` | same | L0 | Public wire: messages, codecs, schemas, versions, shared model types |
| `agent-provider-sdk` | same | L0 | The provider port, observation types, conformance suite, recording format |
| `agent-timeline` (new) | `agent-remote-relay/src/timeline-projector.ts`, the pure part of `timeline-store.ts` | L1 | Rows and items, projection to entries, item identity |
| `agent-remote-journal` | same | L1 | The session journal, window decision, pages, retention, store port and memory store |
| `agent-relay-core` | `agent-remote-hosted` | L2 | The Relay: concerns, ports, HTTP and socket edge, `createRelay` |
| `agent-session-runtime` | `agent-remote-relay` | L2 | The Controller's runtime registry, session wire, operation settlement, provider registry |
| `agent-controller` | `agent-host` (manifest name already `agent-remote-controller`) | L2 and L4 | Session core, publisher, succession, native owner, TPM, Team; the process shell in `process/` |
| `agent-client` (new) | `agent-remote-web` `client/`, `replica/`, `headless`, device store logic | L1 and L2 | The headless client: connection, session client, replica, send and succession state machines, device store |
| `agent-client-web` | `agent-remote-web` `react/`, `browser`, `styles.css` | L3 | React views and hooks, IndexedDB `DeviceDatabase`, WebSocket `Transport` |
| `agent-provider-claude`, `-codex`, `-copilot`, `-opencode`, `-dsh`, `codex-daemon-client` | same | L3 | Native adapters |
| `agent-remote-journal-sqlite` | same | L3 | `JournalStore` over SQL |
| `agent-relay-node` (new) | `agent-remote-lab/src/server` (Gateway, local authorizer, devbox, static serving, SQLite binding) | L4 | The Node host of the Relay for `pnpm local`, self-hosted and the standalone Workbench |
| `agent-relay-cloudflare` | `agent-remote-cloudflare` | L4 | The Workers host: Durable Objects, partition, storage envelope |
| `agent-workbench` | `agent-remote-lab` `src/` (the app) | L4 | The Workbench |
| `agent-remote-debugger`, `agent-remote-dsh`, `agent-remote-tunnel`, `agent-platform` | same | L3 and L4 | Unchanged: debugger CLI, DSH plugin, tunnel, platform helpers |
| `agent-remote-fixtures` (new, private) | `agent-remote-protocol/test/fixtures` plus every inline wire example | test support | Wire transcripts, vectors, scenarios, builders and players |
| `agent-remote-seams` (new, private) | cross-package integration tests spread over host, hosted, lab, cloudflare | test support | Seam tests S1 to S7 only; no `src` |
| `agent-e2e` (new, private) | `agent-remote-lab/e2e` flows, `performance/` proxy and scripts | test support | Stack launcher, main-flow e2e, smoke, fault injection |

Decisions on names:

- **`agent-remote-relay` is renamed `agent-session-runtime`.** It is the Controller-side session manager, and its name made the Relay package graph unreadable. It is published (0.1.1), so the rename publishes a new name and leaves the old one deprecated; the owner decides when to publish.
- **`agent-remote-hosted` is renamed `agent-relay-core`.** "Hosted" says nothing; the package is the Relay. `agent-relay-node` and `agent-relay-cloudflare` are then its two hosts, symmetrical.
- **`agent-remote-web` is split in two.** Its export map already separated `headless` from `react` and `browser`; two packages make "the client core imports no React or DOM" a graph fact. The published name `agent-remote-web` is deprecated in favour of `agent-client-web`.
- **`agent-remote-lab` is split in three** (Workbench, Node Relay host, e2e) because it is three things in one package. The name `lab` ends with the split.
- **Not renamed:** `agent-remote-protocol`, `agent-provider-sdk` (stable published boundaries), the provider packages, `agent-remote-journal`, `agent-remote-journal-sqlite`, `agent-remote-tunnel`, `agent-platform`, `agent-remote-debugger`.
- **`dist` exports.** Published artifacts stay `dist`. Everything inside the workspace resolves to `src`: Vitest and Vite already do (`workspaceSource`); builds and typecheck use TypeScript project references, so a dependent never type-checks against a stale `dist`.

### 3.2 Modules inside each package

Every package lays out `src/` by layer: `domain/` (pure), `app/` (ports and use cases), `adapters/` or `edge/` (technology), `testing/` (the `./testing` entry), and a root composition file. Tests sit beside the module they test. "Must not know" is checked by `arch:check`.

#### Contracts and domain

| Module | Purpose | Public interface | Depends on | Must not know |
|---|---|---|---|---|
| protocol `wire/` | Messages of the uplink, journal, session channel, session control, outbox, succession | Typebox schemas, guards, `PROTOCOL_VERSION` | nothing | any runtime, any package |
| protocol `model/` | Timeline entry, Snapshot, session identity, window workspace, Team, shared schemas moved from hosted and relay (controller location, diagnostics, relation, star, errors) | types, guards | nothing | |
| protocol `codec` | Encode, decode, envelope limits | `encode`, `decode` | `wire`, `model` | |
| SDK `port` | `AgentProviderAdapter`, `AgentSession`, observations, `ProviderItemIdentity` | types | nothing | Controller, Relay |
| SDK `conformance` | The shared contract suite every adapter runs against its recordings | `runAdapterConformance(adapter, recordings)` | `port`, `recording` | any concrete provider |
| SDK `recording` | Recording format, recorder, replayer, scripted adapter | `recordSession`, `replayRecording`, `scriptedAdapter` | `port` | |
| `agent-timeline` `projector` | Rows to items to entries, key assignment | `entryFromRow`, `mergeRowIntoEntry`, `projectRows` | protocol, SDK types | storage, sockets |
| `agent-timeline` `timeline-store` | Ordered rows with identity, folding | `createTimelineStore` | `projector` | providers, Relay |
| journal `session-journal` | Append, complete, alias, replace, prepend, head; generation fencing; contiguous sequence | `createJournal`, `apply(entry)` | protocol, timeline | clock (injected), store, sockets |
| journal `window-decision` (X3) | `decideWindow(tail, newest)` returns `unchanged`, `append` or `replace`; trims a replacement to budget | pure function | `item-digest` | I/O |
| journal `pages`, `retention` | Tail, before and after pages; eviction and fill | `page`, `evict` | `session-journal` | |
| journal `store` | `JournalStore` port, memory store, store conformance suite | port, `memoryJournalStore`, `runStoreContract` | | SQL, Workers |
| relay-core `domain/session-control` (X2) | The lease transition table: acquire, hold, release, refuse with a reason, Host offline, native owner | `transition(state, event)` returns state and reply | protocol | sockets, clock |
| relay-core `domain/host-lifecycle` | Heartbeat deadlines and expiry decisions | `nextHostState(state, event, now)` | protocol | |
| relay-core `domain/rules` | Pure rules of outbox ordering, succession association validity, relation and star validation | functions | protocol | |
| client `replica` | Reducer split in four: `absorb-window` (a replacement by item key), `page-fold`, `pending-messages`, `snapshot-apply` | `reduce(state, frame)`, selectors | protocol | React, DOM, transport |
| client `send-state` (X8) | `transition(state, event)` over idle, pending, queued, delivered, uncertain, failed; `describe(state)` | pure | | |
| client `succession` (X1) | `reduce(state, event)` returns state and effects as data | pure | protocol | |
| client `lease-view` | Maps lease and refusal frames to the view reasons, one table | pure | protocol | |

#### Application

| Module | Purpose | Public interface | Depends on (ports) | Must not know |
|---|---|---|---|---|
| relay-core `host-session` (X5) | One Host connection: register handshake, capabilities, heartbeat, expiry, rpc | `createHostSession({ socket, scheduler, state })` with `onMessage`, `tick` | `Scheduler`, `RelaySocket` | other concerns' state |
| relay-core `journal-service` | Journal open, publish, fills, older history, served streams | `createJournalService({ store, scheduler })` | `JournalStore`, `Scheduler`, `window-decision` | Cloudflare, Node |
| relay-core `session-outbox` | Durable queue, claim, settle | `createOutbox(state)` | `AccountStateStore` | sockets |
| relay-core `account-state` | Drafts, reads, stars, titles, favorites, relations, windows and groups | one `createX(state)` per feature | `AccountStateStore` | |
| relay-core `pairing-keys`, `bindings` | Pairing, device keys, bindings, creations | `createPairing`, `createBindings` | `Clock`, `Ids` | |
| relay-core `succession-associations`, `teams`, `support`, `sharing`, `previews`, `releases` | Concerns extracted from the broker (X6) | `createX(state, ports)` | | each other |
| relay-core `edge` | HTTP auth and routing, session channel sockets, `Gateway` | `createEdge(relay)` | `RelaySocket` | rules (it calls concerns) |
| relay-core `relay.ts` | Composition: `BrokerState`, concerns, edge (today `broker.ts`) | `createRelay(ports)` | all concerns | under 900 lines |
| session-runtime `agent-manager` | Runtime registry, attach, send, operation settlement, journal tap | `createAgentManager({ providers, clock })` | SDK port, timeline | Relay, journal, uplink |
| session-runtime `session-wire` | The session wire for direct-serve and the Controller's host streams | `serveSessionWire` | `agent-manager` | |
| controller `session-core` (X9) | Catalog, attach, create, binding, outbox delivery, directory, publication wiring | `createSessionCore({ providers, relayLink, clock, store })` | `ProviderFacade`, `RelayLink`, `Clock`, `StateStore` | Relay code, processes |
| controller `publisher` | Item windows and live rows to the journal; backoff; recovery by reopen | `createPublisher({ uplink, source })` | `JournalUplink`, `SessionTimelineSource` | the Relay's journal internals |
| controller `succession`, `native-owner`, `tpm`, `team`, `directory` | Rules over SDK types | `createX(ports)` | `SessionCore` ports | provider specifics |
| controller `uplink-client` | Registration mirror, heartbeat, rpc, reconnect | `connectUplink(relayLink)` | `RelaySocket` | rules |
| client `connection`, `session-client` | Transport, reconnect, session channel, lease and pending-message ledger | `createSessionClient({ transport, store })` | `Transport`, `DeviceStore` | React, DOM |
| client `device-store` | Window records, write-behind, restore, eviction, version discard | `createDeviceStore(database)` | `DeviceDatabase` | IndexedDB |
| Workbench `state` (X7) | Groups, selection, cached versus authoritative content, recovery notice, draft ownership | `reduce(state, event)`, selectors | client | React |
| Workbench `views`, `hooks`, `App.tsx` | Rendering; effects; composition under 800 lines | components | client-web | Relay, sockets |

#### Adapters and apps

| Module | Purpose | Notes |
|---|---|---|
| `agent-provider-*` | One native runtime each: observations with item identity, history reads, recordings | Imports SDK only; exports `./recordings` and `./testing` |
| `agent-remote-journal-sqlite` | `JournalStore` over a SQL port | Runs the store conformance suite |
| `agent-relay-node` | `node:http` and `ws` host, SQLite binding, static files, local authorizer, devbox | The only package that opens a Relay listener |
| `agent-relay-cloudflare` | Worker, Durable Objects, `JournalPartition`, storage envelope | Runs the partition contract and a small `workers` suite |
| `agent-client-web` | React hooks and views, IndexedDB `DeviceDatabase`, browser `Transport`, CSS | Runs the device-database contract |
| controller `process/` | CLI, supervisors, systemd, Windows autostart, VS Code tunnel, update, Codex daemon runner | Own Vitest project |

### 3.3 What moves out of the big files

| Today | Extracted to | Lines |
|---|---|---:|
| `hosted/broker.ts` (2,737, one closure) | `host-session` (register, disconnected, expire, send, rpc: lines about 790 to 1,130), `succession-associations` (about 600), `pairing-keys` (about 300), `account relations` (250), `support` (250), `teams` (200), `sharing` and `previews` (150), `journal-deletion` (100), `session-control` (250, with `control.ts`), `BrokerState` as one explicit object; the rest becomes `relay.ts` | about 2,100 out, under 900 left |
| `hosted/gateway.ts` (1,222) | `edge/` (routes by concern: sessions, windows, pairing, releases) | stays, split by file |
| `host.ts` (1,807; `createAgentHostRuntime` about 1,350) | `session-core/` (catalog, attach and create and binding, outbox delivery, directory), `publication wiring` into `publisher/`, `succession wiring`, `uplink-client`, `process` composition into `controller.ts` | about 1,000 out, under 900 left |
| `lab/App.tsx` (3,765) | `state/workbench-state.ts`, `state/selection`, `state/recovery-notice`, `client/succession` (from `useSessionSuccession.ts` 1,152: about 700 move), `state/window-composition`; effects stay in `hooks/` | about 1,800 out, under 2,000 then under 800 after X7 slices |
| `web/replica/reducer.ts` (725) | `absorb-window`, `page-fold`, `pending-messages`, `snapshot-apply` | split |
| `web/client/remote-session-client.ts` (1,068) | `lease-view` table, `session-client` shell | split |
| `relay/timeline-projector.ts`, `timeline-store.ts` | `agent-timeline` | move |
| `hosted/{controller-location, relay-diagnostics, session-relations schema, session-star-schema, session-errors, favorites schema}` | `agent-remote-protocol/model` | move |
| `host/test-utils/recordings.ts` (reads provider directories by relative path) | provider `./recordings` exports | removed |
| `lab/src/server/*` (2,739), `performance/latency-proxy.mjs` | `agent-relay-node`, `agent-e2e/faults` | move |
| `lab/src/server/recorded.ts` (recorded-scenario server) | `agent-remote-fixtures/scenarios` serving the same scenarios to component tests | move |

## 4. Seam contracts

A seam has three artefacts that M1 creates and every later step keeps true: a written contract (`docs/current/agent-remote/seams.md`, one section per seam, linking the protocol and the plans), a fixture set that both sides consume, and a small integration suite in `agent-remote-seams` (or in the owning package when both modules sit in it). Integration tests run real modules inside the seam and fixtures or in-memory ports outside it. They never start the whole stack.

How fixtures are produced:

- **Recordings** are captured from real CLIs by the native tier (`pnpm record:provider <name>`), with the CLI version in the header, and re-recorded on a provider upgrade. The golden output next to each recording is produced by the projector and reviewed once.
- **Transcripts** are captured from a run of the real Controller session core and the real Relay in one process over a `RelaySocket` pair (`pnpm transcripts:record <scenario>`), normalized (ids, times and tokens become placeholders), and committed. M1 records them at the baseline tag, so they pin today's behaviour.
- **Vectors** and **builders** are constructed by hand, as tables and functions.
- `pnpm fixtures:check` verifies headers, that each transcript's protocol version equals `PROTOCOL_VERSION`, and that no fixture is unused. A protocol change fails until the transcripts are regenerated and reviewed in the same commit: that one diff is the review of the wire change.

### S1 Adapter to Controller rows

- **Parties.** A provider adapter (SDK port) and `agent-session-runtime` with `agent-timeline`; the publisher's `SessionTimelineSource` is the output.
- **Contract.** `AgentProviderAdapter.open` yields `ProviderStreamItem`: `ProviderObservation` (event plus `ProviderItemIdentity { key, completes, liveOnly }`), `ProviderHistoryBoundary` and `ProviderTimelineReplacement`. The runtime projects them to canonical rows with item keys; `loadOlderHistory` returns older rows.
- **Guarantees.** (1) An item has the same key live and when reread after a reopen. (2) History read at open holds every item that is not `liveOnly`. (3) Observations of one session arrive in order; `completes` ends an item. (4) Native interpretation stays in the adapter: the runtime sees only SDK types.
- **Errors.** Adapters raise typed provider errors (unavailable, native owned, unsupported), never a raw native failure. An identity breach makes the publisher unserve the journal.
- **Fixtures.** `agent-provider-<name>/recordings/*.json` with `*.rows.json` golden rows. Today: Claude 18, Codex 12, Copilot 8; OpenCode and DSH get scripted ones.
- **Integration tests** (`seams/S1`, about 40, each under 100 ms): each recording replayed twice (live, then reread) yields equal keys and the golden rows; older-history pages continue the sequence; an identity breach is reported. The conformance suite itself is a contract test inside each provider package.

### S2 Controller to Relay uplink

- **Parties.** Controller `uplink-client`, `session-core` and `publisher`; Relay `host-session` and `journal-service`.
- **Contract.** `remote-host-uplink`: register with capabilities (the Relay requires `control`), heartbeat, rpc with request ids, outbox offers, claims and settlements, native owner reports. `remote-host-journal`: `journal_open` carries the item window; the Relay answers `journal_opened` with generation, watermark and the outcome (unchanged, appended or replaced); `journal_publish` carries entries with generation and sequence; the Relay acknowledges each batch or sends a refusal with a reason; fills and older history are requests with a 15 s deadline; `journal_unserve` stops serving.
- **Guarantees.** Sequences are contiguous per generation and a refused entry consumes none. An acknowledgement means durable. A stale generation is fenced. After any failure the Controller reopens with a new window; there is no other recovery. The Relay never synthesizes runtime state.
- **Errors.** The refusal reasons of `remote-host-journal` (for example `sequence_gap`, `quota_exceeded`, `incomplete`) and registration refusals (version, revoked Host). Each has one transcript.
- **Fixtures.** `agent-remote-fixtures/transcripts/uplink/*.jsonl`: register and heartbeat expiry; attach and open with unchanged, append and replace; publish refusal per reason; offline Host with outbox; control refusal by native owner; reconnect and reopen.
- **Integration tests.** Controller side (in `agent-controller`, contract tests): the publisher and `uplink-client` against a transcript player that plays the Relay; the frames sent equal the transcript's Controller frames. Relay side (in `agent-relay-core`): `host-session` and `journal-service` against a player that plays the Controller. Seam (`seams/S2`, about 12): the real Controller session core with a scripted provider from a recording, the real Relay with memory stores, over a `RelaySocket` pair; the resulting transcript equals the golden. About 40 tests in all.

### S3 Relay to browser session wire

- **Parties.** Relay `edge` and `journal-service`; client `connection` and `session-client`.
- **Contract.** `session-channel` and `session-control` frames. The client opens with a cursor and the item-key flag. The Relay sends the Snapshot first, then timeline pages and live entries (entries carry item keys), `timeline_replacement` with a new epoch and the whole window, and `agent_update`. The client sends `session_control` acquire and release; the Relay answers each acquire with a lease frame carrying its request id, revision and token; every mutation carries the token.
- **Guarantees.** Pages are contiguous within an epoch. A replacement is complete in one frame set. The lease is issued only by the Relay. A mutation reaches a Controller only from a stream with a live lease, and the Controller refuses it if a terminal owns the session.
- **Errors.** Lease refusals (`read_only`, owned, offline, restoring), close code 4029 for capacity, a 4xx that leaves the stream reading, offline Host answered from the journal.
- **Fixtures.** `transcripts/session-wire/*.jsonl`: fresh open; reconnect from a cursor; replacement; append; acquire granted, refused, taken over; offline Host; quota trim. The same files serve both ends.
- **Integration tests.** Client side (`agent-client`, contract, about 30): the session client against a transcript server. Relay side (`agent-relay-core`, contract, about 30): the Relay against a scripted client. Seam (`seams/S3`, about 12): real client and real Relay with memory stores and a scripted Controller transcript. Transport (`*.transport.test.ts`, 6): `agent-relay-node` and `agent-client-web` over a real loopback WebSocket, because AGENTS.md requires real transports for protocol, pairing and reconnect changes.

### S4 Relay to stores

- **Parties.** relay-core `journal-service` and `account-state`; `JournalStore` and `AccountStateStore` implementations.
- **Contract.** `JournalStore`: load, persist batch, list, delete, with per-Host ordering. `AccountStateStore`: atomic `commit(state)` and `restore()` of a versioned envelope (the broker's `commit` and `committedBrokerState` path). Persist is durable before it returns. Size limits raise a typed `StoreLimit`.
- **Fixtures.** Operation vectors in the two `./testing` entries (the store conformance suites).
- **Integration tests.** The memory store, `journal-sqlite` and the Durable Object storage run the same suite (about 40 cases each, in memory, under 50 ms). Relay concerns run once against the memory store inside `agent-relay-core`. The Worker proves persistence only.

### S5 Relay to Cloudflare partition

- **Parties.** relay-core's partition proxy and `agent-relay-cloudflare`'s `JournalPartition`.
- **Contract.** `journal-partition.contract.json`: `capabilities`, `open`, `publish`, page and fill calls, with replies halved to stay under 24 MiB, per-Host ordering and a capability retry every 30 s.
- **Fixtures.** The contract JSON, regenerated from the in-process partition; size vectors for the halving.
- **Integration tests.** The proxy against a contract player (relay-core, unit speed). The partition server against the same contract through an in-process Node implementation, with no `workerd` (about 15). The `workers` project keeps at most 20 tests that need the Workers runtime: socket upgrade, alarms, storage envelope chunking at 256 KiB, Durable Object eviction. Cloudflare total under 25 s.

### S6 Client replica to renderer

- **Parties.** `agent-client` `replica` and the views of `agent-client-web` and the Workbench.
- **Contract.** The renderer reads selectors only: `selectTimeline(session)` gives rows keyed by item key, `hasOlder` and `epochPending`; `selectSessionView(session)` gives status, lease view and the send-state words. It issues commands: `send`, `loadOlder`, `acquire`, `retry`. Views never read frames or raw state. Selectors return the same object when content is equal.
- **Guarantees.** Keys are stable across a replacement; unchanged rows keep their identity; the reader's anchor survives a replacement.
- **Fixtures.** `buildReplica({ ... })` and `replicaAfter(transcript, frame)` in `agent-remote-fixtures`.
- **Integration tests.** `seams/S6` (about 25): a transcript drives the real replica and the real React view with a fake client and no Relay; an unchanged row keeps its React identity across a replacement; a pending send maps to its words; a recovery notice appears and clears. Unit tests of views render builder states.

### S7 Device store to replica

- **Parties.** `agent-client` `device-store` and `replica`; `DeviceDatabase` as the port.
- **Contract.** `save(record)` and `restore(identity)` over `StoredRecord { key, relayUrl, version, epoch, nextSeq, hasOlder, entries, snapshot, updatedAt, bytes }`. Writes follow a settled batch, bounded by a byte budget with least-recently-used eviction. A restored record seeds the replica marked `restored` and is never authoritative; the first server page replaces it by item key. A version mismatch discards the record.
- **Fixtures.** `buildStoredRecord`; frozen `device-records/v<n>.json` for each stored version.
- **Integration tests.** The `DeviceDatabase` contract suite runs on the memory database, on IndexedDB through `fake-indexeddb` (`agent-client-web`) and in the browser component tier (3 tests). `seams/S7` (about 15): open, save, restart, restore, absorb the server tail, version discard, budget eviction.

### Seam summary

| Seam | Real modules | Everything else | Tests |
|---|---|---|---:|
| S1 adapter to rows | adapter conformance, runtime, timeline | recordings | 40 |
| S2 uplink | Controller session core and publisher, Relay host-session and journal-service | transcripts, memory stores, `RelaySocket` pair | 40 |
| S3 session wire | client, Relay edge and journal-service | transcripts, memory stores | 80 |
| S4 stores | each store implementation | vectors | 120 |
| S5 partition | proxy, partition server | contract JSON | 35 |
| S6 replica and renderer | replica, views | transcripts, fake client | 25 |
| S7 device store | device store, replica | memory database | 25 |

About 365 seam tests. They are new and narrow; each migration step deletes the old tests they replace (section 6).

## 5. Test architecture

### 5.1 The tiers

| Tier | Suffix and place | Vitest project | May use | Forbidden | Budget per test | Runs |
|---|---|---|---|---|---|---|
| Unit | `*.test.ts(x)` beside the module | `unit` | One module through its public functions; ports replaced by stubs; builders | Sockets, processes, `workerd`, real timers over 50 ms, real clock, files outside a temp directory, another package's files | 300 ms looks; 1 s fails | Every task |
| Contract | `*.contract.test.ts` beside the module that consumes the fixture | `contract` | A module and a transcript, vector or recording player | Same as unit | Same | Every task, and after a contract change in every consumer |
| Integration | `*.integration.test.ts` in `agent-remote-seams/tests/S<n>/`, or beside the modules when one package holds the seam | `integration` | Two or more real modules, in-memory ports, `RelaySocket` pair, fake scheduler | Whole stack, real listeners, processes | Same | After a change on the seam |
| Transport | `*.transport.test.ts` | `transport` | A real loopback socket on a free port, a real WebSocket | More than one Host or account; real CLIs | 2 s; at most 30 in the repository | After a protocol, pairing or reconnect change |
| Process | `*.process.test.ts` | `process` | Child processes, real timers (Controller shell) | Relay logic | 15 s; one worker | When `controller/process/` or scripts change |
| Workers | `*.workers.test.ts` | `workers` | `workerd` | Rules | 5 s; at most 20 | When the Cloudflare host changes |
| Component (browser) | `e2e/components/*.spec.ts` in the Workbench and client-web | Playwright, fixture page | Builder states, no Relay | A Relay, a Controller | 5 s | After a CSS, layout or component change; at step end |
| E2E flows | `agent-e2e/flows/*.spec.ts` | Playwright | Real browser, Relay, Controller, scripted provider | Real models | 30 s | End of a step, before merge or release |
| Smoke | `agent-e2e/smoke/*.ts` | `pnpm smoke` | Real CLIs, real browser, fault injection | None | minutes | On demand, before release |
| Native | `*.local.test.ts` | `local` | A real CLI and model | | 60 s | By hand or nightly |

Only e2e, smoke and native use a real stack. Unit, contract and integration tests never start a listener or a process and never read the clock or the home directory; the ports (`Scheduler`, `Clock`, `RelaySocket`, `JournalStore`, `DeviceDatabase`, `Transport`) exist for that.

### 5.2 Unit tests

- **Location.** Beside the module: `src/<layer>/<module>/x.ts` and `x.test.ts`. A module's tests are its own; nothing else imports them.
- **Naming.** The test file names the public function or rule it covers. A table-driven test loads vectors (`it.each(vectors)`); a state machine has one table and one test over it. A file has at most 400 lines and one `describe` per rule.
- **Environment.** `node`. A file that renders DOM declares `// @vitest-environment jsdom`; only `agent-client-web` and Workbench `views` may.
- **Time.** `FakeClock` and `FakeScheduler` from the package's `./testing`. `vi.useFakeTimers` is allowed; a real timer over 50 ms is not.
- **What a unit test never does.** Open a socket, spawn a process, start `workerd`, wait on the wall clock, read a provider directory or another package's files.

### 5.3 Mock data conventions

1. **Four kinds, four homes.** Builders and fake ports live in the owning package's `./testing` entry (for example `buildTimelineEntry`, `buildSnapshot`, `memoryJournalStore`, `FakeScheduler`, `socketPair`). Wire transcripts, vectors, scenarios and replica-state builders live in `agent-remote-fixtures`. Recordings live in each provider's `./recordings`.
2. **Builders construct, deterministically.** `buildX(overrides)` returns a frozen value. Ids come from `sequentialIds('session')`, time from `TEST_NOW`; no `Math.random`, no real `Date.now`. A builder is the only place a default value of a shape is written.
3. **No ad hoc copies.** A shape that appears in three test files is a builder. `arch:check` flags an inline wire-message literal (an object with a protocol `type` value) in any test outside `agent-remote-fixtures` and the protocol package's own tests.
4. **Fixtures are immutable and headed.** JSON fixtures carry `kind`, `producedBy`, `protocolVersion` and the CLI version for recordings. Changing one is a reviewed diff.
5. **Recorded when real, constructed when not.** Anything the real system emits (provider output, wire frames) is recorded; decision tables and edge cases are constructed.
6. **Packages publish `./testing` only where they are layered below the test.** Public packages ship `./testing` for builders and fakes; recordings and transcripts never ship.

### 5.4 The speed rule and its enforcement

- **Hard limit.** Each of `unit`, `contract` and `integration` sets `testTimeout: 1000`. A test that is still running after 1 s fails.
- **The reporter.** `scripts/lib/slow-test-reporter.mjs` (a Vitest reporter in every package's config) reads each test's measured duration. It fails the run when a unit, contract or integration test took over 1 s and is not in `scripts/slow-test-allowlist.json` (this also catches a CPU-bound synchronous test that a timeout cannot interrupt), and lists those over 300 ms with file, name and tier. Before failing it runs the test's file once more alone on one worker and fails only if the test is over 1 s again: a retry for timing only, so machine load does not fail a run. `ARC_SLOW_TEST_ENFORCE=0` only lists. `slowTestThreshold` is set to 300 so Vitest's own output agrees.
- **A ratchet.** `docs/superpowers/specs/test-metrics.json` records the count over 300 ms per project. The reporter fails when the count rises, and the number only goes down. A test between 300 ms and 1 s needs a comment naming why it cannot be faster, or it is fixed.
- **The guards.** A setup file for the three mock-data projects replaces `net` listen and connect, `child_process`, `node:dns` and `setTimeout` over 50 ms (unless fake timers are on) with functions that throw "not allowed in a unit test; this belongs in the transport or process tier".
- **Deadlines.** The per-test deadlines above and the outer process deadlines in `scripts/run-tests.mjs` apply to every project and command. Each new command gets both.
- **When slow means missing module.** A slow mock-data test usually shows a module that is not extracted (a closure that needs a whole Relay). The rule: do not raise the limit; open an extraction step.

### 5.5 Integration tests

Defined per seam in section 4: real modules inside the seam, mock data outside, in memory, never the whole stack. Rules:

- A seam test asserts the written contract (messages, order, guarantees, errors), not the neighbours' internals.
- Each guarantee in a seam's contract has at least one test; each error has a transcript.
- Both ends of a wire seam consume the same transcript. A protocol change updates the transcript once.
- Where a seam spans two packages, the test lives in `agent-remote-seams`, the only package that depends on both ends. Where one package holds both modules, the test lives there.
- Real transports are allowed only in the `transport` tier (about 6 for S3, 4 for pairing, 4 for Controller reconnect, 4 for the lease and take-over race, 12 others; 30 at most).

### 5.6 E2E: the main flows

Harness `agent-e2e/stack`: one `agent-relay-node` (SQLite in a temp directory), one Controller with a scripted provider that replays a recording, and the built Workbench, on free ports, started once per run and shared. Each test creates its own Host and session ids. Playwright runs the flows in sequence on one worker with a 30 s test deadline and a 4 minute global deadline. The scripted provider and the recordings make the flows deterministic.

| # | Flow | Tests | What each proves |
|---|---|---:|---|
| E1 | Pair and read: pair a Controller with a temporary key, see the Host online, open a session, read messages, tool calls, reasoning and markdown | 4 | Pairing; directory; conversation rendering primary; Trace opens |
| E2 | Send and reply: send, see pending then delivered, streaming reply, reload shows the same; send while the Host is offline is queued then delivered | 4 | Send-state words; outbox; echo by item key |
| E3 | Reconnect and return: socket drop, Controller restart, page reload with the device store paints at once then catches up; a journal replacement keeps the reader's place; older history loads on scroll | 5 | Replica absorb by item key; device store; S4 reading-anchor drift (one test); Codex older-history load (one test) |
| E4 | Terminal drives a session: a scripted native writer appends while the page is open; the page turns read-only, take over works; a terminal fork appears as its own session | 4 | Native owner; lease; Claude terminal fork (one test) |
| E5 | Succession: hand a session to another provider, the conversation continues, refresh in the middle recovers | 3 | Client succession model end to end |
| E6 | Groups and modes: build a group, Bot and Window mode, fold and sleep, a draft shared across modes | 4 | Group, bot membership, live budget, drafts |
| E7 | Share and Team: share a Host session, create a Team from a bot, a read-only recipient cannot send | 3 | Grants, Team delivery, lease refusal |
| E8 | Update a Controller | 1 | Release metadata and the update flow |

**Target: 28 e2e tests** (24 to 32), about 4 minutes, from about 400 e2e and browser tests today. Local findings enter the list only as one e2e test each, with the unit or integration test that explains the defect (rule: section 5.7). The three named findings are marked above. Everything else in today's 93 specs moves down: layout and fixture-page specs (about 200 tests) become the **component tier** on builder states with no Relay (under 90 s in all, run on demand and at step end); behaviour specs are deleted after their lower-tier replacement passes a mutation check.

### 5.7 Smoke tests

Smoke is `pnpm local` made extreme: the instance of `.agents/skills/prepare-arc-local`, real Claude and Codex CLIs, a real Chrome, and faults. It reports; it does not gate a task. It is run on demand with `pnpm smoke <scenario> --seed <n>` and before a release (`pnpm smoke:all`, about 40 minutes; `pnpm smoke:quick`, three scenarios in about 5 minutes, before merging a change to a seam).

| # | Scenario | Fault | Invariants checked |
|---|---|---|---|
| M1 | Bad network | The latency proxy (extended with jitter, loss, half-open sockets, bandwidth cap) at 50, 300 and 1,500 ms round trip and 2 and 10 percent loss | First paint from the device store under 300 ms at any latency; every `clientMessageId` settles exactly once; no duplicate item key |
| M2 | Controller restart mid-turn | SIGKILL and graceful stop during streaming and during a tool call, 20 times | Journal sequences contiguous; one replacement at most per restart; the turn's rows are complete after return |
| M3 | Relay restart mid-turn | Restart the Relay with a SQLite journal; also with an empty store | Controller reopens; the page shows no blank frame and no stale label |
| M4 | Quota pressure | Tiny journal quotas, tool outputs of several MiB | The Relay admits a window whole or refuses it (`quota_exceeded`) and the session reads through its Controller; a refused window is not sent again unchanged on the same connection; live-only items survive; no refused-row hole |
| M5 | Many sessions | 200 sessions and a 50-bot group; open, fold, sleep, wake | Live subscriptions within budget; directory churn does not re-render rows that did not change; memory flat |
| M6 | Writers race on one session | Two pages on two browser contexts send to one session at once; a real Claude Code and a real Codex terminal write while the page sends; a separate Codex process writes while a page opens. A few rounds each (5, `--rounds`), as a check of the wiring: the orderings of writers are enumerated at the seams (S1 to S3) | Inside our system: every page can send; no lost or doubled message; every page shows the native session's state and properties. Beside a terminal: both sides can send; terminal rows, state and properties appear live in the page; no lost or doubled message. The page never shows a connection word |
| M7 | Hidden page and drops | Chrome visibility `hidden`, then offline for 10 s to 10 min, then visible; repeated | Catch-up costs one tail request; no stale "reconnecting" label; draft and reading position kept |
| M8 | Soak | 30 minutes of streaming on three sessions | Row counts, heap and socket counts stable |

- **M6's boundary.** Our system is any number of pages, devices and Windows on one session. Inside it there is no conflict: the Controller is the session's one native client, the Relay-owned control lease (S5) orders the writers, every page can send, no message is lost or doubled, and every page shows the same state and properties. A terminal is outside our system, and its CLI's own mechanism decides: a Codex terminal that uses the shared daemon (`agent-remote-controller codex …`, `agent-remote-controller-dev codex …` for the instance, or native `codex` pointed at the shared socket) is another client of the loaded thread and Codex orders the turns (it refuses a second turn while one runs); a separate Codex process (`codex exec resume`) is refused by Codex with "active writer" while the thread is loaded in the daemon; Claude Code resumes its transcript. We add no lock and no handover for a terminal. We report what the CLI does: the page stays live through the session's events or read-only observation, and when Codex refuses the Controller it shows Codex's reason.
- **Limits, not long runs.** A smoke failure is either a limit reached or a condition that triggers a defect; neither needs a long run. Each bound below belongs to a component clause in `docs/current/agent-remote/components.md` and needs a boundary test at the bound minus one, at the bound and at the bound plus one, at the lowest tier. "Clause test" means the limit is tested, but not yet at the three points; "gap" means no test (2026-11-21).

| Bound | Value | Enforced in | At the bound | Boundary test |
|---|---|---|---|---|
| Journal bytes per session | 64 MiB (local and Node Relay default; the Cloudflare partition sets its own) | `host-journals.ts` `SESSION_MAX_BYTES`, `limits.sessionBytes` | the window is refused whole (`journal_refused`, `quota_exceeded`); the page reads through the Controller | clause test (Journal C13); M4 runs at tiny limits |
| Journal bytes per Host | 1 GiB | `HOST_MAX_BYTES`, `limits.hostBytes` | a session's room is what the Host has left | clause test (Journal C14) |
| Live-only items per session | 2,000, and a byte cap derived from the session limit | `LIVE_ONLY_MAX_ITEMS`, `liveOnlyBytesMax` | the oldest complete live-only item is dropped | clause test (Journal C15, C16) |
| One publication message | 4 MiB | `journal-items.ts` `MESSAGE_BUDGET_BYTES` | a window takes the newest items that fit | clause test (Publisher C11) |
| Host frame | 16 MiB buffered | `BROKER_MAX_FRAME_BYTES` | `host_backpressure` (503) | clause test (Host-session C15) |
| Item key | 4,096 characters | `agent-manager.ts` (SDK contract) | the observation is refused | clause test (Publisher C13, Adapters C11) |
| Pending requests of a Host | 128 | `host-session.ts` | the 129th is refused, `host_busy` (429) | clause test (Host-session C13) |
| Hosts and device credentials | 128 each | Relay state | `host_capacity`, `capacity_exceeded` (429) | clause test (Host-session C16) |
| Requests waiting for a live session | 32 | publisher `MAX_PENDING_REQUESTS` | the oldest is refused, `not_ready` | clause test (Publisher C12) |
| Held events, gap reads, older reads | 10,000, 8, 3 per request | `DEFAULT_PUBLISHER_LIMITS` | the publisher reopens or refuses | gap (Publisher C10) |
| Relay request deadlines | 30 s; 45 s for provider settings; 180 s for create | `host-session.ts` `rpcTimeoutMs`, `creationTimeoutMs` | the request is refused; a hung resume keeps the Controller's binding (`provider-faults.test.ts`) | gap for 45 and 180 s (Host-session C14) |
| Host registration | 10 s | `registrationDeadlineMs` | close 1008 | clause test (Host-session C12) |
| Idle grace of a session runtime | 5 min; reconcile every 60 s, backoff to 15 min | `idle-sessions.ts` | the runtime is released, journal first; a shown page holds none (O47) | clause test (Session core C11, C12) |
| Transcript divergence | 2,000 ms tolerance, 30 s quiet | `transcript-divergence.ts` | a later native write is another writer's; a quiet diverged session is released and read again | yes: `transcript-divergence.test.ts` (Session core C10) |
| Terminal refresh | 30 s quiet, 20 sessions, 4 reads at once | `publisher/terminal-refresh.ts` | an older session is no longer refreshed | clause test (Publisher C14) |
| Echo watch of a sent message | after 10, 30 and 60 s; 8 pages a scan, 15 s | `message-echo-sync.ts` | the message stays `awaiting_echo` | gap (Replica C13) |
| Background outcomes kept | 2,048 | `snapshot-apply.ts` | the oldest id is dropped | gap (Replica C14) |
| Pending sends in the composer | no bound, no timeout | composer queue | a message waits as long as the session cannot take it | gap: the bound is missing (Replica C15) |
| Live subscriptions of one device | 6 | Workbench (`LIVE_RECENT` and the grace) | the oldest idle subscription is closed | M5 only |
| Work summary | 3 clauses, then "and N more" | `work-summary.ts` | the rest is counted | clause test (Turns C13) |
| Sign-ins of the site | 30 per minute | site | refused until the minute passes | not on the session path |
| Codex request, handshake, frame | 90 s, 5 s, 64 MiB | `codex-daemon-client` transport | `native_request_timeout`, `native_resume_timeout`, `native_history_timeout` | external (section 10, O46) |
| Codex thread after its last client | unloaded after 60 to 70 s (codex 0.171, measured) | Codex | a separate process may write again | external, measured by M6 |

- **Faults are seeded** (`--seed`), so a failure replays. A fault schedule is a list of timed actions in the report.
- **Invariants are read from the wire and the page.** The proxy tees every frame into a transcript; the page exposes Replica Inspector data. A scenario fails on an invariant, not on a screenshot.
- **Reports.** `pnpm smoke` writes `.arc-local/smoke/<date>/report.json` (scenario, seed, schedule, measurements, invariant results, transcript path) and a one-page summary. Reports are not committed; findings are.
- **A finding becomes tests in this order.** (1) Keep the failing run's transcript and seed. (2) Add the transcript to `agent-remote-fixtures` and a failing integration test on its seam. (3) Add the failing unit test in the module that owns the broken rule (the invariant-to-module table in `modules.json` names it). (4) Fix. (5) Add an e2e test only if a main flow regressed or the failure is a visible local finding. Each smoke finding therefore leaves a transcript, an integration test and a unit test.

### 5.8 Native tier and redundancy control

- Native tests stay `*.local.test.ts` and opt-in: `pnpm test:local`, `pnpm test:claude`, `pnpm test:opencode:native`, `pnpm test:codex-shared`. They also run `pnpm record:provider`, which refreshes recordings on a CLI upgrade; a changed recording shows as a diff that the owner reviews.
- **Redundancy control.** A rule is tested in its owner module's unit suite and once on its seam. `arch:check --redundancy` lists rule-tagged test titles (`[control.refuse.owned]`) that appear in more than one module's unit tests, and counts test files per module that build a neighbour's whole closure. A hit means the rule has two owners or a module is missing; the answer is a move, not a new test. Deleting a duplicate needs the mutation check: break the rule, see the owner's test fail first, then delete.

### 5.9 The change-to-test mapping

`architecture/modules.json` declares, for every module: `paths` (globs), `layer`, `seams`, `flows` and `invariants`. `pnpm arch:check` fails when a source file belongs to no module or two modules, when a layer rule is broken, when a test file's suffix does not match its imports (a socket in a `*.test.ts`), and when an inline wire literal appears in a test.

`pnpm test:changed` (called by `verify:changed`) computes the plan:

1. The base is the task base (`pnpm task:start`, `$ARC_TASK_BASE`, then the merge base).
2. Each changed file maps to its module by longest path prefix.
3. For each changed module: its `unit` and `contract` tests (`vitest run --project unit --project contract <module paths>`), then the `integration` suites of the seams listed for it, then the `transport` and `process` projects only if their modules changed.
4. If the module is in L0 or in `agent-remote-fixtures`: the contract tests of every consumer of the changed message, found from the `consumers` field in the transcript headers, and all seam suites of that wire area.
5. Typecheck and build only the changed packages and their dependents (the existing `affected` filters).
6. It prints the flows the changed modules affect (`flows`) as a reminder. E2E and smoke never run automatically; the step-end gate runs them.

| Changed module | Runs |
|---|---|
| protocol `wire` or `model` | Protocol unit; contract tests of every consumer of the changed message; S2, S3 |
| SDK `port`, `conformance`, `recording` | SDK unit; every adapter's conformance; S1 |
| A provider adapter | That adapter's unit and conformance; S1 |
| `agent-timeline` | Its unit; S1, S6 |
| journal `session-journal`, `window-decision` | Its unit and vectors; S2, S4 |
| journal `store` or a store implementation | Store conformance of every implementation; S4, S5 |
| relay-core `domain/*` | That module's unit table; S3 (lease) or S2 (host) |
| A relay-core concern (`pairing-keys`, `account-state`, `teams`, ...) | That concern's unit; its transcripts; no seam |
| relay-core `journal-service`, `host-session` | Unit; S2, S3, S4 |
| relay-core `edge` | Unit; S3; transport (pairing) |
| session-runtime | Unit; S1 |
| controller `publisher`, `uplink-client` | Unit; S2 |
| controller `session-core` and rules (`succession`, `native-owner`, `tpm`, `team`) | Unit; S1, S2 |
| controller `process/` | The `process` project |
| client `replica`, `send-state`, `lease-view`, `succession` | Unit tables; S3, S6 |
| client `device-store` | Unit; contract of `DeviceDatabase`; S7 |
| client-web | Unit; S6; component tier on layout changes |
| Workbench `state`, `views` | Unit; S6; component tier for layout; flows listed |
| `agent-relay-cloudflare` | `workers` project; S5 |
| `agent-relay-node` | Unit; transport |

### 5.10 Targets

| Measure | Today (assessment) | Target |
|---|---|---|
| Typical change, tests only | 85 s lab or 74 s host package; `verify:changed` often full | Unit of the module plus one or two seam suites: 2 to 10 s; worst case 40 s |
| A protocol message change | 8 to 12 minutes with build | Fixtures plus consumers: 20 to 40 s |
| Full unit, contract, integration, transport, workers (no e2e) | about 320 s serial | 90 s wall |
| Component tier | n/a (part of 400 e2e) | 90 s |
| E2E flows | 375 Playwright plus 27 browser tests | 28 tests, 4 minutes |
| `pnpm verify` (compatibility, build, typecheck, all but native and smoke) | more than the 540 s outer deadline | 7 minutes |
| Vitest tests, unit and contract | about 9,300 in all tiers | About 7,000 unit and contract (about 660 mock-data tests removed or merged, and the real-stack tests rewritten as seams or deleted); about 7,600 with seam, transport, workers and process |
| Seam, transport, workers | mixed into the others | 365, at most 30, at most 20 |
| Tests over 300 ms, over 1 s | not measured | Measured in M0, then ratchet to under 1 percent over 300 ms and none over 1 s |
| Process project | 138 s cumulative, in the default run | 150 tests, not in the default run |

## 6. Migration plan

The assessment's X1 to X9 and B1 to B10 are refined by the target: layers and renames come first because every later extraction lands in its final package; fixtures come before any extraction because they are what proves behaviour is unchanged. One step is one or two sessions. A step never changes behaviour; it is a move plus its tests, and the old tests are deleted in a later commit of the same step after the mutation check.

### 6.0 How every step is checked against the baseline

1. **Golden transcripts (from M1).** The scenarios of S2 and S3 are recorded at `baseline/im-session-2026-11-18` and committed. After every step the Relay-side and Controller-side contract tests and the S2 and S3 loopbacks replay them. A step passes only if the normalized transcripts are unchanged. A wire change is a separate reviewed commit that regenerates them.
2. **Golden rows (from M1).** The S1 recordings produce the same rows and keys as the baseline.
3. **Old tests stay until the new ones prove the rule** (mutation check: break the rule, the new unit test fails, the old tests also fail, then delete the old ones).
4. **Mechanical commits.** A rename or move commit changes no logic; `pnpm typecheck` and the whole unit suite pass before and after.
5. **Local pass.** At the end of a step that touches the Relay, Controller or website: `pnpm local up` with the worktree's instance (per `prepare-arc-local`), one real Claude and one Codex session, and from M4 `pnpm smoke:quick` compared with the baseline run.
6. `pnpm compatibility:update`, then `pnpm compatibility:check` after each reviewed implementation step.

### 6.1 Order

| Step | Creates | Source in the assessment | Sessions | Deleted tests |
|---|---|---|---:|---:|
| M0 | Measurement and guards | new | 1 | 0 |
| M1 | `agent-remote-fixtures`, `agent-remote-seams`, recordings exports, golden transcripts | B2, B3, B10 | 2 | 0 |
| M2 | Layers made real: `agent-timeline`, protocol model moves, three package renames | B4, B9, L3, L5 | 2 | 0 |
| M3 | Store contracts; Cloudflare slimmed; `workers` project | X4 | 2 | 60 |
| M4 | Smoke harness v1 and the extended latency proxy | new | 2 | 0 |
| M5 | Journal `window-decision` | X3 | 2 | 50 |
| M6 | relay-core `session-control` | X2 | 2 | 30 |
| M7 | Client `send-state` and `pending-messages` | X8 | 1 | 25 |
| M8 | `agent-client` and `agent-client-web` split; replica split; S6 and S7 | new | 2 | 20 |
| M9 | Client `succession` model | X1 | 3 | 150 |
| M10 | Controller `session-core` and `publisher` | X9 | 5 | 40 |
| M11 | Relay concerns, `BrokerState`, `host-session` | X6, X5 | 8 | 27 |
| M12 | `agent-relay-node`, `agent-e2e` stack | B8 | 3 | 120 moved down |
| M13 | Workbench `state` | X7 | 6 | 260 |
| M14 | E2E flows, component tier, duplicate e2e deleted | 5.6 | 3 | about 170 |

Total about 44 sessions and about 830 tests removed: about 660 mock-data tests (the assessment's 640) and about 170 e2e specs, plus about 120 real-socket tests moved down. Order logic: M0 to M4 make measurement and safety; M5 to M9 are the cheap, low-risk rules with the largest clarity gain (M9 removes the 74 s file); M10, M11 and M13 are the large ones and each is a series of independent slices; M12 and M14 reach the e2e target once the lower tiers exist. M3, M4, M5 to M7 are independent and can run in any order or in parallel after M2.

### M0 Measure and guard (report only)

- **Creates.** `scripts/lib/test-budget-reporter.mjs`, `pnpm test:inventory` (counts and durations per package, project and tier, written to `test-metrics.json`), `architecture/modules.json` draft, `scripts/arch-check.mjs` in report-only mode, `slowTestThreshold: 300` in every Vitest config.
- **Contract and fixtures first.** The format of `test-metrics.json` and of `modules.json`.
- **Code moved.** None.
- **Tests added.** Tests of the reporter and `arch-check` on small sample repositories.
- **Deleted.** None.
- **Scope after.** No change. The baseline numbers (tests over 300 ms and over 1 s, files per tier, module sizes) exist for the first time.
- **Risk.** Low.
- **Baseline check.** The inventory runs against the tag first.

### M1 Fixtures, seams and golden transcripts

- **Creates.** `agent-remote-fixtures` (transcript recorder and players, builders for protocol shapes, vectors, scenarios), `agent-remote-seams` (empty suites S1 to S7 and their `describe` names), `docs/current/agent-remote/seams.md` with the seam contracts of section 4, provider `./recordings` exports.
- **Contract and fixtures first.** The seam document; then the S2 and S3 scenarios recorded at the baseline tag; the S1 golden rows.
- **Code moved.** `host/test-utils/recordings.ts` reads through the provider exports (leak L1); `compatibility.json` is read from an explicit path (L8 of the assessment, B10); inline wire examples are not touched yet.
- **Tests added.** The S2 and S3 loopbacks (about 24) and the S1 suite (about 40), all new.
- **Deleted.** None; this step only adds safety.
- **Scope after.** No change to existing runs; every later step has its check.
- **Risk.** Low; recording normalization must be stable (run twice, compare).
- **Baseline check.** The transcripts are recorded at the tag and replayed at HEAD; they must match.

### M2 Make the layers real

- **Creates.** `agent-timeline`; `agent-session-runtime` (rename of `agent-remote-relay`); `agent-relay-core` (rename of `agent-remote-hosted`); `agent-controller` directory (rename of `agent-host`); blocking `arch:check` with the rules of 1.2 and `modules.json` filled in.
- **Contract and fixtures first.** The `arch:check` rules as failing tests on sample trees; `modules.json` assigns every source file.
- **Code moved.** `timeline-projector.ts` and the pure part of `timeline-store.ts` to `agent-timeline` (the journal drops its dependency on the runtime package); `controller-location`, `relay-diagnostics`, `session-relations`, `session-star-schema`, `session-errors` and `favorites` schemas to the protocol `model/` (the Controller stops importing the Relay package); renames as three mechanical commits each followed by a green full run. The published `agent-remote-relay` keeps a deprecated re-export release only if the owner publishes.
- **Tests added.** `arch:check` tests; none for moved code (tests move with it).
- **Deleted.** None.
- **Scope after.** A Relay change no longer selects the Controller package, and the other way round; a protocol change selects its true consumers.
- **Risk.** Medium: it touches every import, and the other agent's work in the worktree must be committed first. A protocol change from the type moves follows the upgrade rule if any wire shape changes; the moves change no wire shape.
- **Baseline check.** Typecheck, full suite, golden transcripts, and `compatibility:check` (the implementation digest changes; the protocol version does not).

### M3 Store contracts and a slim Cloudflare package (X4)

- **Creates.** Store conformance suites in `agent-remote-journal/testing` and `agent-relay-core/testing`; `workers` project; the rename to `agent-relay-cloudflare`.
- **Contract and fixtures first.** S4 and S5 sections and the contract JSON regenerated from the in-process partition.
- **Code moved.** None.
- **Tests added.** Memory, SQLite and Durable Object storage run the same suites (about 120 cases); the partition server runs the contract in process (about 15).
- **Deleted.** About 60 tests and 1,500 lines of the 37 Cloudflare files (outbox, drafts, reads, relations, rename, stars, favorites, migrations, session states) that re-drive Relay rules through a Worker socket.
- **Scope after.** A Relay rule change no longer runs Cloudflare tests; a Worker change runs about 20 tests.
- **Risk.** Low (test only). The owner accepts that Worker tests no longer re-run feature rules.
- **Baseline check.** Each deleted Worker test is mapped to the relay-core test that owns the rule; one Worker smoke remains per feature.

### M4 Smoke harness v1

- **Creates.** `agent-e2e/smoke`, `agent-e2e/faults` (the latency proxy moved from `lab/performance` and extended with jitter, loss, half-open sockets and bandwidth cap; process kill; quota config; the many-sessions generator), report format, `pnpm smoke`.
- **Contract and fixtures first.** The invariants list of 5.7 as pure functions over a transcript and a page report, unit tested on constructed transcripts (including a deliberately broken one for each invariant).
- **Code moved.** `lab/performance/latency-proxy.mjs` and its test.
- **Tests added.** Invariant tests (about 25) and the harness's own tests. M1, M2, M3, M7 scenarios first; M5, M6, M8 after the Node host exists.
- **Deleted.** None.
- **Scope after.** None for tasks; findings start to flow into fixtures.
- **Risk.** Low to medium: real CLIs make smoke runs flaky, so a failure always keeps the seed and transcript.
- **Baseline check.** The first full smoke run at the baseline tag is the reference report.

### M5 Journal window decision (X3)

- **Creates.** `agent-remote-journal/window-decision`, `vectors/journal-window.json`, client `absorb-window` stub in the replica.
- **Contract and fixtures first.** About 40 vectors: identical, extension, anything else becomes a replacement, prepend below a replacement, key-stable rows, trim to budget, live-only carried over.
- **Code moved.** The comparison out of `journal-session-stream.ts` and `journal-publication.ts` (about 150 lines) and the absorption in the replica reducer (about 200).
- **Tests added.** The vector table with one consumer per layer: journal, publisher, replica, one line each.
- **Deleted.** About 50 of the 187 tests that restate the decision in host, hosted, web and lab; six real-server `journal-served-reconnect` variants.
- **Scope after.** A change to the rule runs about 45 table rows and S2 in about 4 s.
- **Risk.** Low.
- **Baseline check.** `journal-continuity.recordings` through S1 and S2 unchanged; golden transcripts for unchanged, append and replace.

### M6 Relay session control (X2)

- **Creates.** `relay-core/domain/session-control` with its transition table, and the client `lease-view` table.
- **Contract and fixtures first.** The lease section of S3 and the transcripts for granted, refused (each reason), taken over, offline.
- **Code moved.** The lease code and `control.ts` leftovers from `broker.ts` and `journal-sessions.ts` (about 250 lines); the refusal-to-view mapping from `remote-session-client.ts`.
- **Tests added.** About 40 table rows; S3 lease transcripts.
- **Deleted.** About 30 tests (about 800 lines) in host, hosted and lab that restate the transitions.
- **Scope after.** A lease rule change runs the table (under 1 s) and S3.
- **Risk.** Low to medium; security-sensitive, so the Controller's own owner check at delivery keeps its test.
- **Baseline check.** S3 lease transcripts; the lease race test in the `transport` tier.

### M7 Send-state machine (X8)

- **Creates.** Client `send-state` and `pending-messages` (renamed from `message-outbox.ts`).
- **Contract and fixtures first.** The transition table and the `describe(state)` words.
- **Code moved.** `message-recovery.ts`, `recovery-writes.ts` and the pending logic of the composer hooks (about 400 lines).
- **Tests added.** About 30 rows.
- **Deleted.** About 25 tests in web, lab and four e2e specs; `pending-send.spec.ts` goes from 6 tests to the E2 flow.
- **Scope after.** A send-state change runs the table and S6.
- **Risk.** Low.
- **Baseline check.** The S3 send transcripts and S6 pending-send view test.

### M8 Split the client and finish S6 and S7

- **Creates.** `agent-client` and `agent-client-web`; the four replica modules; `DeviceDatabase` and `Transport` ports; builders and the device-database contract.
- **Contract and fixtures first.** S6 and S7 sections; `buildReplica`, `replicaAfter`, `device-records/v<n>.json`.
- **Code moved.** `agent-remote-web` `react/`, `browser`, `styles.css` to `agent-client-web`; the rest to `agent-client`; the reducer split. The lab's imports change to the two packages.
- **Tests added.** S6 (about 25), S7 (about 15), device-database contract.
- **Deleted.** About 20 web tests that need a fake server only to reach the reducer.
- **Scope after.** A client-core change no longer loads jsdom or React; the client suite runs in the `node` environment.
- **Risk.** Medium: the published `agent-remote-web` name is deprecated when the owner publishes the new ones.
- **Baseline check.** Golden transcripts through the new client; the browser component tier on builder states.

### M9 Client succession model (X1)

- **Creates.** `agent-client/succession`: `reduce(state, event)` returning state and effects as data.
- **Contract and fixtures first.** Event and effect types; the succession scenarios as vectors, built from the 163 tests of `App.succession` (landed split into five files by the quick win).
- **Code moved.** About 700 of the 1,152 lines of `useSessionSuccession.ts`, in three slices (roles and operations, refresh and recovery states, deadlines).
- **Tests added.** About 120 table rows (5 lines each) and 8 to 10 seam tests over S3.
- **Deleted.** About 150 tests: about 3,000 lines of `App.succession.*` and about 30 tests among the 41 other lab files that touch succession.
- **Scope after.** A succession change runs the table (under 1 s), S3 and the Workbench hook tests: 74 s becomes about 3 s.
- **Risk.** Medium (logic entangled with effects). Characterize first: run the existing App tests against the new hook, then add the table.
- **Baseline check.** The old tests stay until the table passes the mutation check; E5 e2e and a manual succession on `pnpm local`.

### M10 Controller session core and publisher (X9)

- **Creates.** `controller/session-core` with `ProviderFacade`, `RelayLink`, `Clock`, `StateStore`; `controller/publisher`; `controller/uplink-client`; `createController` composition.
- **Contract and fixtures first.** The `RelayLink` port and the S2 Controller-side transcripts; a scripted `ProviderFacade` built from S1 recordings.
- **Code moved.** The 1,350-line closure of `createAgentHostRuntime` in five slices: catalog, attach and create and binding, outbox delivery, directory, publication and succession wiring.
- **Tests added.** Per slice: unit tests with fake ports and transcripts. The four tests that build a real Relay (`host.test.ts`, `host-journal.test.ts`, `session-succession-runtime.test.ts`, `tpm-host.test.ts`) switch to `RelayLink` fakes playing S2 transcripts.
- **Deleted.** About 40 tests of provider rules restated through the Controller (they become S1 runs).
- **Scope after.** A Controller rule change runs its module and S2: host package 74 s becomes about 35 s, a module change about 5 s.
- **Risk.** Medium; one slice per session and `host.ts` shrinks each time.
- **Baseline check.** S2 loopback golden; the S6a terminal-refresh recordings; a Claude and a Codex session on `pnpm local`.

### M11 Relay concerns and host session (X6, X5)

- **Creates.** `BrokerState` as one object, then one module per concern in the order: journal deletion, pairing keys and bindings, succession associations, relations, support, teams, sharing and previews; last `host-session`. `broker.ts` becomes `relay.ts`, under 900 lines.
- **Contract and fixtures first.** For each concern: its guards and its transcripts (S2 or S3).
- **Code moved.** About 2,100 lines out of `broker.ts` in eight slices; each leaves the old `broker*.test.ts` green until its own unit suite is in.
- **Tests added.** Per-concern unit files at unit speed; `host-session` runs the 15 heartbeat tests with a fake scheduler and socket.
- **Deleted.** About 15 tests (the succession association rules restated in hosted and Cloudflare), and the heartbeat tests restated in relay, lab and Cloudflare (about 12).
- **Scope after.** A concern change runs that concern's unit and its transcript: about 3 s. Relay-core's package run falls from 10 s to about 6 s.
- **Risk.** Medium; `register()` touches nearly every map, so `host-session` goes last and only after `BrokerState`.
- **Baseline check.** Golden transcripts for every wire message; the old `broker*.test.ts` become integration tests and are kept until the last slice.

### M12 The Node Relay host and the e2e stack

- **Creates.** `agent-relay-node` (from `lab/src/server`), `agent-e2e/stack`, the scenario server in `agent-remote-fixtures/scenarios`.
- **Contract and fixtures first.** The stack's start, stop and restart interface used by flows and smoke.
- **Code moved.** `lab/src/server/*` (2,739 lines); `recorded.ts` to scenarios; the Playwright configs to `agent-e2e`.
- **Tests added.** About 30 `transport` tests that stay on a real socket (pairing, reconnect, lease race).
- **Deleted.** About 120 of the 299 server tests that use real sockets for logic move to relay-core contract or seam tests; about 40 transport tests in `lab/src` become S3 tests. They are counted as moved, not as lost.
- **Scope after.** A Workbench change no longer starts a Relay. M5, M6 and M8 smoke scenarios can run.
- **Risk.** Medium: 53 lab test files start a server; they move in the order of their rule's owner.
- **Baseline check.** The e2e stack replays the golden scenarios; `pnpm local up` serves the same pages.

### M13 Workbench state (X7)

- **Creates.** `workbench/state`: one reducer with selectors, built slice by slice: selection, cached versus authoritative content, recovery notice, window composition, draft ownership, live budget.
- **Contract and fixtures first.** Each slice's events and vectors from today's App tests.
- **Code moved.** About 1,800 of `App.tsx`'s 3,765 lines, merging `window-workspace.ts`, `conversation-recovery.tsx` and `workbench-mode.ts` glue.
- **Tests added.** Table-driven, with S6 for the views.
- **Deleted.** About 260 of the 425 `App*.test.tsx` tests (about 5,000 lines); about 25 render smoke tests stay.
- **Scope after.** A state change runs its table; a view change runs S6. Lab worker time 128 s to about 25 s.
- **Risk.** High: every Workbench feature touches `App.tsx`. One slice per session; no slice mixes a feature.
- **Baseline check.** The E1 to E7 flows; the component tier; the old tests stay until each slice's mutation check.

### M14 E2E flows and the component tier

- **Creates.** `agent-e2e/flows` (the 28 tests of 5.6) and the component tier.
- **Contract and fixtures first.** The scenarios per flow, written as scripted-provider scripts.
- **Code moved.** Layout and fixture-page specs (about 200 tests) to `e2e/components` on builder states.
- **Tests added.** The 28 flows; the three named local findings each with its lower-tier test.
- **Deleted.** About 170 behaviour specs, per area, after the owner signs off and each passes the mutation check at its lower tier.
- **Scope after.** Step-end gate runs 28 flows in about 4 minutes and the component tier in about 90 s.
- **Risk.** Medium: only deletes what a lower tier has proven.
- **Baseline check.** The flows run first against the baseline tag's build to prove they describe today's behaviour.

## 7. Measuring success

Everything is measured by two commands: `pnpm test:inventory` and `pnpm arch:report`, and compared with the M0 baseline in `test-metrics.json`.

| Measure | How | Baseline | Target |
|---|---|---|---|
| Per-change affected tests | `pnpm test:changed --dry-run` for ten canonical changes (a pure function; a broker rule; an adapter; a Workbench component; a protocol message; a lease rule; a send-state rule; a succession rule; a store; Cloudflare glue): test count and seconds | M0 | Each under 10 s; none over 40 s; a rule change never selects another layer's package |
| Wall time | Vitest per project, outer wall of `pnpm verify`, e2e and component runs | 320 s serial; verify over 540 s | 90 s mock-data tiers; 7 minutes verify; 4 minutes e2e |
| Counts per tier | Inventory by suffix | About 6,200 unit, 1,700 mock integration, 1,500 real-stack integration, 400 e2e | About 7,000 unit and contract, 365 seam, 30 transport, 20 workers, 150 process, 28 e2e, 200 component |
| Slow tests | Reporter | Measured in M0 | None over 1 s; under 1 percent over 300 ms; ratchet only down |
| Redundancy | `arch:check --redundancy` | Clusters C1 to C8 | No rule tag in two modules' unit suites |
| Module sizes | `arch:report` | `broker.ts` 2,737; `host.ts` 1,807; `App.tsx` 3,765; `reducer.ts` 725 | Roots under 900 (`relay.ts`, `controller.ts`), `App.tsx` under 800 after M13; no closure over 300 lines; no source file over 800 lines except tables |
| Layer violations | `arch:check` | Leaks L1 to L8 | Zero, and blocking |
| Mock data discipline | `arch:check` | Inline wire literals in tests: counted in M0 | Zero outside fixtures |
| Smoke | Reports | First report at the baseline tag | Every finding has its transcript, seam test and unit test; open findings listed |

## 8. Decisions for the owner

1. Approve the layers and rules of section 1 and the package map of section 3.1, including the renames: `agent-remote-relay` to `agent-session-runtime`, `agent-remote-hosted` to `agent-relay-core`, `agent-remote-cloudflare` to `agent-relay-cloudflare`, `agent-host` directory to `agent-controller`, `agent-remote-web` into `agent-client` and `agent-client-web`, `agent-remote-lab` into `agent-workbench`, `agent-relay-node` and `agent-e2e`. Two of them are published names (`agent-remote-relay` and `agent-remote-web`); say when to publish the new names and deprecate the old ones. Nothing here publishes.
2. Approve 28 e2e tests (24 to 32) as the target and the list in 5.6, and the component tier for layout.
3. Approve a small real-transport tier (at most 30) for protocol, pairing and reconnect, as AGENTS.md asks.
4. Approve deleting duplicate tests per extraction after its mutation check, area by area (section 6).
5. Approve smoke as on demand and before release, never a gate for a task.
6. Confirm the order of 6.1, and that M2's renames wait until the other agent's quick-win work in this worktree is committed.
7. AGENTS.md should gain the layer table of 1.1 and the tier table of 5.1 when M0 lands; this document changes no file but itself.

## 9. What was not verified

- Counts per tier after the migration are estimates built on the assessment's, which are estimates from names and imports. M0 replaces them with measurements.
- The share of tests over 300 ms and 1 s is unknown today.
- Which relay-core concerns the edge (`gateway.ts`) shares with `agent-relay-node` and the Workers host needs a per-file pass in M11 and M12.
- The refusal reason list in S2 follows the code before the S2 simplification finished; the contract document written in M1 replaces it with the current list.
- `agent-relay-node` may need to keep the DSH and devbox helpers of `lab/src/server`; a per-file pass in M12 decides which move to `agent-e2e`.

## 10. Open items

Every shortfall of a finished step is tracked here with the step that owns it and its status. Update this table in the commit that closes or moves an item.

| # | Item | Found in | Owner step | Status |
|---|---|---|---|---|
| O1 | The relay-core package run did not get faster (8.7 s, 1,105 tests, 22 over 300 ms, 3 over 1 s). Identify each slow file and cause; fix with a clock, a store port or an extracted rule | M11 | M12 | closed (open-items sweep, 2026-11-19): every slow file fixed at its cause, none allowlisted. `succession-replay` keeps its durable file in memory, caches cost measurement per view and builds its oversized chain from 40 freezes plus padding (7.5 s to about 3 s for 96 tests); the Team and Call For Support fill loops add each entry's own size instead of re-encoding the Team; the draft ceiling is seeded in the stored state; `broker-journal-switch` waits for the end of a pass, not a sleep; `journal-session-stream` and `team-negotiation` poll at 1 ms, and `team-negotiation` uses `memoryHostClient`. Package: 1,130 tests, 24 over 300 ms and 1 over 1 s before; 1,162 tests (32 ported from the Worker tier) with 0 over 300 ms alone and 0 over 1 s after (4 over 300 ms in the loaded gate run). Allowlist entries 3 to 0 |
| O2 | The Controller's slowest files are disk and fsync bound, not Relay bound: `session-succession-capacity` 18.7 s, `session-source-witness` 16.8 s, `tpm.test` 12.1 s. An in-memory `StateFileWriter`, one real-disk test per store | M11 | M12 | closed (open-items sweep): the succession byte ceiling is an input of `SessionSuccessionStore`, `SessionSuccessionContextStore` and `SessionSuccessionService` (`storeBytes`, default 8 MiB); the capacity rules run at 256 KiB and one 8 MiB test is in the `process` tier (`session-succession-capacity.process.test.ts`, 0.26 s). `session-succession-capacity` 7.5 s to 0.38 s; `tpm.test` 8.9 s to 2.9 s (the cost was `expect.poll`'s 50 ms interval, not the ceiling). The host's succession config passes `files: { roles, contexts, storeBytes }`, so the runtime tests use `memoryStateFiles`; the restart-settlement delay and the environment probe timeout are injected. Controller: 13 over 1 s before, 1 after in the loaded gate (it passed the re-measurement alone); 12 allowlist entries to 0. Open: `session-source-witness` still builds 8 MiB states (330 ms); the Team runtime has no `StateFiles` port |
| O3 | Only 10 duplicate tests were deleted in M11. Decide for each remaining succession and gateway group: main flow (e2e, lower duplicates go), seam behaviour (seams package with mock data, slower copy goes), or unique wiring (kept, reason recorded) | M11 | M12 | closed for the decision (O3/O6 slice, 2026-11-19), every group decided: the 53 moved succession tests (38 deleted by mutation check, 15 kept as contract); relay-core `succession-replay` 96, `gateway-*` 93 and `broker*` 172, and the Node Relay gateway, succession-revocation, hosted-runtime and remote-host-broker files 97: 458 kept as wiring, decided by file with the reason per file in `2026-11-19-o3-o6-succession-mutation-mapping.md`. A sample of 22 Relay mutations shows 26 of 60 replay tests catch something no owner unit test catches, so they are not duplicates; 7 replay tests are named deletion candidates pending the full survey of 92 `succession-service` mutations. Open as follow-up work: that survey and one of the owners of `gateway-*` and `broker*`; `succession-replay` still opens real ports. Census remainder (final slice, sampled): 233 one-line mutation sites in 31 relay-core modules (every 3rd to 64th site per module, recorded in the mapping document), run against the owner unit tests and the 265 `gateway-*` and `broker*` tests: 227 completed, 89 caught by an owner test, 54 only by gateway or broker tests (33 of them in modules with no unit test), 84 by nothing. No gateway or broker test is a deletion candidate: 94 catch a mutation no owner test catches, 152 are the only coverage of a module with no unit test, 17 caught nothing in the sample and are not judged. All 233 sites of `succession-service`: 113 owner-caught, 66 caught only by `succession-replay`, 54 by nothing. The 7 replay candidates are kept: each catches a mutation no owner unit test catches (lines 46, 103, 119, 124, 146, 158, 168 of `succession-service.ts`); `rejects delayed describe...` catches only line 124 (the enrollment version 2 threshold), which 21 replay tests also catch, so it becomes deletable once an owner unit test pins that threshold. Closed |
| O4 | The teams and Call For Support wiring is still in `broker.ts` (about 130 lines) | M11 | M12 | closed: `team-service.ts` (11 unit tests, 10 mutations caught) |
| O5 | The browser socket edge (`upgrade`, `admitClientMessages`, `acceptJournalServed`, about 180 lines) is still in `broker.ts` | M11 | M12 | closed: `socket-edge.ts` and `client-admission.ts` (14 unit tests, 12 mutations caught); `broker.ts` is 423 lines. The edge itself is tested through the old broker tests; its own suite is open |
| O6 | 46 `session-succession-runtime` tests still start a real `createHostBroker`; they move to the seams package once the Controller exports `session-succession-*` | M11 | M12 | closed (O3/O6 slice, 2026-11-19): the 53 cases (44 tests plus `test.each` variants; the row said 46) that started a real Broker moved to `seams/S2/succession-*` on memory state files and `memoryHttp`, through one new entry, `@orchardworks/agent-remote-controller/succession-host-testing` (not five). The Controller's side of the Relay rpc, `session-succession-enrollment.ts`, had no unit test (1 of 15 sampled mutations caught without a Relay); it has 30 now (0.4 s). Of 158 one-line mutations (86 enrollment, samples of service, coordinator, boundary and the Relay's `succession-service`), 129 are caught by an owner test and 29 by none; no moved test catches a mutation an owner misses, so 38 were deleted and 15 kept as Controller-plus-Broker contract tests (Relay-built freeze v1 to v3, relations, `source-result`, cancel, TPM participants, handshake). `session-succession-runtime.test` 92 tests in 16.6 s (11 over 300 ms) to 39 in 3.1 s (3); no Controller succession test starts the Relay. Controller 1,819 to 1,796 tests, seams 312 to 327. Mapping: `2026-11-19-o3-o6-succession-mutation-mapping.md` |
| O7 | Four relay-core `cross-package-relative` exceptions: two protocol Team fixtures (need a protocol `./testing` entry) and two Cloudflare storage codec imports (the tests move to the seams package) | M11 | M12 | closed in M12: the frozen Team codecs are the protocol `./testing` entry; the codec names the tests used are aliases of `record-codec`, which relay-core owns, so the tests import it from there and nothing moved to seams; the exception is deleted |
| O8 | Smoke scenarios M4, M5 and M8 need journal limits and a separately stoppable Controller; they wait for the Node host | M4 | M12 | closed (open-items sweep): `createGatewayRelay` and `createDevboxServer` take `journalLimits`, and the local runner reads `ARC_LOCAL_JOURNAL_LIMITS` (with `ARC_LOCAL_JOURNALS=1`); production defaults unchanged. M4, M5 and M8 drive a scripted second Host on the instance (no model turns), so the instance's own Controller did not need a separate stop for them (M2 already stops it through `instance-process.mjs`; the Node stack has `stopController`). Results: M4 seed 4001 pass (7 invariants; a 3.9 MB session against a 256 KiB limit and four 700 KiB sessions against a 2 MiB Host limit); M5 seed 5002 pass (200 sessions, a 50-bot group, 300 seeded actions, peak live subscriptions 1 of a budget of 6, 14 of 14 untouched rows kept their elements, heap 12.0 to 14.7 MB); M8 seed 8006 pass for 10 minutes (60 cycles on 3 panes, sockets constant at 2, heap 12.7 to 24.3 MB). M4 joined `smoke:quick`. Findings: O36. In the end gate `smoke:quick` (M1, M2, M4, M7) and M5 passed on the merged HEAD; M8 errored twice on harness preconditions, not the product: the command line was signed out after M4 restarted the instance, and on an instance started without `ARC_LOCAL_JOURNALS=1` smart reading is refused (409), after which the run hung 48 minutes because the scripted Host stayed open (fixed: it is closed on a failed setup; the run now exits in 2 s). Harness preconditions fixed (ad809cf6): a restart signs the command line in again (`ensureCommandLineSignedIn`, up to 4 sign-ins 20 s apart), the runner signs in at start and refuses to start M4, M5 or M8 unless `ARC_LOCAL_JOURNALS=1` is exported. On the final code of the 2026-11-19 sweep, a first 30-minute M8 errored in 1 s: `login status` said signed in while every user API call answered `signed_out`, because the Devbox answers a local `/auth/status` with an expired cookie by opening a new browser session (200) that the command line ignores, and `login` then keeps the expired credentials. The harness now checks `host list` and signs out and in again (7217db2c). The 30-minute M8 then ran in full (seed 8109, build a09d8fff, 180 cycles, 1,086 rows written, the last streamed reply shown in 3 of 3 panes): 7 of 8 invariants passed (row counts, sockets constant at 2, no duplicate key, no blank frame, no stale label, contiguous sequences, replies shown); `memory-flat` failed, see O38. Closed for the harness |
| O9 | The Worker tier still has 157 tests against a target of about 20. Security, controller updates, authority renewal and connection diagnostics are not ported to lower tiers | M3 | M12 or later | closed (2026-11-19): 157 to 31 Worker tests (`pnpm test:workers` about 121 s to 35 s), each deletion mutation-checked (mapping document, open-items sweep). The owner's coordinator decided to keep the 31 that remain rather than go to about 20: they are Durable Object wiring (runtime 5, journal-partition 6, store-conformance 2, preview-runtime 2, feature-persistence 2 and 14 single tests) whose subject is the Workers runtime itself (socket upgrade and hibernation, alarms, storage envelope chunking, eviction), so a lower tier cannot prove them, and dropping them would leave those bindings unproven before a deploy. Mutations no test catches stay recorded: the journal session and item deletes, the accounting chunk total, the diagnostic size limit, the session-states acknowledgement check |
| O10 | Far fewer duplicates were deleted than estimated in M5 to M9. The `App.succession` composition tests wait for the Workbench state module | M5 to M9 | M13 | M13 deleted 2 whole-app tests. Closed (Workbench slice): 4 more whole-app tests deleted with mutation proof (3 succession, 1 `App.test` double-create activation), 417 of 421 kept; they assert wiring and UI that has no unit owner yet. The next cuts are effect-level hook tests for `useSessionSuccession` and `useQuotesAndReferences`. Final slice (395c6d13, 251bc3dc): the effect-level hook tests exist: `useSessionSuccession.effects.test.tsx` (25 tests, about 70 ms; discovery, Relay feed, stale retry, attach and binding, settlement) and `useQuotesAndReferences.test.tsx` (17, about 30 ms), on fake ports and clocks. Mutations: `useSessionSuccession` 30 (18 caught by the new tests, 12 survive both suites; every one of the 8 the old tests catch is caught), `useQuotesAndReferences` 24 (21 caught, 3 equivalent; the old tests' 7 all caught). 2 whole-app tests deleted (the cancelled-handoff recovery wait and the `route_not_found` fallback); 159 `App.succession.*` kept, the 3 quote tests among them because they alone check the quote bar's lists, chips and sent frame. Mapping in `docs/current/agent-remote/workbench-state.md`. Closed |
| O11 | The Controller's session-core modules read shared state through a typed context, which renames the coupling rather than removing it. The bindings, the idle sessions and the operation cache need one owner module each | M10 | later | closed (O11 slice, 2026-11-19): the session core no longer shares mutable state through its context. `ProviderRegistry` owns the registrations and catalogs, `AttachmentLedger` the prepared sessions, native attachments, worker-tool records and idle uncertainty, and `BoundSessions` the bindings and families; each is the only place its state is assigned, `host.ts` builds them and the modules receive their interfaces. The operation cache (`OperationCache`, session runtime) and the idle sessions (`createIdleSessions`) already had one owner and are passed as interfaces, idle narrowed to the five operations the core uses. `SessionCoreContext` 50 to 44 members, raw shared collections on it 6 to 0; `host.ts` 573 to 551 lines. 25 unit tests (registry 8, ledger 8, bound sessions 9), 39 of 39 mutations caught; no old test deleted (the rules were inline in `host.ts` with no test of their own) |
| O12 | Slow-test enforcement is opt-in (`ARC_SLOW_TEST_ENFORCE`). It becomes the default once the allowlist is justified entry by entry | M0 | M12 | closed (open-items sweep): enforcement is the default (`ARC_SLOW_TEST_ENFORCE=0` only lists). Before failing a run the reporter runs the test's file once more alone on one worker and fails only if the test is over 1 s again, a retry for timing only (in the loaded gate, 3 tests over 1 s passed the re-measurement and 1 failed it twice). The allowlist refuses an entry without a reason and names allowlisted tests that ran under 300 ms. Allowlist 71 to 11 entries: Cloudflare `storage-incremental` (3, a commit-cost measurement at operating size), journal 200,000-item paging and prepend (2, a spread-argument limit needs that size) and 6 whole-App tests (O18) |
| O13 | Privacy display-lease decision: a longer display lease would let a returning person see rows at once, but it changes the privacy rule. The owner decides | M8 | owner | open |
| O14 | The transport tier in the seams package is 108 tests against a target of about 30 | M8 to M11 | M12 | closed (open-items sweep): `memoryHttp(server)` (`agent-session-runtime/testing`) runs any Node `http.Server` with no listener, through its own HTTP parser, upgrade authorization and WebSocket framing. 40 `runtime-http-server` tests moved to `tests/S3/runtime-http-server.integration.test.ts` (0.5 s), the image and echo files to S3 and `runtime-plugin-host` to S2. Seams transport 62 to 9 (`session-channel-transport` 5, four real-port `runtime-http-server` tests). Repository transport tier about 180 to 31: seams 9, Workbench 2, client-web 9, e2e latency proxy 11 |
| O15 | `App.tsx` is 3,649 lines against the target of 2,000 and keeps its `root-too-large` exception; `AppContent` is one function with 140 `useState` and `useRef` hooks, 49 effects and a 400-line render | M13 | M13b | closed in M13b: `App.tsx` is 90 lines and the exception is deleted. `AppContent` is 30 hooks in `src/app` (4,390 lines; the largest 317) that run in the original order and take what they read from the earlier ones as an explicit `Pick` type (`AppScope`), plus `WorkbenchView` and 20 views in `src/app/views` (608 lines). The one cycle (the succession model's callbacks read state declared after it) goes through a per-render `late` object typed in `AppLate`. The hooks follow the dependency order of the old function, so a hook is the stretch of the old body that could stand alone, not always one concern; the next cut is per concern (see O21) |
| O16 | State rules still inside `AppContent` with no module: side selection and focus, Ask visibility and sources, tracking and attention eligibility, title projection, the open and bind flows (`openSession`, `bindDirectorySession`, `openChildSession`), forks and communications | M13 | M13b | M13b moved five modules (`side-layout`, `attention-targets`, `session-titles`, `session-binding`, `letter-navigation`; 101 tests, 107 mutations caught). Closed (Workbench slice, 2026-11-19): six more modules in `src/state`: `ask-visibility` (24 tests), `child-session-plan` (15), `agent-creation` (22, `createAgent` and `resumeAgent`), `fork-plan` (24, fork creation and opening), `quote-flow` (9), `succession-gates` (58, the send and succession gates of `useSendingAndSuccession`), plus a `handoff-command` table (11, the parser had no test). 163 tests; 183 of 199 one-line mutations caught, every survivor equivalent (a non-null assertion, `??` versus `||`, a type-only change). The hooks keep the effects and call the slices |
| O17 | 18 Workbench test files (about 146 tests) start a real listener and are relabelled `.transport`; the Workbench has 228 transport tests against a repository target of 30. `useWindowWorkspace` (59), `directory-client` and the recorded-Relay tests need an in-memory fetch and socket | M13 | M14 | closed (open-items sweep): `memoryProtocolRelay` and `memoryRecordedRelay` (`agent-relay-node/testing`) and an in-memory Controller uplink (`memoryHttp(...).uplinkConnect`) took 14 files out of the transport tier; Workbench transport 102 to 2 (`resource-server`, which checks the production debugger composition over a real WebSocket on purpose). The broker takes `connectLocalSession`, and the DSH plugin takes `uplinkPorts` |
| O18 | The 160 `App.succession.*` tests were not mapped to `agent-client/src/succession` and the `useSessionSuccession` hook test by test; the allowlisted whole-app tests over 1 s are mostly in this group or in `App.render-budget` | M13 | M13b | closed (Workbench slice): all 161 `App.succession.*` tests are mapped to a group and its owners in `docs/current/agent-remote/workbench-state.md` (8 groups; owners `agent-client/src/succession`, `succession-gates`, `handoff-command`, the hook tests). 3 deleted after the mutation check (the Handoff pending-input chooser and the two malformed Handoff provider-argument tests); 158 kept as composition: no kept test catches a mutation its owner table misses, after one real gap in the history table (a chain that returns to a session, an unknown session asked for with history intent) got two rows. Mutation proof against the owners: `reduceRefresh` 35 of 40, `settlementOf` 23 of 26, `sessionSuccessionHistory` 40 of 49. What keeps them: `useSessionSuccession` (1,072 lines) has no effect-level hook test, and the dock and Team Handoff commands no view-model test |
| O19 | 20 Workbench and 6 debugger `cross-package-relative` exceptions remain: they need public entries | M13 | M14 | closed (O19 slice, 2026-11-19): the Workbench `cross-package-relative` exceptions (19 allowed, 20 found), the 6 of the debugger and the 2 Workbench `dist-import` exceptions are deleted, and the Controller's fall from 10 to 4 (the shared Copilot fixture entry fixed its Copilot tests); documented violations 55 to 22, `arch:check` 0 failing findings. Entries added: Controller `./session-state-publisher`, `./window-command`, `./testing/relay-session-harness`; client-web `./testing`; the Copilot native fixture in its `./testing` (moved from `tests/` to `src/test-utils/`); session runtime `attachAgentRemoteWebSocketStream`; debugger `./server`, `./testing/browser-prefix-adapter`, `./testing/session-view`; Workbench `./directory-client`. Every path import became a package import, so no bundle mixes `dist` and `src`. The debugger's `copilot-approval` and `copilot-diff` e2e specs fail the same with the old imports (not caused here). Owner question: the debugger's `./testing/*` entries point at unpublished sources of a published package |
| O20 | The smoke probe fails when the instance's Window already holds another view (two composers). Start each scenario in a fresh Window; `agent-remote-debugger/e2e/claude-session.spec.ts` also fails at the baseline | M13 | M14 | closed in M14 for the probe: the smoke probe and its observer read the primary conversation (`.lab-primary-conversation`) instead of the whole document, and every e2e flow starts from a Window with no views (`resetWindows` in `agent-e2e/flows/browser.ts`). Verified with two views in the instance's Window (see the mapping document, M14). `claude-session.spec.ts` of the debugger still fails at the baseline and was not touched |
| O21 | The 30 hooks of `src/app` are cut where the old function could be cut, so several mix concerns (`useSessionOpening`, `useCommunicationsAndForks` and `useSideNavigation` hold 280 to 317 lines each). Cut them per concern (selection, opening, sending, Team, Track, Ask, groups, notifications) and give each a hook test with mock data; 3 whole-app tests were converted so far (see the mapping document) | M13b | M14 | closed (Workbench slice): `useSessionOpening`, `useCommunicationsAndForks` and `useSideNavigation` are thin composers of 16 concern hooks run in the old order (`useStackSelection`, `useSessionBinding`, `useAgentCreation`, `useTeamOpening`, `useTpmMainOpening`, `usePrimaryFocus`, `useLetterNavigation`, `useViewNavigation`, `useForks`, `useSideUnlinking`, `useOpenWindows`, `useAskActivity`, `useReplicaRetention`, `useBotRoster`, `useSideSessions`, `useChildSessions`), each with a hook test on a mock scope (`src/test/render-hook.tsx`, 213 tests); `useSendingAndSuccession` gained a hook test (34). Mutation-checked: `useOpenWindows` 30 of 30, `useSideSessions` 41 of 44, `useChildSessions` 30 of 33, `useSideUnlinking` 20 of 25; the other twelve were not mutation-checked. Workbench unit run before 2,807 passed (63 s wall, 144 over 300 ms, 6 over 1 s), after 3,235 passed after the merge with O19 (78 s wall on a loaded machine, 132 over 300 ms, 7 over 1 s, all allowlisted) |
| O22 | On the e2e stack the page's 'Take control' did not return control from a terminal | M14 | M15 | closed: a stack artifact, not a product defect. The scripted provider named the terminal owner `terminal-1`; `sessionAttachFailure` forwards a native owner only when its generation is a UUID (every owner record of the Controller is one, and the take-over request accepts no other shape), so the Relay learned no owner, the page offered a plain 'Take control', and the Relay's lease grant was followed by a refusal from the Controller. `terminalTakes` now uses a UUID; the page then offers 'Interrupt and take control', and E4 clicks it, sees the composer return and a send reach the provider. The rule that a non-UUID owner is dropped is pinned in `session-errors.test.ts` |
| O23 | E5, E7 and E8 are not written; E3 does not drive a journal replacement or E6 a sleeping pane | M14 | M15 | partly closed in M15: E5 (3), E8 (1), the E3 replacement and E6 sleep and wake are written (31 flows in all, see the mapping document). E7 has 2 tests (a second device on one session, a Team kept by the Controller); the recipient of another account who may only read is not covered, because the Devbox Relay has one subject and Call For Support needs a support profile on the stack. Open: a second account on the stack |
| O24 | With smart reading off for a provider (the legacy read path), a Controller restart moved a reader in the middle of a conversation to the first row | M14 | M15 | closed: not a regression, the same at the baseline tag (real Claude session, restart of the instance: the marked row moved from 194 px to 982 px, scrolled to the first row). The key of a row without item keys carried the journal epoch, so a replacement epoch gave every row a new key, `absorbWindow` kept none, and `useTimelineScroll` found no row with the saved key. The epoch is no longer part of the key (`timelineEntryKey(entry)`); a row keeps its key and its object when the replacement brings the same row, and is replaced by content when it differs. Pinned by `timeline-entry-key.test.ts` (unit), the reducer test of unkeyed replacement, and an E3 flow with smart reading off; on the HEAD instance the marked row stayed at 194 px through a restart |
| O25 | No Playwright spec was deleted or rewritten as a unit or seam test | M14 | M15 | closed for the 70 long-failing tests and partly for the backlog: 30 fixed, 4 mapped to a flow and deleted, 27 moved down with a caught mutation and deleted, 6 obsolete and deleted, 3 passed on re-run; of the backlog, 44 tests moved to the component, unit or protocol tier or were deleted with a caught mutation and about 80 are kept, each with its reason (the mapping document, M15). Open: the kept tests that need a real browser and the Relay for something no flow covers (Ask dock and composer, attach-refusal notices, two Hosts in a group, succession cancellation and recovery, trusted touch) become flows or stay as the owner decides |
| O26 | Smoke M1 (full profile, 1,500 ms and 10% loss, seed 48323) showed no rows in 90 s | M14 | M15 | closed: a harness fault, not a product defect. The proxy took an upstream socket when a request entered it, but sent the request after the loss delay; the instance's server had closed that idle keep-alive socket meanwhile, the proxy answered 502 for the code-split `App` chunk, and the page never recovered (zero WebSockets crossed). The proxy now takes the upstream socket when the delayed request arrives. Pinned by a transport test of the proxy that fails with a 502 on the old code. The full profile passes (7 conditions; first rows on revisit 99 ms at 1,500 ms and 10% loss, 116 ms at 2%) |
| O27 | The page shows nothing when the code-split `App` chunk fails to load once (found through O26) | M14 | M15 | closed: `React.lazy` keeps a rejected import for good and the entry had no error boundary, so one failed chunk fetch left the page without rows until a reload. `loadChunkWithRecovery` (`chunk-recovery.ts`) retries the import with backoff (0.5, 1.5 and 4 s), then reloads the page once, a marker in session storage stopping a loop and a success clearing it. Pinned by 5 unit tests (3 mutations caught: no retry, no guard, guard never cleared) and the E3 flow 'the page shows its rows when the first fetch of the application chunk fails', which times out after 25 s on the old entry and passes on the new. Smoke M1 at seed 48323 (7 conditions, loss 2 and 10 percent) passes with the fix |
| O28 | A second tab or a later open of a session in a shared Window shows 'Session composition needs synchronization (retired)' with a Retry button and no rows | M15 | owner | closed (bdcb7b23): not a regression, a race a slower machine exposes. `SuccessionApplication.recover` returned `pending('retired')` when a local edit changed `editRevision` during its reads, and nothing discovered again. The refresh model (`reduceRefresh`) now rediscovers after an overtaken application, at most 5 in a row, an applied composition starting the count over. Pinned by 13 refresh unit tests (3 mutations caught) and the un-skipped spec 'a fresh view retains Content...' (36 passed on chromium-desktop in 3 repeats; 3 of 3 failed before) |
| O29 | Two findings of deleted tests have no pin: opening the last unread tracked session did not clear the tracking alert in a fixture (`session-stars`), and the attribution table sat 23 px over the timeline in the Ask window (`session-attributions`) | M15 | owner | closed (07e1814f, de457b5d): neither is a product defect. The tracking alert clears on opening the last unread session; the fixture page `session-stars.html` has no Window service, so an opened session never counted as visible there (pinned by a `tracking-state` table, 2 mutations caught, a menu test and the hook test). The attribution table's box ends at the timeline top and scrolls; the old assertion measured the unclipped table (pinned by the component spec `session-attributions-layout`) |
| O30 | On a phone profile the movable floating controls (Window, Team, TPM) sit over the header controls: the Trace tab, the View options Header checkbox, 'Close Favorites' and the quote controls are not clickable ('subtree intercepts pointer events') | M15 | owner | closed (15ad2fc6, 50d837bf): the default column starts below the app bar, the timeline toolbar and a full-screen Ask or TPM heading, and goes under an open View options, Favorites panel or TPM window (unit tests, component spec `floating-controls-clearance`, 7 phone tests un-skipped). The end gate found that the clearance compared layout-viewport bounds with a placement in the visible area, pushing the column 80 to 88 px too low under a keyboard pan; it is now measured in the visible area (unit test; `mobile-keyboard-controls` 30 passed on three projects). Left open as O34: the column does not clear the composer |
| O31 | WebKit with the iPhone profile empties the composer after a synthetic Shift+Enter in the component test of pasted line breaks | M15 | owner | closed (71a0505a): a product defect on iOS with a hardware keyboard, not a test assumption. ProseMirror takes Enter on iOS before `handleKeyDown` and replays it without Shift about 200 ms later, so Shift+Enter sent the draft. `ComposerEditor` reads Shift from the DOM keydown, turns the paragraph input after Shift+Enter into a line break and drops an untrusted Enter within 400 ms. 2 unit tests (3 mutations caught); the component test runs again on `webkit-mobile` |
| O32 | Relay-backed specs never ran green on a phone or in iPhone Safari: 50 failing runs in the first full run of those projects | M15 | owner | partly closed (4522c624): three product defects found on a phone were fixed (the floating controls over a full-screen Ask and TPM window, a 30 px Interrupt button under a coarse pointer, the folder picker returning focus to nothing in Safari), stale assumptions repaired in `mobile.spec` (7) and `provider-layout` (3), and the phone and iPhone Safari projects run more specs again. Open: `claude-discovery`, `directory-relations`, `modernization` (3), `recorded` (1) and `session-forks` (5) fail on a phone and are not in that project; one `session-view-ownership` test is skipped on `webkit-ask-mobile` |
| O33 | A bot view whose session is missing, opened over from the directory, now opens a new primary beside it; the old spec expected the view to be rebound | M15 | owner | closed: not a regression and not a defect. The baseline tag does the same (the restored spec step fails there identically: a third view, a new primary, is created and `main` keeps its binding). Root cause, instrumented: the Window keeps the missing session's binding, so `isBotView` holds, every group has the Bot appearance by default, and `bindPlan` answers `open-beside` (rule 6); the bot design's stage 2b lists 'a new session' among the opens that land beside a bot. The removed step predated rule 6. Pinned by the restored step in `window-workspaces.spec.ts` with the intended outcome (a new primary is selected, the missing view keeps its reference and note; a mutation of `bindPlan` to bind a primary bot in place fails it) and the `session-binding` unit case. Owner question left: whether a bot whose session the Host reports missing should take another session in place (it needs a missing-session fact in `bindPlan`, and rule 1 of the Relay refuses that rebind in a group with bot details) |
| O34 | On a phone with the keyboard leaving a 340 px visible area, the floating Window control sits over the composer's 'Hide message input' | M15 end gate | owner | closed (O34 slice, 2026-11-19): with a 340 px visible area the bottom of the area clamped the default floating column upward over the composer. A default placement now stays above the highest composer dock in the visible area (`useTrackingPosition`); a placement the person made is not moved, desktop unchanged. 3 unit tests (removing the cap, counting a composer outside the visible area, capping an owner placement: each caught). Both `mobile.spec` 'removes the home-indicator inset...' variants are un-skipped and pass on `chromium-mobile` (`mobile.spec` 11 passed); `mobile-keyboard-controls` 30 on three projects (one expectation that pinned the Ask default over the composer at y=276 updated), `floating-controls-clearance` 24, `floating-controls-layout` 28. Phone screenshots in the O34 worktree's `.tmp/` show Window and TPM above the composer with its controls uncovered |
| O35 | An interrupted agent left an unreviewed change that narrows O28's automatic re-discovery to `retired` only (`local_edit` and `owner_edit` would wait for the explicit Retry), with a matching hook fallback and a tracking-state fixture change. Reverted to the reviewed O28 fix; the change is kept as `2026-11-19-o35-o28-narrowing.patch`. Decide with evidence whether `local_edit` and `owner_edit` should re-discover | e2e cleanup | open-items sweep | closed (O35 slice, 2026-11-19): the narrowing is rejected and the patch file deleted. In `session-composition-application.ts`, `local_edit` means the composition document's `editRevision` moved while the application ran, and `owner_edit` that a text, image or display owner's revision moved while it was flushed; both stop before writing, so nothing is clobbered, and `recover` re-reads the current document, so a rediscovery applies the newer document with the edit. Traced in the O37 test: one `local_edit`, one rediscovery, then `applied`, with the edited draft shown and the independent B owners retained; a loop is bounded by `maxSupersededRetries`. Narrowed, the page shows 'needs synchronization' with a Retry after a keystroke, the O28 symptom. Pinned: the refresh table names `retired`, `local_edit` and `owner_edit` explicitly (it read the constant, so the narrowing passed all 148 client tests), plus a bound test; narrowing to `retired` fails 3, dropping `owner_edit` fails 2 |
| O36 | Smoke M4 showed that the Relay refuses a window larger than the journal budget whole (`journal_refused`, `quota_exceeded`) and the page is served by the Controller; it never trims a replacement to budget as section 5.7 says. After a refusal the publisher sends the whole window again on each reopen (5 publishes of about 4 MB in 13 s) | open-items sweep | owner | closed (O36 slice, 2026-11-19): refusal is the intended rule. The S1/S2 plan's notes after the review of Tasks 7 to 9 replaced D8's trim: the window is admitted whole or refused, live-only items are capped by bytes so a window fits beside them, and the Controller retries with backoff (also the IM session design, Room, and `protocol.md`); section 5.7's M4 row said 'trims' and is corrected. The Relay already did this, pinned by relay-core `host-journals-window` ('refuses a window that the room cannot hold whole...' and two more fail when the admission admits it) and the journal's `keptBytes` and live-only byte-cap tests. The defect was the Controller: `SessionPublication` re-sent the identical window on every backoff reopen. It now remembers the window refused for quota on this connection (items, digests, bytes) and does not open the journal while the window is unchanged; a changed window or a new connection sends again. Pinned by 5 publisher tests (mutations: no hold, kept across connections, any refusal reason, bytes left out of the fingerprint; each caught), the re-recorded S2 transcript `quota-refuses-window` (one refusal through the backoff, then one send of the changed window) and the M4 invariant `refused-window-not-resent`. Smoke M4 seed 4002 passed 8 invariants: the heavy session's 4 windows were each a changed window, the four Host-quota sessions sent one window each |
| O37 | `App.succession.owners-and-attachment` 'retains independent B stores and selected Track through an Ask draft edit before publishing the role' fails (5.2 s, then 5.2 s alone): it expects 'needs synchronization' after a local edit, which O28's automatic re-discovery no longer shows. It fails the same at 21d08d6a | open-items sweep | owner, with O35 | closed (O35 slice): the draft-edit variant now expects the page to discover again and apply the edited document with no Retry (binding B, the edited draft in the composer, independent B text, image and Ask owners kept, Track layouts unchanged); 5.1 s failing to 0.36 s passing. With the narrowing it fails again (5.1 s, the Retry never comes) |
| O38 | The 30-minute M8 soak fails `memory-flat`: the page heap after a collection rose from 12.8 MB (first sample; first-quarter median 18.0 MB) to 38.1 MB (last-quarter median 35.8 MB, limit 32.3 MB) while the three panes grew by 1,086 rows; extra rows and sockets stayed flat. The 10-minute run at the open-items sweep grew 12.7 to 24.3 MB for about 360 rows, so the growth per row is not larger than before this sweep, but the invariant cannot tell a leak from retained conversation: it compares a growing page with a fixed 1.5 times plus 5 MB | sweep end gate | owner | closed (final slice, 2026-11-19): no leak. The invariant now judges the heap per retained row: samples carry the rendered rows, and after the soak a fresh page opens the same Window and loads older history until it holds the soaked page's rows; the soaked heap may be at most 1.25 times the fresh page's heap per row plus 5 MiB, and growing rows with no fresh page are not judged (3 invariant tests). 30-minute run, seed 8210: 1,086 rows; soaked page 38.1 MB (35.1 KB per row), fresh page holding the same 1,086 rows 36.3 MB (33.4 KB per row), so 1.85 MB (5 percent) after 180 cycles is all the soak adds. M8 passed. The page keeps every row of an open conversation at about 33 KB each (10,000 rows would be about 330 MB); bounding retained rows is a product decision, not a leak |
| O39 | The debugger's `./testing/*` exports point at `e2e/` and `web/`, which the published package does not contain, so an external consumer sees broken entries | O19 | final slice | closed (dc6c1b44, 496b077a): `publishConfig.exports` lists `./server` and `./dist/*` only; the testing entries stay workspace-only (`pnpm pack`: before 3 entries, 2 missing targets; after, every target present). Running the installed-package test found two packaging defects that had kept it red: the public `agent-session-runtime` depends on `agent-timeline`, which was private (npm E404 on install), and the O19 exports map hid `dist/server.js` and `dist/local-session-succession.js`, which published consumers import (TS2307). `agent-timeline` is publishable now (nothing is published) and `./dist/*` stays exported; `scripts/agent-remote-debugger-package.test.mjs` 0 of 1 to 1 of 1 |
| O40 | The E3 flow 'the reader keeps their line when a Controller restart replaces the journal...' fails intermittently: after the restart and a send, the reader's row moves 6,119 px | final end gate | owner, before deployment | closed (78ad67b4): a product defect, not flow timing, and not a regression (item-key negotiation predates the baseline tag; no product source changed since a09d8fff, where the flow passed by the race). The page's trace on a failing run showed the first page served by the Controller (row keys without item keys, `codex:28:rewritten:r28`) and, after the restart, by the journal (`rewritten:r28`): every row key changed at once, `useTimelineScroll` found no row with the saved key and sent the reader to the first row (Row 30 from 476 px to 6,595 px). Which path served the first page was a race in loaded full runs (2 of 4 failed; 0 of 10 runs of the file alone); turning smart reading on for a session read from the Controller does the same every time (6,228 px, 2 of 2). O24's fix took the epoch out of the fallback key, but the fallback key and the item key still differ. The hook now keeps the anchored row element; when its key is gone, the one row with the same text is the same row (none when the text repeats, which keeps the old fallback). Pinned by 3 `useTimelineScroll` unit tests (2 of 2 mutations caught) and the E3 O24 flow, which now also turns smart reading on and restarts the Controller (fails on the old hook with 6,228 px). `test:e2e:flows` after the fix: 20 of 20 consecutive full runs passed (620 flows); on the instance with journals, turning smart reading on for a Claude session read from the Controller and restarting the instance changed every row key (`claude:1:...` to `user:...`) and the reader's row stayed at -2,584 px |
| O41 | The mutation census found Relay authorization, origin, access, lease and credential checks that no owner test fails on: `gateway` 537 (origin), 668, 710, 380, 933, `session-directory-routes:51`, `session-read-routes:35`, `controller-routes:57`, `broker:262`, `session-bindings` 98, 134, 223, 431, `pairing-routes` 150, 175, and 8 `host-session` mutations only gateway or broker tests caught | final census | owner, before deployment | closed (a1f4c11c, d4ca75b4): 43 owner unit tests with mock data in 10 files; 27 census mutations and 15 adjacent `requireOwner`/`requireAccess` mutations caught, each run against the new tests and reverted; 2 adjacent mutations equivalent (`requireHost` refuses an unknown Host the same way), `gateway:1143` (a close code) not security-relevant and left. No check was ineffective: no bypass. `broker:262` guards a real leak (a guest would see the owner's session identity through a relation that follows a role). Table in the mutation mapping document |
| O42 | At 390 x 844 the floating Track, TPM, Window and Team launchers cover the conversation text again (I1 phone screenshot) | I1 | owner | closed (phone-launchers slice, 2026-11-20): O30 and O34 were placement guards. `useTrackingPosition` kept the default column clear of named elements (app bar, timeline toolbar, composer), but the conversation it floats over was never one of them, and each new launcher added a stylesheet row (60, 114, 168, 220 px) further into the text. On a compact screen (up to 1180 px) the entries now render as capsules in a launcher bar, a wrapping row of the session navigation (`ShortcutPlacement` `bar`); Window moved into the shortcut host so it follows the same placement. The layout reserves the row, so no number of launchers can cover the conversation or the composer; panels open under the navigation. Desktop is unchanged: with the sidebar its Shortcuts rows, without it the floating column in the margin. Component spec `launcher-layout` (390 x 844 with 5 launchers, then 10; 1181 and 1440 px; on Chromium, mobile Chromium, desktop WebKit and iPhone WebKit) and a `shortcut-placement` unit test |
| O43 | Smoke quick after the Orchard steps (seed 68421): M2 and M7 errored, `.lab-primary-conversation [data-testid="prompt-input"]` resolved to two composers; M1 and M4 passed while reading another session's pane | I4 smoke | owner | closed (c9d7cc77 to 407b49c2): a harness fault, not a product defect. Every primary group's root pane has been a `.lab-primary-conversation` since multiple primary groups (b7f70fea, 2026-10-16); the instance's Window held two, and a session link rebinds the selected view in place, here a dock, so the run's session was in no primary pane. O20's rule assumed one primary. A conversation now names its native session (`data-native-session`; not its Host, which the stand-in painted from the device store before the Window loads does not know), and the probe reads, waits on and types into the session its link opened. The observer also reads a tile's status sentence, which replaced `.lab-conversation-status` in tiles. Pinned by the component spec `smoke-probe` (the harness's own probe on two primary groups and a dock; the old rule fails its four tests) and a LabWorkbench unit test. Smoke quick seed 68421 at 5c89e608: M1, M2, M4 and M7 pass; O44 and O45 say what they no longer exercise |
| O44 | A message sent at once after a session link opens over a 300 ms round trip never reaches the session (M1: `replied` false for Claude and Codex, so `message-settles-once` is not exercised). The composer takes it ("1 pending messages. Kept in this page until sent."), then, while the Window tile attaches, says "This session could not be opened." and holds it, although the attach answers 200 a moment later; no `send_message` leaves the page. Reproduced by script at 300 ms with and without loss, typed into the stand-in and into the tile; at 0 ms the same steps deliver | I4 smoke | owner | closed (53c64a2e, 31777cac, e07a75bd): a product defect, in two parts. The page paints the stand-in from the device store and takes the message (Sending); when the Window loads, the succession discovers again (a second `GET v1/session-successions` follows the Window's), and the Window's pane of the session, here a dock, mounts while every locator throws the synchronizing wait. `SessionConversation` counted that wait as a failure: not `opening`, so draft-only, and the composer inferred "This session could not be opened." from draft-only and not opening and held the waiting message, which only Retry sends; nothing released it when the attach answered and the session was ready, and a message typed into the pane meanwhile was refused. At 0 ms the discovery ends before the pane mounts. Not a deadline (20 s), a stale diagnostic or a refused acquire. The invariant now: a waiting message is delivered once its session is ready, however long it opens, and is held as Not sent only for a definite refusal, a business reason of its session (`composerAvailability`) or a view that says it could not open the session (`openFailed`: its attach failed or its locator was refused); a locator still synchronizing is `opening`, as an attach in flight is. State: +1 prop, -1 inferred failure. Pinned by `SessionConversation.opening` (the stand-in, then the pane with its locator unconfirmed and a 300 ms attach, fake timers, about 100 ms; the old classification fails it) and `AgentComposer.pending` (the old composer rule fails it); E9 sends at once with the discovery and the attach answered 2 s late (`PageOptions.relayDelay`; on the old build the desktop pane refused the message). `message-settles-once` counts the person's messages (`turn-sent`), so a message that never left the page fails M1 instead of leaving it not exercised. Smoke quick seed 68421 at 315a88cf: M1, M2, M4 and M7 pass with every invariant exercised (M1 replied for Claude and Codex, `message-settles-once` checked 2 and `journal-sequences-contiguous` 4, in 69 s, was 371 s; M2 `faultLandedMidTurn` true in both rounds; M4 `live-only-items-survive` 6, `liveKeysShown` 3; M7 `journal-sequences-contiguous` 4) |
| O45 | The default Concise process display folds tool calls into their turn, so the smoke sees no tool-call row: M2's tool-call rounds restart the Controller after the turn (`faultLandedMidTurn` false in both rounds; true on 2026-11-19) and M4's `live-only-items-survive` is not exercised (`liveKeysShown` 0, was 3) | I4 smoke | owner | closed (9ec16a94, e07a75bd): the run's session opens in a dock, not an assistant, so it shows this device's default display. `PageProbe.create(..., { process })` stores the default that Settings > Assistants writes before the page's scripts run, and `open` stops the run when the conversation shows another display (an assistant with one of its own); the restart rounds (M2, M3) and M4 open with Full. M7's `journal-sequences-contiguous` had never been exercised (n/e since 2026-11-19): M7 now runs a turn after each return, which reaches the page live. Component spec `smoke-probe`: Concise by default, Full when chosen. Smoke quick seed 68421 at 315a88cf: M1, M2, M4 and M7 pass with every invariant exercised (M1 replied for Claude and Codex, `message-settles-once` checked 2 and `journal-sequences-contiguous` 4, in 69 s, was 371 s; M2 `faultLandedMidTurn` true in both rounds; M4 `live-only-items-survive` 6, `liveKeysShown` 3; M7 `journal-sequences-contiguous` 4) |
| O46 | A terminal `codex exec resume` fails with "thread … already has an active writer" while a page shows the session, and for minutes after it closes (the known issue M6 was asked to meet) | M6 | owner | closed as expected behaviour (2026-11-21, owner's boundary in 5.7): a separate Codex process may not write a thread that the shared daemon has loaded; that is Codex's single-writer rule (`~/.codex/thread-writer-locks`), not ours, and we add no lock, release policy or handover for it. Measured with codex 0.171: a separate process is refused until Codex unloads the thread 60 to 70 s after its last client leaves (refused at +58 s and +60 s, accepted at +70 s and +75 s after `session release`). The terminal path that shares the session is the shared daemon (`agent-remote-controller codex exec resume <id>`, and for the instance `agent-remote-controller-dev codex exec resume|resume <id>`, which the development command now runs): both sides send, Codex orders the turns (a second turn while one runs is refused with "remote thread already has an active turn", and a page message during a terminal turn steers into it), and the page shows the terminal's turn from the daemon's own events in under a second (M6). How long our side holds the thread is O47 |
| O47 | Our side holds a Codex thread longer than Codex needs, and a shown page stays live only while the Controller holds it: (1) the Controller keeps a session's runtime for its idle grace, 5 minutes after the last attach or turn, also when no page shows it, so a separate process is refused for about 6 minutes after a page's last use; (2) the terminal refresh (S6a D11) reads a Codex session through an attach, `thread/resume`, so Codex keeps the thread about 65 s after every refresh; (3) a journal-served page holds no demand, so 5 minutes after the open the Controller releases the session while the page still shows it: a shared-daemon terminal turn then reaches the page only through the refresh, 30 s after it ended, and the page says idle while it runs (02:53:58 open, 02:58:59 `session_idle_released`, 03:00:44 terminal turn, 03:01:14 shown) | M6 | owner | open: needs a Controller release and an S2 signal. Proposed: the Relay tells the Controller which sessions a page shows, the Controller holds those and releases the others after a grace close to Codex's own unload, and the refresh reads Codex history with read-only methods (`thread/turns/list`) instead of an attach |
| O48 | When Codex refuses the Controller because a separate process writes the session, the page shows none of the session's rows, no activity, and "Native CLI has control" with "Interrupt & take over" (the old private-writer takeover, which stops that process) instead of Codex's reason and a Retry; once the process ended, its turn did not reach the page within 90 s (2026-11-21 03:24:59 to 03:27:40, `.tmp/m6/separate.log`) | M6 | owner | open: the journal-served stream refuses the page when the attach at open is refused (`recoverForJournalStream`), although reads need no Controller; the Controller maps Codex's "active writer" to `native_session_owned`; nothing observes the session read-only meanwhile. M6 reports `page-stays-live-when-codex-refuses` failed. Needs a Relay and Controller release and a protocol error with fixed copy for Codex's reason |
| O49 | A Claude Code page turn and a terminal `claude --resume <id> -p` turn at the same time fork the transcript, and the page and the native session then disagree for good: the page shows its own branch and `session read` the terminal's (or the page's, with the terminal's turn gone). The S6a divergence release does not fire, because it counts a transcript as diverged only when it changed more than 2 s after the Controller's last write, and two turns that end within 2 s of each other pass that check (2026-11-21 03:04 to 03:11: after 190 s the page showed PAGE1Y and PAGE2Y, native history TERM1Y and TERM2Y) | M6 | owner | open: Claude Code coordinates no writers, so one branch is lost whatever we do; M6 reports `no-lost-or-doubled-message` and `terminal-rows-appear` failed for the Claude terminal rounds (all 50 rounds of the full run, seed 70621). The limit is pinned at its bound by `transcript-divergence.test.ts` (1,999, 2,000 and 2,001 ms; the rule moved out of `stdio-directory.ts` unchanged). Options: decide divergence by content (the transcript's newest leaf against the resident session's last message), so the page converges on what native history shows, or name the managed terminal (`agent-remote-controller claude --resume`, an exclusive lease) as the way to type in a terminal while a page is open |
| O50 | With the managed terminal (`agent-remote-controller claude --resume <id> --take-over -p`), the journal-served page is not told that a terminal holds the session: no `session_control` frame arrives while the terminal runs, and the page learns only when its next send is refused (`native_session_owned`). The refusal toast then covers the conversation's own "Interrupt & take over" in the rightmost tile, and pointing at the button pauses the toast's auto-dismiss, so the button cannot be clicked until the toast is closed (`.tmp/m6/claude-after-send.png`) | M6 (exploration) | owner | open: not on M6's paths after the owner's boundary (Claude's terminal is S6a's raw `claude --resume`); the message was kept as "Not sent" with Retry, so nothing was lost |
| O51 | Full smoke M1 (seed 70621): at 1,500 ms round trip with 2 % and 10 % loss the revisit painted its first rows 9,625 ms and 19,931 ms after the document, after the Relay's first page, not from the device store (they passed at 50 and 300 ms, and on 2026-11-18 at 1,500 ms) | full smoke 2026-11-21 | harness | closed (harness defect, not a product defect): the first violating event is the revisit's first row after the `timeline_page` of the session at 110,942 ms. The first open of that condition subscribed three sessions (the Window's panes); the opened session's tail page arrived at 99,524 ms and the probe closed the page 0.8 s later, because `waitForKeptRecord` counted any record of the device store, and the other panes' records were already written. So the revisit had no record of its own session to paint (clause: the device store paints only a kept record of the same session, S7). Run alone at 1,500 ms with and without loss, the revisit painted from the device store in 118 to 127 ms. The probe now waits for the record of the session it opened (`keptRecordOf`, pinned by `smoke/lib/probe.test.ts` with the store's own `deviceKey`); M1 re-run with the same seed passed, the 1,500 ms revisits painting from the device store in 109 and 119 ms |
| O52 | Full smoke M2 (seed 70621): in rounds 8 and 10 (Codex, streaming, graceful stop) the follow-up message never left the page and its turn is missing | full smoke 2026-11-21 | harness | closed (harness defect; the product kept its contract): the first violating event is the follow-up typed at 195,880 ms with no `send_message` after it. The rounds share one session, and the mid-turn check accepted a long reply of an earlier round, so the Controller was stopped 6 ms after the round's first send, before its acknowledgement. The page marked that send `unconfirmed` and held the next message behind it until the person checks it (send-state contract, S6; `send-state.test.ts`), which M2 counted as never sent; its turn check also matched an earlier round's prompt by its first 40 characters. The check now waits for a row of this turn (`landedMidTurn`, pinned by `smoke/lib/restart-round.test.ts`) and finds each turn by the word only its prompt carries. Not re-run: the owner stopped long runs; the explanation rests on the transcript (no `send_message` after the follow-up, the earlier long reply the check matched) |
| O53 | The session-path components have 187 design clauses and 43 without a test (`docs/current/agent-remote/components.md`); most limits in 5.7 are tested, but not at the bound minus one, at it and plus one; two orderings tests enumerate the Relay control lease and the send state, but not yet the Controller session core, the publisher or the replica across restart and reconnect; the fault-injecting provider shows two robustness gaps: no SDK error says how long to wait after a usage limit, and nothing on the Controller's side gives up a hung resume, which holds the session's binding | component statements, 2026-11-21 | owner | open: close the gaps at the lowest tier, in the order of the clause tables; the external dependency review of the provider CLIs is a separate task |

**Skipped tests per tier at the M15 end gate** (2026-11-19, HEAD after O33 and the gate repairs). Before is the final gate of 57027f03.

| Tier | Before | After | Run after |
|---|---|---|---|
| Components (`pnpm test:components`, all projects) | 79 skipped | 70 skipped | 460 passed, 0 failed, 7.5 min |
| `agent-e2e` (`pnpm test:e2e`, all projects) | 73 skipped | 69 skipped | 280 passed, 1 flaky (`session-forks` 'clicking either side-by-side conversation...', passed on retry), 0 failed, 8.4 min |
| Workbench e2e (`pnpm test:e2e:lab`, all projects) | 21 skipped | 20 skipped | 249 passed, 1 flaky (`window-workspaces` 'two pages share Window UI edits...', passed on retry), 0 failed, 8.6 min |

`agent-e2e` has 2 new skips (O34) and, net, 6 fewer from the un-skips of O30 to O32; the e2e flows ran 31 of 31 (71 s).


**Gate of the structure, redundancy and product sweep** (2026-11-19, HEAD a09d8fff for tests and the instance build). `pnpm test` exit 0 with slow-test enforcement on (Controller 1,970 passed and 10 skipped, Workbench 3,235 and 6, relay-core 1,162, seams 327 and 9, Node Relay 286 and 6; one test over 1 s passed its re-measurement alone); `test:conformance` 31; `test:cloudflare` 155; `test:preview-browser` 73 (a first run failed 1: `session-recovery` on WebKit logged an aborted `/v1/remote/hosts` fetch 'due to access control checks' during a page lifecycle; 4 reruns of the file and the whole tier passed); `test:e2e:flows` 31; `test:components` 460 passed, 70 skipped; `test:e2e` 283 passed, 67 skipped (2 fewer skips: O34); `arch:check` 0 failing findings, 22 documented exceptions (55 before); `typecheck`; `fixtures:check`; `smoke:quick` seed 9101 (M1, M2, M4, M7) passed, M1 first rows on revisit 93 ms Claude and 120 ms Codex, M4 `refused-window-not-resent` checked 6; M5 seed 5103 passed; M8 30 minutes seed 8109 failed `memory-flat` only (O38); `compatibility:update` then `check`.

## 11. Final comparison (completion criterion 7)

Measured 2026-11-19 on one machine (10 cores, 16 GB, Node 22.23.2): the baseline tag `baseline/im-session-2026-11-18` (53bd3d04) in a temporary worktree (`pnpm install --frozen-lockfile`, `pnpm -r run build`, removed afterwards) and HEAD of `design/im-session-service`, the same commands in sequence with nothing else running. Test counts come from each run's Vitest summary; slow tests from a JSON reporter on every package; static counts from `vitest list --json` by file suffix and `playwright test --list`.

**Noise.** The HEAD per-change selections ran three times: every command within 0.5 s of its median (under 5 percent). The baseline Workbench selection ran twice: 108.4 s and 106.3 s (2 percent); the Cloudflare package took 215.7 s in both baseline runs. The baseline selections fail 9 or 10 tests in every run (the Workbench suite, and one `test:preview-browser` test); HEAD fails none.

### 11.1 Per-change test scope

Baseline: what `verify:changed` selects, the changed package and every dependent (tests only; its build and typecheck come on top). HEAD: `pnpm test:unit` of the module's files plus the seam suites section 5.9 names for it (median of three).

| Change | Baseline home, selection | Tests | Wall | HEAD module, selection | Tests | Wall | Change |
|---|---|---:|---:|---|---:|---:|---|
| Journal window rule | relay `journal-session-stream.ts`: hosted, Cloudflare, Controller, Workbench, debugger | 6,009 | 431 s | `window-decision` and its vector consumers (journal, Controller contract, client absorb); S2, S4 | 230 | 8.0 s | 26 times fewer tests, 54 times faster |
| Session-control rule | hosted `control.ts`: same | 6,009 | 431 s | `domain/session-control`, `stream-control`, `lease-view`; S3 | 215 | 12.4 s | 28x, 35x |
| Succession rule | Workbench `useSessionSuccession.ts`: Workbench, debugger | 2,994 | 108 s | `agent-client/src/succession`, the two hook test files; S3, S6 | 368 | 13.5 s | 8x, 8x |
| Workbench state rule | Workbench `App.tsx`: same | 2,994 | 108 s | `state/draft-ownership`; S6 | 13 | 3.1 s | 230x, 35x |
| Controller session-core rule | Controller `host.ts`: Controller, Workbench, debugger | 4,789 | 209 s | `session-core/`; S1, S2 | 244 | 6.2 s | 20x, 34x |
| Relay host-session rule | hosted `broker.ts`: as the first row | 6,009 | 431 s | `host-session`, `broker-heartbeat`; S2, S3, S4 | 281 | 11.9 s | 21x, 36x |
| Renderer component | web `react/AgentTimeline`: web, Workbench, debugger | 3,950 | 145 s | client-web `AgentTimeline*`; S6 | 95 | 4.8 s | 42x, 30x |
| Protocol schema | protocol: every package but the providers and the tunnel | 8,143 | 468 s | protocol, fixtures, S2, S3, `fixtures:check` | 704 | 14.4 s | 12x, 33x |

Against the target of 5.10 (2 to 10 s, worst 40 s): no change over 15 s, four under 10 s. The S3 seam suite is 10 s of every selection that includes it (four of eight); it is the next file to make faster.

### 11.2 Total test time

| Run | Baseline | HEAD | Change |
|---|---|---|---|
| `pnpm test` (every package's suite, serially; the Cloudflare package included) | 516.6 s, 9,610 tests, 9 failed | 315.4 s, 11,362 tests, 0 failed | -39 percent, +1,752 tests |
| `pnpm test` with slow-test enforcement (gate) | n/a | 339.1 s, 11,362 tests (22 skipped), 0 failed; the reporter counted 336 over 300 ms and 16 over 1 s (11 allowlisted, 5 passed their re-measurement alone) | |
| Workbench package | 86.3 s, 2,853 tests (9 failed) | 67.6 s, 3,281 tests | -22 percent |
| Controller package | 75.1 s, 1,795 | 58.6 s, 1,980 | -22 percent |
| Cloudflare (`test:cloudflare`) | 215.7 s, 239 | 48.3 s, 155 (31 in `workerd`) | |
| `test:preview-browser` | 137.2 s, 73 (1 failed) | 141.8 s, 73, 1 failed (the same WebKit `session-recovery` test as at the baseline; it fails alone too) | |
| `test:conformance` | 3.1 s, 31 | 6.4 s, 31 | |
| E2E flows (`test:e2e:flows`) | none | 73.9 s, 31, 1 failed (E3 replacement; see O40) | |
| Playwright e2e (`test:e2e`; at the baseline the Workbench's 93 files) | stopped at its 480 s global deadline after 266 of 1,330 runs: 187 passed, 24 failed, 55 skipped, 1,064 did not run | 540.3 s (9.0 min), 283 passed, 67 skipped, 0 failed | the baseline never finished |
| Workbench e2e (`test:e2e:lab`) | (part of the row above) | 527.4 s (8.8 min), 250 passed, 20 skipped, 0 failed | |
| Component tier (`test:components`) | none | 483.2 s (8.0 min), 459 passed, 70 skipped, 1 failed (`session-view-responsive` in the loaded run; 3 of 3 reruns pass) | |
| `smoke:quick` | none (no harness) | 359.4 s, seed 9201: M1, M2, M4 and M7 passed (M1 first rows on revisit 100 ms Claude and 109 ms Codex at 300 ms and 2 percent loss) | |
| The full gate, summed | not completable (the e2e deadline) | 2,556 s (42.6 min) with 3 single failures, each triaged in 11.8 | |

### 11.3 Test counts per tier

Static counts. Vitest tests by file suffix; at the baseline no suffix tiers existed, so its "unit" holds the process and real-socket tests that M0 counted (about 141 process, about 1,500 real-stack).

| Tier | Baseline | HEAD |
|---|---:|---:|
| Unit (Vitest, mock data) | 9,289 | 10,624 |
| Contract and seams (`*.contract`, `*.integration`, seams package) | 9 | 425 |
| Transport (real socket) | 51 | 31 |
| Process | 0 (in unit) | 33 |
| Workers (`workerd`) | 239 (the whole Cloudflare package) | 31 workers and 124 Cloudflare tests in Node |
| Component (jsdom preview tier) | 73 | 73 |
| Component (Playwright, distinct tests) | 0 | 187 (530 runs over 8 projects, 44 files) |
| E2E flows | 0 | 31 |
| E2E specs (Playwright, distinct) | 498 (1,330 runs, 93 files) | 273: `agent-e2e/specs` 183 (350 runs, 38 files), Workbench 90 (270 runs, 14 files) |
| Smoke scenarios | 0 | 7 (M1, M2, M3, M4, M5, M7, M8; M6 deferred), 4 in `smoke:quick`; 72 harness unit tests |
| Local/native | 134 | 114 |

### 11.4 Slow tests

Measured in the same full serial runs (each package's Vitest with all its workers), counting the mock-data tiers only (process, transport, workers and local excluded).

| Package (baseline name to HEAD name) | Over 300 ms | Over 1 s |
|---|---|---|
| Controller | 225 to 165 | 50 to 25 |
| Workbench | 171 to 152 | 37 to 8 |
| Cloudflare | 150 to 3 | 31 to 3 |
| Copilot provider | 30 to 30 | 7 to 8 |
| hosted to relay-core | 27 to 7 | 4 to 0 |
| web to client and client-web | 20 to 2 | 8 to 0 |
| relay to session-runtime | 16 to 4 | 3 to 0 |
| debugger | 11 to 2 | 4 to 0 |
| journal | 2 to 2 | 2 to 2 |
| others | 14 to 48 (Node Relay 29, seams 12) | 6 to 2 |
| **All** | **666 to 415** (7.0 to 3.7 percent) | **152 to 48** |

The slow-test reporter, which re-measures a test over 1 s alone before failing, passed the gate run (0 failures; 16 over 1 s by its own count, 11 of them allowlisted). Allowlist: none at the baseline (no reporter; M0 counted 119 over 1 s), 71 at its peak, 11 now.

### 11.5 Module sizes and architecture

| Measure | Baseline | HEAD |
|---|---:|---:|
| `broker.ts` | 2,737 | 423 |
| `host.ts` | 1,807 | 551 |
| `App.tsx` | 3,765 | 90 |
| `replica/reducer.ts` | 725 | 5 (a re-export of four modules) |
| `gateway.ts` | 1,222 | 1,228 |
| `useSessionSuccession.ts` | 1,152 | 1,072 |
| Source files over 800 lines (tests, fixtures and `dist` excluded) | 13 | 10 |
| Source files over 1,000 lines | 9 | 6 |
| Upward (`layer`) imports | 86 | 2 |
| Cross-package relative imports | 225 | 10 |
| `dist` imports | 36 | 8 |
| Adapter imports adapter | 13 | 0 |
| Controller knows Relay (rule added in M2) | not checked | 2 |
| Documented exceptions; failing findings | none (report only); 360 | 22; 0 (blocking) |
| Inline wire messages in tests | 3,877 in 415 files | 3,687 in 435 files |

The baseline architecture counts are the M0 rules (`scripts/arch-check.mjs` and `architecture/modules.json` of 7ddd94f8) run on the baseline tree; HEAD runs its own, stricter rules. The files still over 1,000 lines: Codex `session.ts` (1,874, unchanged), `gateway.ts`, the session runtime's `agent-manager.ts` (1,124), `useSessionSuccession.ts`, the client's `remote-session-client.ts` (1,066) and the performance baseline script (1,011).

### 11.6 Product defects found and fixed during the restructuring

14, each found by a smoke run, an e2e or component run, or a package test, and pinned at the lowest tier that holds it.

| # | Defect | Found by | Pin |
|---|---|---|---|
| 1 | First paint waited for the Relay's lease: 3.3 s at 300 ms, 16 s at 1,500 ms round trip | smoke M1 (M4) | S7 'a restored record paints before any frame arrives', client `display-lease.test.ts`, E3 reload flow (fixed in M8; 80 to 114 ms now) |
| 2 | A Controller restart moved the reader to the first row on the legacy read path (row keys carried the journal epoch); also at the baseline | E3 flow (O24) | `timeline-entry-key.test.ts`, the reducer's unkeyed replacement test, E3 with smart reading off |
| 3 | One failed fetch of the code-split `App` chunk left the page blank for good | smoke M1 full profile (O27) | `chunk-recovery` 5 unit tests (3 mutations), E3 flow |
| 4 | 'Session composition needs synchronization (retired)' with no rows when a local edit overtook an application | e2e (O28) | 13 `reduceRefresh` tests (3 mutations), the un-skipped spec |
| 5 | On a phone the floating controls covered the header controls | e2e phone project (O30) | unit tests, component spec `floating-controls-clearance` |
| 6 | iOS with a hardware keyboard: Shift+Enter sent the draft | component tier on WebKit (O31) | 2 `ComposerEditor` unit tests (3 mutations), the WebKit component test |
| 7 | A full-screen Ask or TPM window had its controls under the floating column | phone project (O32) | 2 `useTrackingPosition` unit tests |
| 8 | The Interrupt button was 30 px high under a coarse pointer | phone project (O32) | component spec `touch-targets` |
| 9 | The folder picker returned focus to nothing in Safari | WebKit project (O32) | `WorkspaceFolderPicker` unit test |
| 10 | With the keyboard open (340 px visible), the floating Window control covered 'Hide message input' | phone project (O34) | 3 `useTrackingPosition` unit tests, both `mobile.spec` variants |
| 11 | After a quota refusal the publisher re-sent the identical window on every backoff (5 sends of about 4 MB in 13 s) | smoke M4 (O36) | 5 publisher tests, S2 transcript `quota-refuses-window`, M4 invariant `refused-window-not-resent` |
| 12 | The public `agent-session-runtime` depended on the private `agent-timeline`, so the published packages could not be installed | the installed-package test (O39) | `scripts/agent-remote-debugger-package.test.mjs` |
| 13 | The debugger's exports map (O19) hid `dist/server.js` and `dist/local-session-succession.js` from published consumers, and named two testing entries the package does not ship | the installed-package test, `pnpm pack` (O39) | the same test; `publishConfig.exports` |
| 14 | A reader on a session the Controller served went to the first row when its journal started serving it (every row key changes from the fallback key to the item key); also at the baseline | e2e flows (O40) | 3 `useTimelineScroll` unit tests, the E3 O24 flow with smart reading turned on |

Not counted: O22 and O26 (stack and harness faults), O29 and O33 (not defects), O38 (no leak).

### 11.7 Against section 7

Met: per-change scope (every measured change under 15 s, a rule change never selects another layer's package); module sizes (roots under 900, `App.tsx` 90); layer violations blocking with 22 documented exceptions; every smoke finding has its pin. Short: tests over 300 ms are 3.7 percent, not under 1 percent, and 48 are over 1 s in a full parallel run (the reporter's re-measurement passes them all but the allowlisted 11); the unit count grew instead of shrinking (new tables and hook tests outnumber the deletions); inline wire literals in tests are 3,687, not zero; six source files are still over 1,000 lines.

### 11.8 The end gate

HEAD after the final slice (24c9ca76 for the tests, the instance built from it): `pnpm test` with enforcement exit 0 (11,362 tests, 22 skipped); `test:conformance` 31; `test:cloudflare` 155; `test:e2e` 283 passed, 67 skipped; `test:e2e:lab` 250 passed, 20 skipped; `arch:check` 0 failing findings, 22 documented exceptions; `fixtures:check`; `typecheck`; `smoke:quick` seed 9201, 4 of 4; the installed debugger package test 1 of 1; `compatibility:update`, then `check`. Three single failures, each rerun:

- `test:preview-browser`, `session-recovery` on WebKit: WebKit logs an aborted `/v1/remote/hosts` fetch 'due to access control checks' during a page lifecycle. It fails the same at the baseline tag and fails alone now; it passed on reruns at the sweep gate. Not a regression; open as before.
- `test:components`, `session-view-responsive` on `chromium-desktop`: 'Open chat commands' not found within 5 s in the loaded run; 3 of 3 reruns pass (11 s each). A load flake.
- `test:e2e:flows`, E3 'the reader keeps their line when a Controller restart replaces the journal...': the reader's row moved 6,119 px (to the newest row) after the send that follows the restart. It failed in the gate and in 1 of 3 reruns, with the same number; no product source changed since the sweep gate, where it passed. Open as O40. Closed after the gate: a product defect, fixed and pinned (O40 in section 10).

**Gate after O40 and O41** (2026-11-19, HEAD d4ca75b4 plus this record): `pnpm test` with enforcement exit 0 (11,386 passed, 22 skipped, 330 s); `test:e2e:flows` 3 of 3 (31 each) after the 20-run streak; `test:e2e` 283 passed, 67 skipped, 0 failed (9.1 min); `smoke:quick` seed 7484, 4 of 4 (M1, M2, M4, M7) on the instance with journals; `arch:check` 0 failing findings, 22 documented exceptions; `compatibility:update`, then `check`.


## 12. Check after the Orchard steps (2026-11-21)

Steps I1 to I4 and J, the Orchard IM experience, changed the client a great deal. This section re-checks the completion criteria of this restructuring at HEAD `48e63edd`.

### Architecture

`pnpm arch:check` reports 0 failing findings and the same 22 documented exceptions: 2 `layer`, 8 `dist-import` and the rest as in 11.5.

The new modules follow the target shape: pure rules with vector tables, and thin React shells.

| Module | Rules |
|---|---|
| `agent-client/src/client/session-presentation` | notice, composer availability, activity label |
| `agent-client/src/presentation` | turns, process mode, work summary, assistant name, the message catalogue |
| `agent-client-web/src/theme` | tokens, contrast, avatar recipes, motion |
| Lab `destinations` and `settings/settings-groups` | rail destination and the Settings groups |

The source files over 1,000 lines are the same five as in 11.5; none is new.

### Per-change scope for the new modules

| Change | Tests | Time |
|---|---:|---:|
| Session presentation rule (`session-presentation.test.ts`) | 35 | 1.5 s |
| Turns, process mode and assistant name | 99 | 1.2 s |
| Navigation destinations and Settings groups | 35 | 1.7 s |
| All of `agent-client` | 824 | 2.6 s |
| All of `agent-client-web` | 910 | 11 s |
| The seam suites (`agent-remote-seams`) | 406 | 10 s |

### Totals and slow tests

- **`pnpm verify`** (I4 gate, `.tmp/i4/full2-verify.log`) passed 12,318 tests, failed 0 and skipped 22. After O44 and O45 it passed 12,329 and exited 0.
- **Mock-data tiers.** Of 10,187 tests:
  - 247 run over 300 ms, which is 2.4 percent (3.7 percent at the 11.4 measurement);
  - 15 run over 1 s. Each is either on the allowlist (still 11 entries, each with its reason) or re-measured under 1 s alone.
- **The enforced reporter** passed.

### E2E and smoke

- **E2E flows: 43 tests.** They cover the main flows E1 to E11, plus the cases that local runs found. New flows:
  - E9: quiet open, including a 2 s Relay delay;
  - E10: the assistant conversation;
  - E11: navigation and Settings.
- **`smoke:quick`** (journals on, seed 68421, HEAD `315a88cf`): M1, M2, M4 and M7 pass, and every invariant is exercised.
- **M6 runs, and a full run** (2026-11-21, journals on, HEAD `da5717f7`, seed 70621, 4 h 26 min): M3, M4, M5, M7 and M8 pass. M1 and M2 failed on harness defects, now fixed (O51, O52; M1 re-run passed). M6 (79 min at 50 rounds per provider) passed every check inside our system (two pages, 10 rounds per provider: 240 sends taken, none lost or doubled, the native state and settings on both pages) and for a Codex terminal through the shared daemon (its turns on the page within a second); it failed for a Claude terminal (O49, all 50 rounds) and for a separate Codex process (O48). Since then M6 runs 5 rounds per provider: the orderings are enumerated at the seams instead, and the session path's components state their clauses (O53).
- **What the smoke run found before it passed:**
  - **The harness assumed a single primary conversation** (fixed). With several primary groups in a Window it read another session's pane, so its earlier passes of M1 and M4 had checked the wrong session. Now:
    - every conversation carries `data-native-session`;
    - the harness reads only the session it opened;
    - the component test `smoke-probe.spec.ts` checks the harness's own `PageProbe` against a fixture with two primary groups and a dock, in the per-step gate.
  - **O44, a product defect, fixed and pinned.** At a 300 ms round trip, a message typed during the stand-in-to-Window handoff was held as "could not be opened" and never sent. It is pinned by `SessionConversation.opening`, `AgentComposer.pending` and an E9 flow with a delayed Relay.
  - **O45, a harness gap, fixed.** The default Concise mode hid tool rows, so the mid-turn checks did not run.

### Lesson for the process

Each Orchard step ran the unit, component and e2e tiers, but not the smoke tier. A layout change broke the smoke harness unnoticed, and a latency-only defect reached production.

The smoke selectors are now checked in the per-step gate. `smoke:quick` runs before each release that changes the client or the Relay, as section 5.7 intended.
