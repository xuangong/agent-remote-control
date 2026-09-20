# Lab — Standalone Protocol Validation Site

## Role

`agent-remote-lab` is a private Vite site whose production launcher operates the deterministic Recorded Provider and routes native Providers from paired Agent Hosts. Test-only compositions inspect the real Codex app-server against deterministic Responses and controlled live DSH through the Relay public API and reusable Web package (`packages/agent-remote-lab/src/server/local.ts`, `packages/agent-remote-lab/scripts/codex-host-fixture.ts`, `packages/agent-remote-lab/src/server/live-plugin.ts`).

## Boundary

The package owns the standalone site shell, generic Node Relay composition, declared-scope compatibility identity and Provider-matrix validation, and validation-only Recorded/Codex/live-DSH assembly. Provider packages retain native projection and runtime ownership; the caller retains the compatible DSH installation or checkout and credentials (`packages/agent-remote-lab/src/server.ts:6-23`, `packages/agent-remote-lab/src/server/compatibility.ts:122-247`, `packages/agent-remote-lab/src/server/installed-dsh-plugin.ts:16`).



## Collaborators

| Module | Direction | Responsibility |
| --- | --- | --- |
| Relay public API | Lab → Relay | Composes the standalone HTTP/WebSocket server without Relay internals (`packages/agent-remote-lab/src/server.ts:1-23`). |
| Web package | Web → Lab | Supplies HTTP/WebSocket transport, replica, session client, and public Timeline (`packages/agent-remote-lab/src/App.tsx:69-125`). |
| Injected Provider adapters | Provider adapter → Lab | Supplies only explicitly configured validation Providers (`packages/agent-remote-lab/src/server.ts:6-15`). |
| Recorded Provider | Lab → Recorded Provider | Supplies deterministic Timeline, interaction, replacement, and resource scenarios (`packages/agent-remote-lab/src/server/recorded.ts:37-123`). |
| Codex Agent Host fixture | Test harness → Agent Host | Runs the real app-server against deterministic local Responses in a process separate from the Lab backend and identifies the fixture in the Host catalog (`packages/agent-remote-lab/scripts/codex-host-fixture.ts`, `packages/agent-remote-lab/src/server/codex.ts`). |
| DSH source checkout | Live launcher → DSH | Loads the compiled validation plugin through a caller-supplied compatible runtime (`packages/agent-remote-lab/scripts/run-live-dsh.sh:76-205`). |
| DSH Web profile | Profile bundle → DSH | Loads the packaged validation adapter into the existing native Web host and shares its services (`packages/agent-remote-lab/src/server/installed-dsh-plugin.ts:9`, `packages/agent-remote-lab/scripts/build-dsh-plugin.ts:57`). |

## Internal Architecture

```mermaid
flowchart LR
  manifest["Compatibility manifest"] --> live["Controlled live DSH and Codex composition"]
  injection["Injected Provider registry"] --> server["Node Relay composition"]
  recorded["Recorded semantic Provider"] --> server
  checkout["Caller-supplied DSH checkout"] --> live["Controlled live DSH and Codex composition"]
  bundle["Installed Lab profile bundle"] --> live
  live --> server
  server --> proxy["Vite relay proxy"]
  proxy --> transport["Web transport and replica"]
  transport --> shell["Validation site shell"]
  shell --> context["Context supporting rail"]
  shell --> workbench["Workbench primary surface"]
  shell --> trace["Normalized Timeline trace"]
  shell --> inspector["Replica Inspector supporting rail"]
  recorded --> comparison["Shared recorded conformance runtime"]
  comparison --> reference["Node reference transport"]
  comparison --> uplink["Outbound plugin transport"]
  uplink --> broker["Standalone Node broker"]
  broker --> suite
  reference --> suite["Production Web client conformance suite"]
```

The shell keeps Workbench mounted because its Timeline, composer, and interaction state are the primary work surface. Context and the initially collapsed Replica Inspector are supporting rails, while Trace is a separate normalized projection over the same replica (`packages/agent-remote-lab/src/App.tsx:117-136`, `packages/agent-remote-lab/src/App.tsx:271-406`, `packages/agent-remote-lab/src/components/LabWorkbench.tsx:20-85`, `packages/agent-remote-lab/src/components/SupportingRail.tsx:31-89`).

The Lab supplies its conversation layout and callback wiring; shared Web components own command drafts, planning controls, scroll anchoring, and semantic Timeline rendering (`packages/agent-remote-lab/src/components/LabWorkbench.tsx:20-82`, `packages/agent-remote-web/src/react/useTimelineScroll.ts:5`, `packages/agent-remote-web/src/react/AgentComposer.tsx:21`).

The desktop main stage places Conversation and an opened local preview in equally sized, independently interactive panes, separated by a draggable divider. Minimizing the preview restores the full conversation width; restoring it retains the chosen split. The preview address bar shows the local target and mapped URL. Desktop Host previews list active registrations only. The app header and desktop Context rail can be hidden independently. A View menu stays at the top-left on desktop and top-right in compact layouts and contains Header, Sidebar, and Replica Inspector visibility checkboxes. Show all selects every panel on desktop; Hide all clears the panel selection in any layout. Compact layouts open one supporting drawer at a time. Desktop headings reserve its space without adding a toolbar row. Drafts and the active view remain mounted. Compact supporting rails keep their focus-managed dialog behavior and return focus to the Sessions or View control that opened them. The document tracks pointer and keyboard input: pointer-driven controls and restored focus do not show an outline, while keyboard navigation retains visible focus indicators across controls, panels, and preview dialogs.

The conversation header shares one row with its parent path and a collapsed Sessions popover. Connection identifiers and reconnect live in the app-bar disclosure. The composer contains its message field and a single wrapping toolbar; model and permission settings open above it, while detailed status and planning appear under Status. Working time and interrupt remain visible during active operations. Popovers do not resize the Timeline (`packages/agent-remote-lab/src/components/LabWorkbench.tsx`, `packages/agent-remote-lab/src/components/ChatSessionManager.tsx`, `packages/agent-remote-lab/src/app.css`).

Conversation styling gives adjacent tool, reasoning, and compaction entries compact spacing while preserving message and interaction-card reading space. The shared disclosures retain keyboard controls, and coarse-pointer layouts retain larger touch targets (`packages/agent-remote-lab/src/app.css:410-449`, `packages/agent-remote-lab/src/app.css:582-598`).

## Key Flows

```mermaid
flowchart LR
  catalog["Load Provider catalog"] --> select["Select registered Provider"]
  catalog --> empty["Show empty catalog"]
  catalog --> catalogFailure["Show catalog failure"]
  catalogFailure --> retry["Retry Provider catalog"]
  retry --> catalog
  select --> create["Open relay session"]
  persistence["Active persistence handle"] --> resume["Resume relay session"]
  create --> connecting["Show Agent connecting"]
  resume --> connecting
  connecting --> synchronizing["Show Timeline synchronizing"]
  synchronizing --> ready["Show ready Timeline and composer"]
  synchronizing --> reconnecting["Show Timeline reconnecting"]
  reconnecting --> synchronizing
  connecting --> failed["Show Agent failure and diagnostics"]
  synchronizing --> failed
  ready --> interaction["Respond through typed Relay interaction"]
  interaction --> failed
```

## Invariants

- Provider catalog loading, an empty catalog, and a failed catalog request remain visibly distinct; retry reloads the catalog, while session creation requires a selected registered Provider and resume requires an active persistence handle (`packages/agent-remote-lab/src/App.tsx:97-115`, `packages/agent-remote-lab/src/components/ProviderSessionControls.tsx:19-35`).
- The Node composition accepts a Provider array once, then constructs one Relay and one public HTTP/WebSocket server (`packages/agent-remote-lab/src/server.ts:6-23`).
- Conformance mutations execute once against one runtime; both public routes retain identical Agent identity, epochs, sequence ranges, timestamps, and resource bindings. Recovery comparisons use matching browser lifecycles, with a continuously connected observer checking content continuity (`packages/agent-remote-lab/src/server/relay-conformance.test.ts:45`, `packages/agent-remote-lab/src/server/relay-conformance.test.ts:124`).
- Capabilities determine whether controls are available; the compatibility manifest states the exact DSH and Codex degradations used by the live composition. Known DSH plugin, skill-catalog, and agent-instructions context is consumed, unknown injected sources become visible Timeline errors, and Codex metadata or command side-channel events remain without a public state carrier (`packages/agent-remote-lab/compatibility.json:28-94`, `packages/agent-provider-dsh/src/projector.ts:138-147`, `packages/agent-provider-codex/src/projector.ts:24-43`).
- Compatibility validation requires the exact Provider/degradation set and a matching SHA-256 identity for the declared scope. Sorted file paths and exact bytes include root workspace, package, and lockfile metadata; packaging-only or version-only changes in that scope require revalidation before live composition even when Agent Remote runtime code is unchanged (`packages/agent-remote-lab/compatibility.json:11-35`, `packages/agent-remote-lab/src/server/compatibility.ts:7-25`, `packages/agent-remote-lab/src/server/compatibility.ts:158-247`).
- Recorded-only scenario controls are same-origin POST seams; ordinary session work remains on public Relay routes (`packages/agent-remote-lab/src/server/recorded.ts:322-356`).
- Workbench and Trace are presentation modes over one replica, but only Workbench carries the primary Timeline, draft, and pending interaction surface; changing modes or opening a supporting rail cannot replace that state (`packages/agent-remote-lab/src/App.tsx:117-136`, `packages/agent-remote-lab/src/App.tsx:223-247`, `packages/agent-remote-lab/src/App.tsx:367-390`, `packages/agent-remote-lab/src/components/LabWorkbench.tsx:20-85`).
- Conversation scrolling follows growth until explicit upward navigation, scrollbar movement, focus navigation to an earlier control, or history loading pauses it; browser-driven position changes preserve following. Reading mode keeps the visible entry and offset through history prepends and layout changes. Hidden Workbench updates preserve reading intent, while Agent or epoch replacement resumes latest following (`packages/agent-remote-web/src/react/useTimelineScroll.ts:5`, `packages/agent-remote-lab/src/components/LabWorkbench.tsx:20-21`, `packages/agent-remote-lab/src/App.tsx:370-380`).
- Session creation may explicitly request planning without inferring support from Provider identity; creation rejection remains visible and does not attach a substitute ordinary session (`packages/agent-remote-lab/src/App.tsx:198`, `packages/agent-remote-lab/src/components/ProviderSessionControls.tsx:29`).
- Planning changes require a connected idle Agent with no active turn or pending interaction and a declared capability. The displayed mode follows Provider runtime state, while a command acknowledgement alone leaves the control waiting for confirmation (`packages/agent-remote-web/src/react/AgentPlanningControl.tsx:11`).
- Question drafts belong to the Lab session and request, outside the shared question card. Switching inspection views or remounting a card retains the stable-ID answer map; resolved request and response history belongs to the Relay Timeline rather than local form state (`packages/agent-remote-lab/src/App.tsx:87`, `packages/agent-remote-lab/src/App.tsx:387`, `packages/agent-remote-web/src/react/items/InteractionItem.tsx:9`).
- Composer drafts and pending commands belong to an Agent; successful immediate-send or native-queue confirmation clears only the submitted draft, rejection preserves it, and cancel leaves it intact. A completion for another Agent cannot redirect focus or replace the current draft (`packages/agent-remote-web/src/react/AgentComposer.tsx:21`).
- Lab controls await the shared client's correlated completion before reporting success, retain pending interactions/resources until Replica state changes, and present rejected confirmations as failures. Enter submission excludes newlines and active input-method composition (`packages/agent-remote-lab/src/App.tsx:253-264`, `packages/agent-remote-web/src/react/AgentComposer.tsx:21`, `packages/agent-remote-web/src/react/InteractionPanel.tsx:16-30`, `packages/agent-remote-web/src/react/ResourceList.tsx:17-37`).
- Public diagnostics and normalized Timeline projection remain distinct from Provider-native and raw-wire data (`packages/agent-remote-lab/src/components/TraceView.tsx:4-28`, `packages/agent-remote-lab/src/components/ReplicaInspector.tsx:17-50`).
- Trace groups loaded events by their recorded turn and filters their normalized content and type. Selecting a row opens input, result, source sequences, merge reasons, resource bindings, and optional normalized JSON. Tool duration, exit code, and truncation are shown only when recorded; source ranges do not reconstruct intermediate payloads. Desktop presents a list and detail pane, while narrow containers show one at a time (`packages/agent-remote-lab/src/components/TraceView.tsx`, `packages/agent-remote-lab/src/components/TraceEntryDetails.tsx`, `packages/agent-remote-lab/src/trace.css`).
- Timeline Trace shortcuts are hidden in the compact shell (viewport width at most 1180px), including keyboard and accessibility navigation. Desktop retains the per-entry shortcut; the Trace tab remains available on both layouts (`packages/agent-remote-lab/src/trace.css`).
- Conversation inspection and Trace return navigation use the shared render-model entry key, scoped by Agent ID and epoch. Tool lifecycle growth does not change that key. Navigation requests are consumed once; ordinary view switches preserve filters and reading positions. Session or epoch changes clear inspection requests, including when revisiting a previous session; an event removed from the loaded timeline produces an unavailable-selection notice. Returning to Conversation reveals and anchors the entry without replacing its mounted composer or interaction drafts, expanding the primary window when side sessions are open (`packages/agent-remote-lab/src/App.tsx`, `packages/agent-remote-lab/src/components/LabWorkbench.tsx`).
- Trace's Agent waits panel lists recorded running `agent.wait` tools in the selected session. Explicit normalized session references use the existing authorized family navigation; unavailable targets remain text. A wait is presented as current only with a ready connection and a matching active turn; otherwise it is labeled as last observed. Completed waits remain inspectable as events but leave the wait panel. This view does not subscribe to every descendant, infer wait targets, or reconstruct a distributed execution graph (`packages/agent-remote-lab/src/components/TraceView.tsx`, `packages/agent-remote-lab/src/components/TraceSessionLinks.tsx`).
- On compact layouts, Context and Replica Inspector are focus-contained sheets with internal close controls, Escape dismissal, and focus return to their triggering control; scenario-command feedback remains in the active supporting rail, and conversation-command feedback stays in the composer (`packages/agent-remote-lab/src/App.tsx:171-185`, `packages/agent-remote-lab/src/App.tsx:316-365`, `packages/agent-remote-lab/src/components/SupportingRail.tsx:31-90`, `packages/agent-remote-lab/src/components/RecordedPlaybackControls.tsx:9-26`, `packages/agent-remote-web/src/react/AgentComposer.tsx:21`).
- Ordinary standalone DSH creation leaves native plan state untouched. Setting `BORGEE_LIVE_DSH_PLAN_MODE=1` selects the standalone plan-approval fixture and seeds planning only for new sessions, while resume preserves the stored state; the browser approval suite selects that fixture at launch (`packages/agent-remote-lab/src/server/live-plugin.ts:50-86`, `packages/agent-remote-lab/src/server/live-plugin.ts:141-149`, `packages/agent-remote-lab/playwright.config.ts:5-10`).
- `AGENT_REMOTE_DSH_DELIVERY_FIXTURE=1` launches a headless DSH process with a temporary home, a controlled LLM adapter, no initial plan mode, and no Codex fixture. Browser delivery tests inspect native Inbox and turn events to distinguish same-turn steering from queued follow-up consumption and verify interruption. This path requires only the common Agent services; the installed shared-Web plugin separately declares its Web service dependencies (`packages/agent-remote-lab/scripts/dsh-delivery-fixture.mjs:1`, `packages/agent-remote-lab/e2e/dsh-delivery.spec.ts:1`, `packages/agent-remote-lab/src/server/installed-dsh-plugin.ts:9`).
- The live plugin supports `runtimeMode: shared-web` through the host's native model and preset services. Agent setup installs the host's default model selection before mounting the native preset; resume restores the latest recorded preset before the Relay receives that session (`packages/agent-remote-lab/src/server/live-plugin.ts:56-63`, `packages/agent-remote-dsh/src/shared-web-session.ts:20-42`).
- Shared Web mode uses DSH's native model selection and rejects explicit Lab model or reasoning-effort overrides. A successful native request header updates the public runtime model through its safe model field; clicking the Web selector alone does not refresh the Lab runtime model (`packages/agent-remote-lab/src/server/live-plugin.ts:58-61`, `packages/agent-remote-lab/src/server/live-plugin.ts:120-125`, `packages/agent-provider-dsh/src/projector.ts:113-126`).
- Shared Web interactions use the host's native interaction services so either client can answer the same pending request. The plugin creates the shared adapter before its Provider and releases Relay sessions before disposing the adapter (`packages/agent-remote-lab/src/server/live-plugin.ts:42`, `packages/agent-remote-lab/src/server/live-plugin.ts:46-57`, `packages/agent-provider-dsh/src/web-interactions.ts:57-65`).
- Live Lab instances select loopback-only Relay and Web ports with `BORGEE_LIVE_DSH_RELAY_PORT` and `BORGEE_LIVE_DSH_WEB_PORT`, defaulting to `5910` and `6175`. The configured Web origin is shared by Relay authorization and fixture controls (`packages/agent-remote-lab/src/server/live-plugin.ts:48-49`, `packages/agent-remote-lab/src/server/live-plugin.ts:201-229`, `packages/agent-remote-lab/src/server/live-plugin.ts:244-253`).
- The live launcher requires an explicit absolute DSH checkout, validates its pinned version/revision before pnpm or Cordis startup, inherits credentials without inspecting them, and confines plugin output plus session persistence to launcher-owned temporary directories (`packages/agent-remote-lab/scripts/run-live-dsh.sh:65-117`, `packages/agent-remote-lab/scripts/run-live-dsh.sh:127-205`).
- The installable Lab profile bundle inlines Borgee adapters and Relay code while leaving native DSH packages as host-supplied peers. Its embedded compatibility manifest verifies the packed artifact independently of the source checkout, and activation rejects mismatched native Agent, LLM, or Session versions (`packages/agent-remote-lab/scripts/build-dsh-plugin.ts:18`, `packages/agent-remote-lab/src/server/installed-dsh-plugin.ts:27`).
- The packaged adapter joins the native Web host in shared mode and registers DSH without requiring the optional Codex fixture; standalone live validation retains its explicit Codex executable requirement (`packages/agent-remote-lab/src/server/installed-dsh-plugin.ts:23`, `packages/agent-remote-lab/src/server/live-plugin.ts:47`).
- Release preparation resolves the published native dependency and peer graph into one exact-version npm override set, keeping compatible installation independent of a DSH source checkout (`packages/agent-remote-lab/scripts/prepare-dsh-release.ts:28`).

## Non-Goals

- The Lab composes validation adapters but does not own DSH/Codex projection, native protocol semantics, native credential configuration, or durable account storage (`packages/agent-remote-lab/src/server.ts:1-23`, `packages/agent-remote-lab/src/server/live-plugin.ts:74-96`).
- The live composition does not discover credentials, promise deterministic model output, or claim a complete Provider control plane (`packages/agent-remote-lab/scripts/run-live-dsh.sh:65-117`, `packages/agent-remote-lab/compatibility.json:28-94`).
- The live composition does not replace the recorded browser specifications as the repeatable validation gate (`packages/agent-remote-lab/e2e/recorded.spec.ts:4-62`, `packages/agent-remote-lab/e2e/live-dsh.spec.ts:14-77`).
- The Lab does not report unsupported controls as successful operations (`packages/agent-remote-web/src/react/AgentComposer.tsx:21`).
- The Lab does not replace the Relay protocol decoder, headless reducer, or React DOM renderer (`packages/agent-remote-lab/src/components/LabWorkbench.tsx:1-9`, `packages/agent-remote-lab/src/components/LabWorkbench.tsx:52-62`).

## See also

- [Agent Remote](README.md) — package boundary and documentation map.
- [Providers](providers.md) — native adapters whose capabilities bound Lab controls.
- [Protocol](protocol.md) — strict public messages inspected by the Lab.
- [Relay](relay.md) — remote session owner composed by the Node entry.
- [Web](web.md) — recoverable client and shared renderer used by the shell.

## Implementation Anchors

- `packages/agent-remote-lab/src/server.ts:6-23`
- `packages/agent-remote-lab/src/server/recorded.ts:315-369`
- `packages/agent-remote-lab/src/server/standalone-conformance.test.ts:8`
- `packages/agent-remote-lab/src/server/remote-host-broker.test.ts:73`
- `packages/agent-remote-lab/scripts/run-relay-conformance.mjs:10`
- `packages/agent-remote-lab/src/server/codex.ts:30-72`
- `packages/agent-remote-lab/src/server/live-plugin.ts:19-199`
- `packages/agent-remote-lab/src/server/compatibility.ts:7-247`
- `packages/agent-remote-lab/scripts/run-live-dsh.sh:65-205`
- `packages/agent-remote-lab/scripts/build-dsh-plugin.ts:18`
- `packages/agent-remote-lab/scripts/prepare-dsh-release.ts:28`
- `packages/agent-remote-lab/src/server/installed-dsh-plugin.ts:16`
- `packages/agent-remote-lab/src/App.tsx:70-406`
- `packages/agent-remote-lab/src/components/LabWorkbench.tsx:20-85`
- `packages/agent-remote-web/src/react/AgentComposer.tsx:21`
- `packages/agent-remote-web/src/react/AgentPlanningControl.tsx:11`
- `packages/agent-remote-web/src/react/useTimelineScroll.ts:5`
- `packages/agent-remote-lab/src/components/ReplicaInspector.tsx:3-61`
- `packages/agent-remote-lab/src/components/SupportingRail.tsx:31-105`
- `packages/agent-remote-lab/src/components/TraceView.tsx:4-54`
- `packages/agent-remote-lab/e2e/recorded.spec.ts:4-130`
- `packages/agent-remote-lab/e2e/modernization.spec.ts:8-190`
- `packages/agent-remote-lab/playwright.config.ts:5-40`

## Standalone Host Control

The Node broker owns temporary pairing keys, installation discovery, catalog forwarding, and opaque native-session bindings. Agent Host and DSH connect outbound through the shared Remote Host uplink; public Snapshot, Timeline, and browser streams retain their existing protocol (`packages/agent-remote-lab/src/server/remote-host-broker.ts`).

A reconnect advances the host connection generation and restores native bindings on demand before reading or streaming. Creation request identities remain in memory and uncertain creation outcomes are not replayed (`packages/agent-remote-lab/src/server/remote-host-broker.ts:118`).

The workbench presents host pairing, provider session discovery, workspace selection, creation, and connection alongside conversation and protocol inspection (`packages/agent-remote-lab/src/App.tsx:1`, `packages/agent-remote-lab/src/server/session-directory.ts:16`).

For directory-based Providers, New session offers a Browse dialog beside Workspace. It reads folders from the selected Controller, supports path entry, parent navigation, root/workspace shortcuts, filtering, hidden folders, and pages of 100 directories. Selecting a folder fills `cwd`; cancel leaves the draft unchanged. DSH keeps its registered-workspace selection. The native modal traps focus, restores it on close, and prevents Escape from closing the underlying mobile session panel. Requests are cancelled on navigation/close and have a 15-second client deadline (`WorkspaceFolderPicker.tsx`, `directory-client.ts`).

New folder opens a name field in the Browse dialog. Creation uses the currently loaded parent folder, enters the created directory, and leaves Select folder as the explicit workspace choice. Names cannot contain path separators, control characters, or surrounding whitespace. Existing directories, files, and symbolic links are reported as conflicts without modification. Navigation and dismissal are disabled during the bounded creation request. A 15-second timeout reports an unconfirmed outcome and offers a folder refresh; aborting the browser request does not undo a directory already created on the Controller.

`GET /v1/remote/hosts/<hostId>/workspace-folders` uses Relay authentication and is restricted to the Host owner. The uplink codec accepts `/remote/workspace-folders` only as a GET without a body or session target; this route must be supported by both Relay and Controller. The Controller resolves the requested path against its local allowed workspace roots, lists directory names without reading files, excludes symbolic links, and stops parent navigation at those roots. Session creation still validates the chosen working directory. Local Lab uses the same folder-listing helper on the local server (`packages/agent-host/src/workspace-folders.ts`, `packages/agent-remote-hosted/src/broker.ts`, `packages/agent-remote-protocol/src/remote-host-uplink.ts`).

`POST /v1/remote/hosts/<hostId>/workspace-folders/create` forwards `{ providerId, parentPath, name }` to `/remote/workspace-folders/create` with no session target. The owner-only route validates the selected Provider, and the Controller resolves the existing parent against the local workspace policy before a non-recursive directory creation. Success returns status 201 and the absolute path. Local Lab applies its existing loopback and same-origin mutation checks and calls the same helper. Browser acceptance covers real Host uplink folder creation followed by Agent creation with the selected `cwd`, using a deterministic Provider on desktop and mobile.


## Interaction acceptance fixture

The opt-in `AGENT_REMOTE_TEST_INTERACTIONS=1` Playwright mode launches a deterministic Provider for typed forms, permissions, external actions, policy approvals, and sensitive form answers. Desktop and mobile tests use the real HTTP/WebSocket workbench pipeline, verify history and reconnect, and save screenshots under the ignored package `.tmp/interaction-capabilities` directory. This is fixture-backed acceptance; native Codex mapping and real CLI transport have separate tests (`packages/agent-remote-lab/src/server/interactions.ts`, `packages/agent-remote-lab/e2e/interaction-capabilities.spec.ts`).


## Native child chat navigation

`POST /v1/remote/child/attach` accepts `providerId`, `parentNativeSessionId`, and `nativeSessionId`. The local directory requires an attached parent whose current Snapshot contains the requested direct child, then calls the source's optional `openChild` method. The Codex source delegates to its existing runtime. Concurrent attachment reuses one Remote Agent, and children remain excluded from the root catalog. Sources without native child attachment return an explicit unavailable response (`packages/agent-remote-lab/src/server/session-directory.ts`, `packages/agent-remote-lab/src/server/codex-directory.ts`).

Selecting a child preserves the parent's draft and opens the child's existing chat. Navigation releases no native runtime. Parent navigation remains available, and the normal composer uses the child's actual capability snapshot.

Opened sessions and Discover sessions render a shared hierarchy with groups collapsed by default keyed by Host, Provider, and native session identity. Catalog roots retain activity order; runtime-discovered children use creation order and stable discovery order for ties. Discovery includes known children before they are opened, without requesting another native runtime. Missing catalog pages or closed parent views retain ancestor rows. Closing an opened row removes only that view's directory entry.

The chat Sessions component starts collapsed and reveals the current session family when opened, including parent and sibling navigation, native status summaries, and saved-history availability. Relationship observations are retained while switching chats; only the active chat has a client subscription, so inactive family status reflects its last received observation until refreshed through the parent or child. Drafts and native control capabilities remain scoped to each chat. No additional Remote protocol fields or lifecycle actions are introduced (`packages/agent-remote-lab/src/session-tree.ts`, `packages/agent-remote-lab/src/hooks/useSessionEntries.ts`, `packages/agent-remote-lab/src/components/ChatSessionManager.tsx`).

The directory-backed Resume action reattaches the existing native session instead of creating a duplicate runtime. Child views disable generic Resume and retain the parent attachment path. Direct debugger-created sessions must first be opened through the directory before using its child attachment route.


The conversation layout keeps long session paths on one line and uses compact message spacing. The composer grows with its draft; narrow layouts keep command, setting and send controls in one row with touch-sized targets, while active turn status and Interrupt occupy a separate row. The header starts collapsed and can be expanded from the persistent View menu. In the compact layout, the Conversation heading row follows the same Header toggle without leaving an empty row; the desktop Conversation heading stays visible. Connection status remains readable in the expanded phone header. Session groups stay collapsed until explicitly expanded, including when their active child changes.

Compact workbenches track the browser's Visual Viewport height and offset so the composer and scrollable supporting drawers remain inside the keyboard-visible area. Pinch zoom preserves the existing layout dimensions. Composer growth and popup height are bounded by available viewport height. Drawers use a sticky title and close control; narrow inputs use 16 px text. At widths up to 1,180 px, side conversations use one full-width chat viewport. The Side path selector navigates the selected route; each conversation retains its own side list. Collapsed window strips remain a desktop presentation. The Back control returns to the source, preserving mounted conversations and drafts. Desktop retains its simultaneous conversations. Browser regression covers contracted viewport events and portrait/landscape layouts; it does not substitute for physical iOS/Android keyboard acceptance.


The workbench requests 100 projected Timeline entries per page and prefetches older history as the reader approaches the loaded beginning. Manual loading remains available, shares the prefetch request, and exposes pending or failed history independently of the live connection. Prepending keeps the latest visible entry offset, including when the reader keeps moving during the request or new live activity arrives.

## Context forks and side conversations

The console supplies `/fork` and `/side` independently of Provider command discovery; `/btw` aliases `/side`. Fork creates an independent native session from normalized conversation context, leaving the source chat open and adding an entry above its composer. Side creates a new independent session that references the source and opens beside it; command arguments become its first user input. The side view owns a separate RemoteSessionClient, replica, composer, history reader and interaction state. Closing it stops observation without closing the native runtime. Narrow screens show the side conversation in place of the still-mounted primary view.

`/fork` in `session-forks.ts` captures a single Timeline projection with a 20,000-entry bound and curates user messages, assistant messages and tool calls/results. One response keeps long-running tool updates in the same snapshot; its canonical window supplies the boundary. Incomplete responses fail instead of combining independently changing pages. Reasoning, diagnostics and interaction responses are excluded. Incomplete captures fail explicitly. User and assistant messages remain intact without a console character limit. Tool detail fields use 400-character excerpts, combined results use 1,200-character excerpts and errors use 600-character excerpts; excerpts retain both ends and mark omitted characters. The source reference and quoted attachment disclose how many tool records were shortened. Browser storage, transport and native context limits still apply. This is a snapshot of available normalized history, not a native `thread/fork` or a full native context export. The quoted attachment travels in the first normal message or skill/prompt argument; no system prompt, runtime scheduler or public protocol field is added. The renderer removes only the exact recorded attachment text; Trace retains actual native input.

`/side` and `/btw` send only `sourceNativeSessionId` with creation settings. They never capture the source Timeline or copy it into browser storage or the first input. The Host injects a real `read_source_session` tool plus developer instructions. On Codex 0.155.0 and newer, the adapter registers a native dynamic tool and reads with `thread/items/list` or `thread/searchOccurrences`; it does not resume or mutate the source. Other native Providers and older Hosts reject reference creation explicitly; `/fork` remains available with snapshot semantics.

`/ask` opens a small non-modal conversation above the focused source, also available through a floating Ask button. `/ask question` sends the question through that conversation's normal client and persistent outbox; it does not replace an existing Ask draft. Ask uses the same source-bound read tool and developer instructions as Side, without copying source history, adding a source badge, or sending a provenance prefix as user text. It inherits the same Host/provider support requirements.

The Ask window is centered in the visual viewport and starts in Content only mode. When a mobile keyboard obscures the layout or the available height is small, it fills the remaining visual viewport with an 8px vertical inset. The heading and composer stay visible while the timeline and multiline input scroll independently; focus reveal cannot scroll the floating frame. A small toggle next to Clean switches between Content only and Simple without changing the main conversation's display preference. The floating Ask button uses the same drag and keyboard positioning behavior as Track, with its own saved position.

Each source has its own Ask in a tab-local ledger. Minimizing stops its content subscription, retains the draft and conversation, and leaves the native runtime running. The focused source's active Ask remains on the shared activity channel, outside the Track menu and counts. Its button uses a green background for working, yellow for pending, and the white surface for idle. Unread pending and working-to-idle transitions use Track's yellow and gray pulses; opening Ask acknowledges them. Clean replaces only the auxiliary Ask observer, and restoring the page reattaches its saved native identity for activity observation. Questions waiting for the window to reconnect remain saved in session storage; uncertain sends remain visible with explicit Retry/Delete through normal message recovery. Clean creates a fresh referenced session, switching only after creation and settings inheritance succeed. It clears the old draft unless edited during the request; it does not delete the old native session. Failed or unknown creation outcomes retain the previous conversation and reuse the same creation operation on retry. The compact composer keeps normal message, image, and interaction behavior; visual-viewport sizing keeps the floating window inside a mobile keyboard viewport.

The read tool is bound to one authorized source. It reads newest-first, can search visible user/final assistant messages, and accepts a hit's `turnId` for focused context. Pages default to five entries (maximum ten), each limited to 6,000 characters with `totalChars`, `textOffset` and continuation cursors. Reads reflect current source history; they are not an immutable snapshot. Images are not copied into text results. Source history is quoted background, never an instruction or permission grant. Tool activity and failures use normal normalized Timeline tool entries.

The hosted Broker authorizes the source binding on the same Host and Provider before reserving quota, and includes it in request identity checks. The Host persists target-to-source grants under `~/.agent-remote-control/session-references/codex/` (configurable by `referenceDirectory`), scoped to its Codex runtime. It rebuilds local tool callbacks after restart, restores Host instructions, and leaves native saved model/workspace settings intact. Creation and every tool read check the current workspace policy using source metadata only; native children need not appear in the root session catalog. Native dynamic tool definitions remain in the saved Codex thread. Browser provenance remains local; deleting a browser record does not remove the Host grant. Missing or unreadable Host grant files cannot confer access to another source.

A permanent `& Source` tag with a fork badge identifies the source native session. Snapshot records also show capture time and cursor; reference records say “Read on demand”. It opens source details and navigation. Browser-local fork records survive opened-session removal and page reload, separately from the opened-session list. The ledger retains context, creation request identity, destination native identity and first-input delivery state. A confirmed retry of the same uncertain first input does not send it again. Unknown delivery is not automatically replayed. Browser storage is required for creating forks; native session retention still depends on the Provider. Fork provenance does not populate native subagent parent fields.

Creation inherits session-scoped mutable settings through existing Provider controls. DSH Hosts resolve the source working directory to a registered workspace and retain native global defaults. Codex Hosts preserve the source working directory, model, planning state, and mutable session settings. Fork settings are initialized before the first input; later explicit changes belong to the new session.


## Session sidebar

The desktop sidebar separates Sessions, New session, and Settings. Sessions is the default panel, with Host and Provider selection, search over loaded sessions, and two-line session titles. Creation settings and Host management occupy their own panels while form drafts remain mounted. The heading and panel navigation stay visible above one scrolling content area; changing panels resets that area to its beginning.

Above 1180 px, the sidebar starts at 320 px and exposes a draggable divider. Width is bounded between 260 and 560 px, with a lower maximum when needed to reserve 480 px for the main stage and 320 px for an open Replica Inspector. The preferred width persists in localStorage and is restored when temporary viewport constraints disappear. Arrow keys adjust by 10 px, Shift adjusts by 40 px, Home and End select the current limits, and Enter or double-click restores the default. Unavailable browser storage does not prevent resizing. Compact layouts retain the full-screen drawer without a width divider (`packages/agent-remote-lab/src/components/SidebarResize.tsx`, `packages/agent-remote-lab/src/App.tsx`, `packages/agent-remote-lab/src/app.css`).

## Mobile session shell

Favorites in the compact sidebar and title menu use single-line rows. Long titles and Host/Provider details scroll horizontally within the list, while Track and star actions remain visible at the right edge with 44 px touch targets. Desktop favorites retain their existing layout.

Phone layouts, including short touch-screen landscape viewports, keep the image-capable message editor at 16 px alongside native form controls to avoid focus-triggered iPhone magnification. Sending and returning focus retain the same editor font size; browser pinch zoom remains available.

Compact layouts expose Sessions directly. The full-screen session panel starts with the Host selector and a search over loaded sessions. Matching descendants keep ancestor context and expand during search. Browse provider changes the catalog without exposing creation settings. New session opens Provider/workspace/model configuration; Settings contains Host pairing, revocation, account sign-out, and recorded playback controls. Session selection closes the panel and resumes the conversation.

A small tab overlays the upper-right edge of the input dock and toggles message input visibility without reserving a layout row. The collapsed dock has zero height; the tab floats over the Timeline above the bottom safe area. Collapsing leaves the tab at the bottom and gives the recovered space to the Timeline; the mounted composer retains its draft. Expanding restores the same input without automatically opening the keyboard. The Timeline preserves its reading anchor or follows the latest content as the dock changes height.

Session and side navigation replace the current URL rather than adding browser history entries. Overscroll containment reduces scroll chaining and supported navigation gestures. The application does not trap browser history or promise to disable native iOS edge navigation. A normal browser fills its available visual viewport. Sessions → Settings includes a capability-detected Enter full screen / Exit full screen control. Fullscreen requires a user tap, reflects browser-confirmed state, and preserves the current conversation and draft. Unsupported browsers show Home Screen instructions instead; rejected requests remain retryable. The install manifest supports a standalone Home Screen launch without browser chrome; a recognized standalone launch does not offer redundant fullscreen controls. On iPhone, use Safari Share → Add to Home Screen and enable Open as Web App when offered. The application cannot force browser or operating-system chrome to disappear. The entire Sessions drawer is a vertical scrolling surface. Browse provider, session lists, creation fields, and Host settings share shrinkable grid tracks, bounded form controls, and long-text wrapping. Horizontal overflow is disabled at the drawer and list boundaries. Regression coverage switches Codex, Claude, and GitHub Copilot through long Host names, session titles, paths, error messages, and creation/settings views at 320 px, 390 px, and phone landscape widths, checking both content bounds and zero horizontal scroll position over a real Host uplink with deterministic responses. Both the Node/Docker static handler and Cloudflare Worker serve the manifest and icons. There is no service worker or offline agent-operation queue.

Message drafts and renderer-owned reading anchors are restored from sessionStorage in the same browser tab, scoped to the relay URL (including the hosted user's private base path). Explicit sign-out clears this recovery data. Blocked or full storage leaves in-memory editing available. Reading anchors retain up to 80 session/epoch identities; restoration requires the same epoch and the anchored entry in loaded history. This is not cross-device synchronization, full transcript caching, attachment recovery, or recovery of unsent question-form answers.


## Cross-device session links

The conversation heading provides Share session link, with a QR code and Copy link. Both desktop and mobile use the controller's public origin and a root URL containing `host`, `provider`, and the native `session`. `agent` records the current runtime identity; native child links also contain `parent`. The address bar follows the focused conversation, including Side sessions, using `replaceState`. Reload opens that session as the primary conversation; locally saved fork references and tab drafts remain available. Side layout, draft content, and local fork provenance are not transferred to another device.

A fresh browser attaches through the existing Host-scoped session directory using native identity, so it needs no opened-session cache and does not depend on the old runtime Agent ID. Native children use the existing child attachment route and its provider-specific parent-attachment requirements. Unavailable or unauthorized targets report a failure without opening a different session.

Hosted sign-in retains the validated root-relative session target in its one-time login challenge and returns there after authentication. Node/Docker and Cloudflare persist the same challenge field across restarts. Links contain no credentials and grant no new permissions; the receiving account must have access to the Host and session. Each device signs in independently. Standalone installations retain their existing pairing rules. Loopback controller addresses are only usable on the originating computer; scanning from a phone requires a reachable controller URL such as the deployed HTTPS origin.

Acceptance tests decode the generated QR, verify clipboard contents, follow desktop-to-phone-to-desktop authentication with empty browser storage, and reject an unauthorized account over real HTTP/WebSocket transports with a deterministic Provider. Physical camera scanning and native CLI session retention remain separate acceptance checks.

## Authentication entry pages

Session links use a consistent, responsive entry screen for access checking, gateway sign-in, lease recovery, callback verification, and interrupted sign-in. The light workbench palette, shared progress labels, full-width actions, reduced-motion support, and visible destination origin apply to both the React controller entry and the standalone callback served by Node/Docker and Cloudflare. Callback styles and scripts use explicit CSP hashes and need no external assets.

The initial access check and callback exchange stop waiting after 12 seconds and offer recovery. Retrying an access check starts a new request and ignores a retired request's late response. Gateway sign-in keeps a validated, credential-free return path in tab sessionStorage so an expired or failed callback can start a new sign-in for the same session. Successful authentication clears that temporary path. If browser storage is blocked, the original server challenge still restores the session after successful sign-in; recovery after a failed callback may require reopening the original session link. Callback failures distinguish an expired/invalid sign-in from service or network unavailability, remove the ticket fragment immediately, and never replay an exchange automatically. Account entry and credential collection remain on the configured gateway.
