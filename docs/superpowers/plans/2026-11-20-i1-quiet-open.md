# I1: Quiet open

**State: implemented.** I1 is the first Orchard step (roadmap "Next: Orchard"; [Orchard design](../specs/2026-11-20-orchard-im-experience-design.md), decisions 4 and 5 and step I1; [IM session service design](../specs/2026-11-15-im-session-service-design.md), targets T4 and T5, Presentation, Removed in smart mode). It meets T4 and T5 on the current page. There is no visual redesign, no protocol change and no Controller change.

## 1. For the owner

**What changes for you.** Opening a conversation no longer shows "Opening session", "Checking access", "Synchronizing", "Reconnecting" or "Restoring". The composer is editable from the first frame. A message you send before the session is ready shows "Sending" at once and is delivered when the session is ready. A real problem is said once, in business words: the Host is offline, the session ended or failed, it is read-only, or a terminal is in control. One indicator, for the whole page, says when this device has lost its link to the Relay.

**What does not change.** The client's connection state machine, its reconnect loop and the Relay's session control stay as they are. Connection phases remain visible in Trace and the Replica Inspector (layer L3). The per-session attach and control loops are removed later, with the rest of P2.

**Deploy.** I1 touches only `agent-client`, `agent-client-web` and `agent-remote-lab`. It ships as a website release. It does not need a Controller update or a Relay change.

## 2. Today

| Piece | Where | What it does |
|---|---|---|
| Activity line label | `agent-client-web/src/react/AgentActivityStatus.tsx:17-46` | `disabled = blocked \|\| !session.synchronized \|\| session.controlChecking`. While disabled it shows `connectionLabel` (Unavailable, Reconnecting, Opening session, Checking access, Synchronizing, Disconnected), unless `connectionWordHidden` (rows held from the device). It then shows the runtime words Reconnecting, Restoring and Native runtime unavailable. |
| Composer gate | `agent-client-web/src/react/AgentComposer.tsx:139-148`, `:187-189`, `:502-597` | It defaults to `remoteSessionState(state, disabled ? 'connecting' : 'ready')`. `ready` needs `synchronized`, not `disabled`, not `controlChecking` and a connected runtime. `canWait` accepts text into the waiting queue during recovery, but only when `state.agent` exists. The editor and the model controls are disabled while `!state?.agent`. |
| Waiting queue | `agent-client-web/src/react/usePendingSend.ts`, `PendingSendQueue.tsx`, `AgentComposer.tsx:203-252` (`deferMessage`) | This is the existing send-until-ready queue. It is FIFO per session, dispatches when `ready()` holds, and never retries automatically after dispatch. A `waiting` item shows only its text, with no state word. The word "Sending" appears only once the item is dispatched. |
| Send state | `agent-client/src/replica/send-state.ts` | The pending message in the timeline: sending, awaiting echo, unconfirmed, failed. It is unchanged. |
| Workbench labels | `agent-remote-lab/src/components/SessionWorkbench.tsx:127-145` (`activityLabel`), `:97-125` (`connectionFailure`, `runtimeNotice`, `useRecoveryNotice` toast), `:369` (`reconnectingNotice`), `:412` ("Start with a Provider") | A second copy of the label chain, the runtime notes, the "Session runtime" toast, and the empty state while a target resolves. `disabled={sessionStatus !== 'ready'}` and `disabledLabel={activityLabel}` go to the composer (`:214-216`). |
| App bar label | `agent-remote-lab/src/app/useHostAndStack.ts:39-41`, `app/helpers.ts:51-60` (`sessionStatusLabel`), `app/views/AppBar.tsx:26` | A third copy: Opening session, Synchronizing, Reconnecting. |
| Control notice | `agent-client/src/client/lease-view.ts:37` ('Checking access…'), `agent-remote-lab/src/components/SessionControlNotice.tsx:31` ('Restoring session…', 'Checking session…') | Read-only and take-over notice. |
| Session state | `agent-client/src/client/session-state.ts` | `RemoteSessionState`: `holdingRows` exists only to hide the opening words. |
| Connection states | `agent-client/src/client/remote-session-client.ts`: `connect()` sets `connecting` (:208), `negotiated` sets `catching_up` (:631), recovery sets `ready` (:806), and restart and pause go through `disconnected` (:875, :886) | Unchanged by I1. |
| Device link | `agent-remote-lab/src/GatewayController.tsx:35,203-205` | The `gateway-recovery` banner "Reconnecting… Retry" appears after 5 s without workspace access (`useRecoveryNotice`, `RECOVERY_NOTICE_DELAY_MS`). The session channel's socket (`SessionChannelPool`, `agent-client/src/client/session-channel-transport.ts`) reports nothing to the page. |

"Awaiting Agent" and "Loading conversation" are no longer produced anywhere in `packages/*/src`. They survive only in the runners' label lists (`local-baselines.mjs:354`, `local-switch.mjs:24`).

## 3. Control check ordering: what the code does

I1's third goal is that the control check runs alongside the timeline subscription, not before it. Reading the code shows that it already does on the wire. The only sequential part is in presentation.

- **Relay.** A journal-served stream sends `negotiated`, the Snapshot and its `session_control` announcement back to back, in one flight (`agent-relay-core/src/journal-session-stream.ts:263-268`). A crude stream announces right after the Controller's Snapshot (`host-session.ts:363`, `stream-control.ts` `controllerFrame`). `acquire` is answered by the Relay at once, with no Controller round trip (S5).
- **Client.** On `agent_snapshot` the client sends `timeline_subscription` (`remote-session-client.ts:681`). On `session_control` it sends `acquire` (`:647`) and then the tail `timeline_request` (`beginSocketRecovery`, `:745-750`). The tail request waits for the announcement frame, not for the grant. All three requests leave within the same flight.
- **The sequential part.** `ready` waits for the grant (`if (this.controlReady) await this.controlReady`, `:800`). The views then read `controlChecking` and `!synchronized` as "disable the composer and show Checking access or Synchronizing". So the user waits on the grant, but the network does not.

**Decision.** No protocol or client reordering. `ready` keeps meaning "subscribed, caught up and control settled", because that is the right moment to dispatch a queued send: a mutation needs the token (`sendOperation`, `:925-929`). I1 removes the grant from what the user sees. Task 3 pins the wire concurrency with a unit test, so a later change cannot make it sequential.

## 4. Target rules

### 4.1 One rule module in `agent-client`

New file `packages/agent-client/src/client/session-presentation.ts`. It is pure, has no clock, and is exported from the package index. Every view reads it, and no view reads `connection`, `controlChecking`, `synchronized` or `runtime` for words or enablement.

```ts
export interface SessionFacts {
  readonly session: RemoteSessionState;
  /** The session's Host as the Relay last said (SessionStatesView.host); undefined before it said anything. */
  readonly host?: { readonly online: boolean; readonly name?: string };
  /** The replica, read only for the words of a failure: the runtime failure and the last non-recoverable diagnostic. */
  readonly replica?: AgentReplicaState;
}

export type SessionNotice =
  | { readonly kind: 'host_offline'; readonly hostName?: string }
  | { readonly kind: 'ended' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'terminal_in_control' }
  | { readonly kind: 'other_controller' }
  | { readonly kind: 'read_only' }
  /** The Relay refused the session for good (`refuseDisconnected`), or a non-recoverable diagnostic. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** The adapter reports the native runtime unavailable (see Open question 1). */
  | { readonly kind: 'agent_unavailable'; readonly message: string };

/** The one business notice of a session, or none. Never derived from connection phase, control checking or a recovering runtime. */
export function sessionNotice(facts: SessionFacts): SessionNotice | undefined;
/** Plain words for a notice, for example "Mac mini is offline. Messages will be delivered when it is back." */
export function sessionNoticeWords(notice: SessionNotice): string;

export type ComposerBlock = 'read_only' | 'terminal_in_control' | 'other_controller' | 'ended' | 'failed' | 'unavailable' | 'unsupported';
export type ComposerAvailability =
  /** `dispatch: 'now'` when a send may go to the session at once; otherwise it waits in the send queue. */
  | { readonly input: 'enabled'; readonly dispatch: 'now' | 'when_ready' }
  | { readonly input: 'disabled'; readonly reason: ComposerBlock; readonly words: string };
/** Whether the composer takes input, and whether a send goes now or waits. Only a business reason disables it. */
export function composerAvailability(facts: SessionFacts): ComposerAvailability;

/** The business label of the activity line: Working, Waiting for response, Starting, Ready, Closed, Agent failed, the native owner's words; undefined before any Snapshot and for a session the Relay refused. */
export function sessionActivityLabel(facts: SessionFacts, commandPending?: boolean): string | undefined;
```

**Rules, as invariants.**
- **R1.** For every combination of `connection` (all six values), `controlChecking`, `synchronized`, `holdsUnconfirmedRows` and runtime `reconnecting` or `restoring`, with no business fact: `sessionNotice` is undefined, `composerAvailability` is `enabled`, and `sessionActivityLabel` is a business label or undefined. No output contains a word of the T5 list (section 4.3).
- **R2.** `input: 'disabled'` exactly for these business reasons:
  - `read_only`: a read-only lease with no owner, a read-only share, or a recording;
  - `terminal_in_control` or `other_controller`: a native owner;
  - `ended`: status `closed`;
  - `failed`: status `failed`;
  - `unavailable`: connection `unavailable`;
  - `unsupported`: `capabilities.sendMessage === false`.
- **R3.** `dispatch: 'now'` exactly when `session.synchronized && !controlChecking && operations.send_message.allowed`. This is today's `dispatchReady`, moved here. In every other enabled case the value is `when_ready`. Before the first Snapshot (no agent) the composer is `enabled` with `when_ready`. The code reads `operations.send_message.allowed` alone: that availability already refuses an unsynchronized session and any control but `control`, so the other two terms add nothing (a mutation that drops `!controlChecking` fails no test); the R3 test asserts the whole condition.
- **R4.** Host offline gives the `host_offline` notice and leaves the composer `enabled`. The lab's existing `sendLater` path (the outbox) still decides how the send waits for the Host.
- **R5.** The notice for a native owner replaces `leaseActivityLabel`. Its words come from one place, `leaseNoticeLabel`, minus its `checking` case.

### 4.2 Device link indicator

No indicator of the socket link exists today. The only device-level signal is GatewayController's access banner (section 2). I1 makes that banner the single indicator and feeds it the session channel's link as well.

```ts
// agent-client/src/client/session-channel-transport.ts (SessionChannelPool); ChannelLink lives in relay-link.ts, the pure module
export type ChannelLink = 'unknown' | 'up' | 'down';
/** The link of the activity channel, which stays open while any feed is watched. `down` after it was up and failed, until it reopens. */
relayLink(): ChannelLink;
subscribeRelayLink(listener: (link: ChannelLink) => void): () => void;
// HttpWebSocketTransport forwards both; 'unknown' without session channels (legacy direct sockets).
// RemoteAgentTransport declares both as optional, beside watchSessionStates, so the lab reads them from its transport type.

// agent-client/src/client/relay-link.ts (pure)
export interface RelayLinkFacts { readonly accessReady: boolean; readonly needsSignIn: boolean; readonly channel: ChannelLink; readonly browserOnline: boolean }
export type RelayLinkView = { readonly state: 'online' } | { readonly state: 'offline' } | { readonly state: 'sign_in' };
export function relayLinkView(facts: RelayLinkFacts): RelayLinkView;
```

- **Display.** GatewayController's `gateway-recovery` element renders `relayLinkView`:
  - `offline`: "Offline. Messages will be sent when this device is back online." with Retry;
  - `sign_in`: today's sign-in words;
  - `online`: nothing.
- **Timing.** It keeps the existing 5 s grace (`RECOVERY_NOTICE_DELAY_MS`), so a quick socket swap shows nothing. No new constant is added.
- **Wiring.** One context, `RelayLinkReport`, provided by GatewayController with a setter. `useWorkbenchShell`, which creates the transport, reports `subscribeRelayLink` into it.
- **The first open is not `down`.** `down` needs a channel that was `up`. A channel that never opens within its open deadline (`channelOpenTimeoutMs`) also counts as `down`.

### 4.3 The T5 words, one list

`packages/agent-e2e/faults/connection-words.mjs` (with `.d.mts`) exports:

```ts
export const SESSION_CONNECTION_WORDS: readonly string[]; // Opening session, Checking access, Synchronizing, Reconnecting, Restoring, Awaiting Agent, Start with a Provider, Loading conversation
export const SESSION_CONNECTION_PATTERN: RegExp;
```

Its consumers are the E9 flow, the smoke invariant, the three runners and the component specs. The unit vectors in `agent-client` keep their own copy of the list, because `agent-client` may not import test support. Task 1 adds a test that compares the two lists.

### 4.4 React shells

- **`AgentActivityStatus`.** It reads `sessionActivityLabel` and nothing else for words. The `disabled` and `disabledLabel` props are removed. The presence dot shows `offline` only for a notice.
- **`AgentComposer`.**
  - `sessionState` becomes required, and the `'connecting'` default is deleted.
  - The `disabled`, `disabledLabel` and `recovering` props are deleted.
  - `ready`, `canWait` and `dispatchReady` become `composerAvailability(...)` for a plain send. Commands, skills, files and next-turn queueing need the session itself (owner decision 3): they read the session's operation admission (`operations.interaction_response.allowed`, which every operation shares), not `composerAvailability`, because an agent that takes no messages still runs console commands.
  - A state restored from the device is no longer draft-only: a send over it waits (section 4.5).
  - A send that waits may be accepted before the session's `onSendMessage` exists (a view still opening); it is dispatched only when the session is `now` and the action is there.
  - The editor is enabled whenever `input === 'enabled'`, including before the first Snapshot.
  - Plain text and images go to `deferMessage` when `dispatch === 'when_ready'`.
  - Commands, skills, files and `next_turn` queueing need the session and wait for `now` (Open question 3).
  - The model and setting controls render from the Snapshot as soon as there is one (device store or wire), and are interactive when their operation is allowed.
- **`PendingSendQueue`.** A `waiting` or `preparing` item shows "Sending". Today it shows nothing until dispatch. Errors keep their words: "Not sent", "Check delivery".
- **Lab.** These read `sessionNotice` and `sessionActivityLabel`, and their connection branches are deleted:
  - `SessionWorkbench`: the activity label, the notes above the timeline, the toast and the composer props;
  - `useHostAndStack` and `AppBar`: the app bar label;
  - `SessionControlNotice`: the take-over phases say "Taking control…" throughout.

  The empty state "Start with a Provider" shows only for a view with no session target. A view whose target is still resolving shows its held rows, or nothing.

  `SessionConversation` lets a view that opens its first session take messages: the composer is no longer draft-only while it opens, so a send waits and is dispatched when the session is ready. A failure, an offline Host (its `sendLater` path) and a view whose target changed under a previous session keep today's draft-only composer, because the draft may belong to the previous session (the `SessionPromptEdit` tests pin that).

  The heading shows the activity label only. The notice is said once: above the timeline for `unavailable`, `failed` and `agent_unavailable`; in the composer's context for `host_offline`, unless the opening view's loading notice already says it; by the composer's control notice for a read-only lease or a native owner. Capacity refusals and pauses (`session_capacity`, `session_paused`) leave the conversation for L3 (owner decision 5).

### 4.5 Deliberate contract change

Seam S6 (`docs/current/agent-remote/seams.md`, "Restored state") says that the composer "offers no send until the first server page confirms the state". After I1, the composer accepts a send over a restored replica, and that send waits as "Sending" until the first server page confirms the state. Dispatch still never precedes confirmation (R3). The seam doc and its test change together (Task 4).

## 5. State accounting

Rule 1 of the roadmap: fields and paths, +N/-M. The counts come from reading the code; Task 9 records the measured numbers.

| Change | Fields | Paths |
|---|---|---|
| `session-presentation.ts` (new, pure) | +0 state; +3 functions | It replaces three label chains (`AgentActivityStatus`, `SessionWorkbench`, `useHostAndStack`) with one: label chains 3 to 1 |
| `RemoteSessionState.holdingRows` | -1 | -1 (hiding the opening words) |
| `AgentActivityStatus` | props -2 (`disabled`, `disabledLabel`); locals -3 (`connectionLabel`, `connectionWordHidden`, `disabled`) | label branches 15 to 9 (business only) |
| `AgentComposer` | props -3 (`disabled`, `disabledLabel`, `recovering`); locals -3 (`ready`, `canWait`, `controlChecking`) +1 (`availability`) | send paths unchanged (direct, deferred, later); enablement conditions 5 to 1 |
| `PendingSendQueue` | 0 | words +1 ("Sending" while waiting) |
| `SessionWorkbench` | locals -5 (`rowsHeld`, `recoveryNoticeDue`, `runtimeNotice`, `connectionFailure` label use, `activityLabel` chain) +1 (`notice`) | notes 3 to 1; toast -1 |
| `useHostAndStack`, `helpers.ts` | -1 function (`sessionStatusLabel`) | -3 branches |
| `lease-view.ts`, `SessionControlNotice` | -1 case (`checking`); handoff words 3 to 1 | 0 |
| `SessionChannelPool` | +1 (link listeners) +1 (`link`) | +0 recovery paths (link only observes the existing channel) |
| GatewayController banner | +1 input (channel link) | 0 |
| `remote-session-client.ts` | 0 | 0 (Task 3 adds a test, no code) |

The only additions are the link observer and the rule module. The link observer is needed because T5 requires one indicator of the device's own link and none reads the socket today. The rule module replaces three copies of the same chain.

Budget: production lines in `packages/` net negative over the step, tests excluded. No new timer, cache, pool or constant; the indicator reuses the 5 s grace.

## 6. Tests that pin today's labels

Each test below is changed in the task named, with the new expectation. A test is deleted only with the mutation check of the write-tests skill (section 5) and a row in Task 9's mapping.

| Test | Today | New expectation | Task |
|---|---|---|---|
| `agent-client-web/src/react/AgentActivityStatus.test.tsx` (3) | Opening session, Synchronizing, Checking access words | It reads the vector rows. No T5 word for any connection row; business labels only | 4 |
| `agent-client-web/src/react/AgentComposer.test.tsx` (5), `.transport.test.tsx` (1) | Disabled with connection words | Editor enabled for every connection row; a send waits and dispatches at `now` | 4 |
| `agent-client-web/src/react/AgentComposer.pending.test.tsx` (`setup` uses `disabled: true, recovering: true`) | Recovery through props | Through `sessionState` rows; a `waiting` item reads "Sending"; "waits for confirmed control" stays | 4 |
| `agent-remote-seams/tests/S6/...integration.test.tsx` "takes a draft over a restored replica and offers no send…" | Submit disabled until confirmed | Submit enabled; the send shows "Sending" and `onSendMessage` is called only after the first server page | 4 |
| `agent-client/src/client/lease-view.test.ts` | `leaseNoticeLabel('checking')` | That case is removed; the other rows stay | 5 |
| `agent-remote-lab/src/components/LabWorkbench.test.tsx` (15), `SessionFamily.test.tsx` (15), `App.test.tsx` (9), `App.succession.opening-and-refresh.test.tsx` (3), `AgentActivityStatus.test.tsx` (1), `LabWorkbench.recovery.test.tsx` (1), `SideConversation.test.tsx` (1), `Toast.test.tsx` (1), `hooks/useAskConversations.test.tsx` (5), `state/session-binding.test.ts` (2) | Label text of connection phases | The business label or none. Composition tests that only read the label for a phase assert "no T5 word". `ReplicaInspector.test.tsx` keeps its words (L3) | 5 |
| `agent-remote-lab/e2e/components/session-view-responsive.spec.ts` | `Opening session`, `Synchronizing`, `Reconnecting` per connection; submit disabled in draft-only | For each connection: no T5 word; the label is hidden or business; the editor is editable; the composer height is stable (kept) | 7 |
| `agent-remote-lab/e2e/components/toast-placement.spec.ts` | Uses the "Native runtime is reconnecting" toast as its toast | It uses a command-error toast from the same fixture; placement assertions unchanged | 7 |
| `agent-remote-lab/e2e/session-live-cache.browser.ts:39` | `Opening session`; Send disabled | No T5 word; the editor is editable; held rows shown (kept) | 7 |
| `agent-remote-lab/e2e/device-store.browser.ts:94,120` | `opening` regex never in first frame | Uses `SESSION_CONNECTION_PATTERN`, in every frame | 7 |
| `agent-remote-lab/e2e/device-store.browser.ts:157` "says Reconnecting, never hides it…" | Reconnecting shown | Renamed "a broken connection keeps the stored rows and says nothing per session": 30 rows stay, no T5 word, the editor is enabled, and a send waits as "Sending" | 7 |
| `agent-e2e/specs/workbench.spec.ts:20,27` | `.lab-conversation-status` reads Synchronizing | During `fixture-synchronizing` the status never reads a T5 word; input, send and geometry are unchanged (kept) | 7 |
| `agent-e2e/smoke/invariants/page.ts` `noStaleLabel`, `RECONNECT_LABEL`; `page.test.ts` (5); `findings.test.ts:19`; `m1-bad-network.ts:73`, `m8-soak.ts`, `lib/restart-round.ts:85` | A connection label must clear within 5 s | Replaced by `noSessionConnectionLabel(page)`: no sample has a T5 word. `noBlankFrame` reads "placeholder or held rows" and drops its "status label" escape | 7 |
| `agent-remote-lab/performance/local-baselines.mjs:354-357`, `local-switch.mjs:24`, `session-control.mjs:90` | Own label lists | Import `connection-words.mjs` | 0 |

## 7. Tasks

**For every task:**
- Work in `.worktrees/im-session-service` and run `pnpm task:start` once before Task 0.
- Lab jsdom suites run on Node 22: prefix `PATH=/opt/homebrew/opt/node@22/bin:$PATH`, as CI does.
- Each commit states its state accounting (section 5) and ends with `pnpm arch:check` and `pnpm test:unit <package> [file]` for what it touched.
- `pnpm compatibility:update`, then `pnpm compatibility:check`, before each commit that changes `agent-client` or `agent-client-web` exports.

### Task 0. One word list and the runner's I1 measurements (control arm first)

**Files:**
- `packages/agent-e2e/faults/connection-words.mjs` and `.d.mts` (new);
- `packages/agent-e2e/package.json` (export the path, as `latency-proxy.mjs` is exported);
- `packages/agent-remote-lab/performance/session-control.mjs`, `local-baselines.mjs`, `local-switch.mjs`;
- `packages/agent-remote-lab/performance/README.md`.

**Interfaces.** Section 4.3. `session-control.mjs` gains the following:
- `--type-during-open`: per open, type `Reply with the single word OK.` and press Enter as soon as the prompt input is editable after `goto`.
- It records these times in ms from the key press: `sendingMs` (first `[data-testid="pending-send"]` or `[data-delivery-state]`), `acknowledgedMs` (the `command_acknowledged` frame) and `deliveredMs` (the user row in the timeline).
- It records whether the editor kept focus (`document.activeElement` is the prompt input 50 ms after Enter), and whether text typed after Enter is still in the editor.
- The observer reads `.lab-conversation-status, [data-testid="agent-activity-label"], .lab-session-control-owner, .lab-empty-state h3, .lab-control-note, .lab-toast, .lab-connection-status, .agent-composer`. Each open records `connectionWords`: the T5 words seen in any frame.

**Tests.** `packages/agent-e2e/faults/connection-words.test.ts`: the pattern matches every word and does not match the business labels (Ready, Working, Waiting for response, Closed, Host offline). Run `pnpm test:unit agent-e2e faults/connection-words.test.ts`.

**Control arm.** This runs before any product change, on this commit's build. The commands follow `.agents/skills/prepare-arc-local/SKILL.md` and the lifecycle reference: check the instance's own sessions before `up`.

```bash
ARC_LOCAL_JOURNALS=1 pnpm local up
# smart reading for Copilot, as in S5: PUT v1/remote/hosts/<hostId>/smart-reading through `pnpm --silent local api`
for c in "1 0" "4 0" "1 100" "4 100"; do set -- $c
  node packages/agent-remote-lab/performance/session-control.mjs --label i1-control --throttle $1 --rtt $2 --opens 10 --sends 3 --type-during-open --out .tmp/i1-control-$1x-$2ms.json
done
```

### Task 1. The rule module and its vectors (`agent-client`)

**Files:**
- `packages/agent-client/src/client/session-presentation.ts` (new);
- `session-presentation.test.ts` (new);
- `packages/agent-client/src/testing/session-presentation-vectors.ts` (new, exported from `agent-client/testing`);
- `packages/agent-client/src/index.ts`.

**Interfaces.** Section 4.1.

**Vectors.** These are rows `{ name, facts, notice, composer, label }` built with `remoteSessionState` over a replica that applied a Snapshot and a tail page, or restored them from the device (`buildPresentationReplica`; `buildReplica` and `buildRestoredReplica` apply no Snapshot or a fixed one), and `buildSnapshot`. Concrete rows:
1. Each `connection` value but `unavailable` (row 10, a business fact under R2) with an idle agent, control granted and synchronized only at `ready`: no notice, `enabled`, `now` only at `ready`, label Ready.
2. No agent yet (`connecting`, no Snapshot): no notice, `enabled`/`when_ready`, label undefined.
3. Restored from the device, `catching_up`, `checking`: no notice, `enabled`/`when_ready`, label from the stored status (Working for a stored running turn).
4. Runtime `reconnecting` and `restoring` while `ready`: no notice, `enabled`/`when_ready`, label Ready or Working.
5. Runtime `unavailable`: notice `agent_unavailable`, `enabled`/`when_ready` (Open question 1).
6. Host offline (`host.online === false`), with any connection: notice `host_offline` with the Host name, `enabled`.
7. Native owner `native_cli`: notice `terminal_in_control`, `disabled`/`terminal_in_control`, label "Native CLI has control".
8. Read-only lease, no owner: notice `read_only`, `disabled`/`read_only`.
9. Status `closed`: `ended`. Status `failed`: `failed` with the runtime failure message.
10. Connection `unavailable` with reason "Session was deleted": notice and block `unavailable`.
11. `capabilities.sendMessage === false`: `disabled`/`unsupported`, no notice.
12. `disconnected` after `ready`, with a pending send: no notice, `enabled`/`when_ready`.

**Tests** (`session-presentation.test.ts`):
- Every vector row.
- R1 as a product test: every combination of 6 connections × 4 lease states × 3 runtime states × 5 activities × host unknown, online or offline; for each, no output contains a word of the T5 list.
- R2: `disabled` only with a business fact present.
- R3: `now` iff the condition holds.
- The agent-client copy of the T5 list equals the `connection-words.mjs` list. The test reads the `.mjs` file as text, which test files may do.

Every test is pure and under 50 ms.

**Commands:**
```bash
pnpm test:unit agent-client src/client/session-presentation.test.ts
pnpm arch:check
```

### Task 2. Device link (`agent-client`, lab shell)

**Files:**
- `packages/agent-client/src/client/session-channel-transport.ts`;
- `http-websocket-transport.ts`;
- `relay-link.ts` and `relay-link.test.ts` (new);
- `session-channel-transport.test.ts` (new: agent-client had no unit test of the pool; its channel failures are covered by the seam suite `agent-remote-seams/tests/S3/session-channel-client.integration.test.ts`);
- `packages/agent-remote-lab/src/GatewayController.tsx`;
- `packages/agent-remote-lab/src/app/useWorkbenchShell.ts`.

**Interfaces.** Section 4.2.

**Tests:**
- `relay-link.test.ts` (pure table):
  - access ready, channel `up` → `online`;
  - channel `unknown` → `online` (no channel, no claim);
  - channel `down` → `offline`;
  - `browserOnline: false` → `offline`;
  - `needsSignIn` → `sign_in`, which wins over `offline`;
  - access not ready → `offline`.
- Pool, with a fake WebSocket and an injected `stateRetryMs`:
  - the link is `unknown` until the activity channel is ready, then `up`;
  - a socket close gives `down`, and the reopen gives `up`;
  - an open deadline missed on the first open gives `down`;
  - listeners stop after unsubscribe.
- `GatewayController.test.tsx`: the banner appears 5 s after the reported link goes `down` (fake timers), says "Offline", and never says a T5 word; a link back `up` before 5 s shows nothing.

**Commands:**
```bash
pnpm test:unit agent-client src/client/relay-link.test.ts
pnpm test:unit agent-client src/client/session-channel-transport
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/GatewayController.test.tsx
pnpm arch:check
```

### Task 3. Pin the control check alongside the subscription (`agent-client`)

**Files.** `packages/agent-client/src/client/remote-session-client.test.ts`.

**Test.** "requests the subscription, control and the tail in one flight, and waits on none of them to send the next" (the existing "requests control before socket history…" test, renamed and tightened, rather than a second test of the same rule):
- Using the existing fake transport, emit `negotiated` (`sessionControl: true`), `agent_snapshot` and `session_control`, synchronously and with no replies.
- Assert that `transport.sent` holds `timeline_subscription`, `session_control_request` and `timeline_request` (tail), in that order, before any reply.
- Then answer the tail before the grant, and assert that the status stays `catching_up` until the grant, then becomes `ready`.

Mutation check: moving `beginSocketRecovery` behind `controlReady` fails it.

There is no product change. If the test fails, the plan's section 3 finding is wrong; stop and report.

**Command:** `pnpm test:unit agent-client src/client/remote-session-client.test.ts`.

### Task 4. React shells read the rules (`agent-client-web`, seam S6)

**Files:**
- `packages/agent-client-web/src/react/AgentActivityStatus.tsx`;
- `AgentComposer.tsx`;
- `PendingSendQueue.tsx`;
- their tests (section 6);
- `packages/agent-remote-seams/tests/S6/client-replica-to-renderer.integration.test.tsx`;
- `docs/current/agent-remote/seams.md` (S6 "Restored state").

**Interfaces.**
```ts
export interface AgentActivityStatusProps { state?: AgentReplicaState; sessionState: RemoteSessionState; host?: SessionFacts['host']; visible?: boolean; commandPending?: boolean; interruptDisabled: boolean; interruptLabel: string; onInterrupt(): void }
// AgentComposerProps: `sessionState: RemoteSessionState` (required), `host?: SessionFacts['host']`; `disabled`, `disabledLabel`, `recovering` removed.
```

**Tests** (jsdom, fake timers):
- **Activity status.** For each vector row: the label equals `row.label` or is hidden, and the text never matches the T5 list.
- **Composer.**
  - For each vector row: the editor is enabled iff `row.composer.input === 'enabled'`.
  - With no agent and `connecting`: typing and Enter clear the editor and show one `pending-send` that reads "Sending" (in the same `act`). The editor keeps focus. Text typed afterwards stays. `onSendMessage` is not called.
  - Moving to `ready` and granted calls it once, FIFO. The model controls render from the Snapshot before `ready`.
- **Read-only during wait.** A row that turns `terminal_in_control` while an item waits: the item stays, nothing is sent, and the editor becomes read-only with the native notice. This is today's "waits for confirmed control" test, rewritten to rows.
- **Seam S6.** Section 6.

**Commands:**
```bash
pnpm test:unit agent-client-web src/react/AgentActivityStatus.test.tsx
pnpm test:unit agent-client-web src/react/AgentComposer
pnpm test:unit agent-remote-seams tests/S6
pnpm arch:check
```

### Task 5. Lab reads the rules (`agent-remote-lab`)

**Files:**
- `src/components/SessionWorkbench.tsx`;
- `src/components/SessionControlNotice.tsx`;
- `src/app/useHostAndStack.ts`;
- `src/app/helpers.ts`;
- `src/app/views/AppBar.tsx`;
- `src/components/ProviderSessionControls.tsx` (the create button says "Creating session…");
- `src/components/SessionConversation.tsx` (pass the target, so the empty state is only for no target);
- `packages/agent-client/src/client/lease-view.ts`;
- the lab tests of section 6.

**Interfaces.**
- `SessionWorkbench` loses `activityLabel`, `rowsHeld`, `runtimeNotice`, `reconnectingNotice` and its `useRecoveryNotice` call, and gains `notice = sessionNotice(facts)`. It shows the notice once:
  - as the activity label's companion in the heading;
  - in `lab-control-note` above the timeline, only for `unavailable`, `failed` and `agent_unavailable`;
  - as the composer context for host offline.
- `useHostAndStack` returns `connectionStatusLabel = notice ? sessionNoticeWords(notice) : sessionActivityLabel(facts) ?? ''`. The facts include the Host's `online` and `name`.
- The composer receives `sessionState` and `host`, and loses `disabled`, `disabledLabel` and `recovering`.

**Tests:** the lab rows of section 6, plus these:
- `SessionWorkbench.test.tsx` (or the closest existing file): with the replica `catching_up` and checking, then `disconnected`, the heading, timeline notes and toasts contain no T5 word, and the composer dock is visible with an enabled editor before the first Snapshot when the view has a target.
- An offline Host shows "… is offline" exactly once on the page (heading or composer context, not both).

**Commands:**
```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/components
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/App.test.tsx
pnpm test:unit agent-client src/client/lease-view.test.ts
pnpm arch:check
pnpm verify:changed
```

### Task 6. "Sending" within 100 ms at 4x CPU

S5 measured 116 to 125 ms at 4x CPU for a first send (S5 plan, section 12). This was the throttled page's render, not the network.

**Approach.** Measure first: run the Task 0 runner on the Task 5 build at 4x CPU, 0 ms and 100 ms. Change code only if `sendingMs` p95 is over 100:
- **Candidate.** A plain-text send always enters the waiting queue (`deferMessage`), so the "Sending" mark is the composer's own chip, committed in the key's event. The replica's pending row follows on dispatch.
- **What it removes.** The direct text path in `submit` (`AgentComposer.tsx:428-447`, the text-only branch) becomes the queue's `send`. This is one send path for text instead of two.
- **What it keeps.** Next-turn queueing, files and commands keep their direct path.

**Tests.**
- A composer test: one send while `now` dispatches through the queue in the same task and shows one "Sending" (chip or timeline row, never both at once).
- E2's pending test, unchanged.

**Commands:** the Task 0 runner with `--label i1-task6`, `pnpm test:unit agent-client-web src/react/AgentComposer`.

If the candidate still misses 100 ms, record the numbers and take it to the owner (Open question 6). Do not add a second mechanism.

### Task 7. Component, browser, e2e specs and smoke invariants

**Files.** The rows of section 6 marked 7, plus:
- `packages/agent-e2e/smoke/invariants/page.ts`, `index.ts`, `page.test.ts`;
- the scenarios that call `noStaleLabel`.

**Interfaces.**
```ts
/** T5: no sample of the page shows a per-session connection word. */
export function noSessionConnectionLabel(page: PageReport): InvariantResult;
```
`noStaleLabel` and `RECONNECT_LABEL` are deleted. `PageSample.labels` (`types.ts:42`) keeps its meaning: the status labels seen.

**Tests:**
- `page.test.ts`:
  - samples with Ready and Working pass;
  - a sample with "Synchronizing" fails at its time;
  - "Host offline" passes;
  - an empty report is `skipped`.

**Commands:**
```bash
pnpm test:unit agent-e2e smoke/invariants/page.test.ts
pnpm test:components
pnpm test:preview-browser
node scripts/run-tests.mjs live-cache-browser
pnpm test:e2e -- specs/workbench.spec.ts
```

### Task 8. E2E flow E9 Quiet open

**Files:**
- `packages/agent-e2e/flows/e9-quiet-open.e2e.ts` (new);
- `flows/browser.ts` (`PageOptions.hold`);
- `flows/page.ts` (`watchSockets` hold point, `watchWords`);
- `architecture/modules.json` (add `E9` to `client` and `client-web` flows).

**Interfaces.**
```ts
// browser.ts
export interface PageOptions { viewport?: { width: number; height: number }; hold?: boolean | 'agent_snapshot' } // true keeps today's meaning: hold from the first timeline_page
// page.ts
/** Records, from before the first paint, every T5 word that any frame of the page shows (MutationObserver over the workspace, innerText of visible nodes). */
export async function watchWords(page: Page): Promise<{ seen(): Promise<string[]> }>;
```

**Flow.** It is written like E2: a scripted provider with `replyDelayMs: 300`, and a session `quiet` with two history rows.
1. **"E9: a message typed while a never-opened session opens shows as sending and is delivered once, with no connection word in any frame".**
   - Open with `hold: 'agent_snapshot'` and `watchWords` installed. Wait until the prompt input is editable (no rows yet).
   - Type "Typed while opening" and press Enter. Expect `pending-send` "Sending". Expect the provider has not received it. Type " next" and expect the editor to hold " next" and to have focus.
   - `sockets.release()`. Then expect "Echo: Typed while opening", one user row, and `provider.sent` holding it exactly once.
   - Expect `seen()` to be empty.
2. **"E9: the same on a conversation this device has open, while the Relay's first page is held".**
   - First visit, `waitForKeptConversation`. Reopen in the same context with `hold: true` (rows come from the device store).
   - Type, Enter, "Sending", release, delivered once.
   - Expect `seen()` to be empty.

**Commands:**
```bash
pnpm --filter @orchardworks/agent-e2e exec vitest run --config vitest.e2e.config.ts flows/e9-quiet-open.e2e.ts
pnpm test:e2e:flows
pnpm arch:check
```

The first command is the focused run, under the package's per-test deadline. The second runs all flows under the 240 s outer deadline.

### Task 9. Deletion (rule 7)

**Remove, with the mutation check where a test is involved:**
- **`AgentActivityStatus`:** `connectionLabel`, `connectionWordHidden`, the `disabled` and `disabledLabel` props, and the runtime words Reconnecting and Restoring.
- **`AgentComposer`:**
  - the `disabled`, `disabledLabel` and `recovering` props;
  - the `remoteSessionState(state, disabled ? 'connecting' : 'ready')` default;
  - `canWait`, `ready` and `dispatchReady` as separate conditions.
- **`RemoteSessionState.holdingRows`**, and the `holdsUnconfirmedRows` export: the function stays internal to `session-state.ts` if `display-lease` or the store still need it; otherwise it is deleted.
- **`SessionWorkbench`:**
  - the connection branches of `activityLabel`;
  - `rowsHeld`;
  - the `useRecoveryNotice` call;
  - `reconnectingNotice`;
  - `runtimeNotice`;
  - the "Session runtime" toast;
  - "Connection failed" (now the `unavailable` notice).
- **Lab helpers:** `sessionStatusLabel` in `app/helpers.ts`, and the connection branches of `useHostAndStack.connectionStatusLabel`.
- **Lease words:** `leaseNoticeLabel`'s `checking` case, and `leaseActivityLabel`, which moves into `sessionActivityLabel`.
- **`SessionControlNotice`:** the 'restoring' and 'checking' handoff words.
- **Runner lists:** the label lists duplicated in `local-baselines.mjs`, `local-switch.mjs` and `session-control.mjs`.
- **Smoke:** `noStaleLabel` and `RECONNECT_LABEL`.

**Look for more:**
- `useRecoveryNotice`'s `runtimeRecovering` argument, once only GatewayController calls it;
- `session.recovering` readers other than succession;
- the `fixture-synchronizing` hook of the workbench fixture, if no spec still needs it;
- `SessionConversation`'s `synchronizingOverdue` notice (a 30 s locator wait). It says "synchronizing" only through the alert that replaces Opening; keep it if it is a business failure ("could not find this session"), otherwise reword it.

**Kept, with the reason:**
- `RemoteSessionStatus` and its six values: L3 (Trace, Replica Inspector), succession and the upload guards read them.
- The per-session restart and pause loop: removed in P2 for journal-served sessions.
- `AgentSessionSettings`' "Connection" row (Reconnecting, Restoring): an L2 detail that the user opens.
- The `access-page.ts` words in `agent-relay-core`: sign-in, not a session (Open question 4).

**Record:** in this plan's section 10, the measured accounting against section 5, the production line delta, and an old-test to new-test mapping for every deleted test.

**Commands:**
```bash
pnpm verify:changed
pnpm arch:check
pnpm compatibility:update && pnpm compatibility:check
```

### Task 10. Acceptance and local verification

Sections 8 and 9. Then:
- the roadmap's Progress row for I1;
- the Orchard design's I1 status;
- this plan's results;
- the full `pnpm verify`.

## 8. Acceptance

**Deterministic** (all must pass):
- R1 to R5 in `session-presentation.test.ts`, including the product test over every combination.
- Task 3's wire-order test.
- E9's two flows: no T5 word in any frame, "Sending" before release, and delivered exactly once.
- `noSessionConnectionLabel` passes in `pnpm smoke:quick` on the instance.
- `pnpm test:components`, `pnpm test:preview-browser`, `pnpm test:e2e:flows`, `pnpm test:e2e` and `pnpm verify` are green. Slow-test reporter: no new entry.

**Measured** (runner `packages/agent-remote-lab/performance/session-control.mjs`, Copilot session with journals and smart reading on, against the Task 0 control arm). Commands:

```bash
for c in "1 0" "4 0" "1 100" "4 100"; do set -- $c
  node packages/agent-remote-lab/performance/session-control.mjs --label i1 --throttle $1 --rtt $2 --opens 10 --sends 3 --type-during-open --out .tmp/i1-$1x-$2ms.json
done
```

| Counted or timed | Target (4x CPU and 100 ms round trip unless stated) |
|---|---|
| Opens whose frames show a T5 word (`connectionWords`), 10 per condition, 4 conditions | 0 |
| Opens where the editor was not editable at first paint of the composer | 0 |
| Typed during open: key press to "Sending" (`sendingMs`) | p95 at most 100 ms |
| Typed during open: delivered (`acknowledgedMs`) | recorded against the control arm; within 1 s (p95) of control granted for a resident session (T4) |
| Focus kept and text typed after Enter kept | 30 of 30 |
| `negotiated` to control granted | not worse than control arm (S5: 208 / 226 ms at 4x and 100 ms) |

## 9. Verification on `pnpm local`

Follow `.agents/skills/prepare-arc-local/SKILL.md`:
- check the running instance's own sessions before `up`;
- use `agent-remote-controller-dev` only;
- use one headless context per script;
- use no polling of `status`.

1. `ARC_LOCAL_JOURNALS=1 pnpm local up`; `agent-remote-controller-dev --build-info` names this worktree's commit.
2. Create a Copilot session in the instance workspace with one real turn (`agent-remote-controller-dev session create …`, then `session send`).
3. Run the runner (section 8). Then capture the page's frames:
   ```bash
   pnpm local screenshot '/?host=HOST&provider=copilot&session=ID' --out .tmp/local/i1-open.png
   pnpm local screenshot '/?host=HOST&provider=copilot&session=ID' --out .tmp/local/i1-open-phone.png --viewport 390x844
   ```
   Also run a `.tmp/local/i1-type-during-open.mjs` script (browser reference, "Scripted interaction"). It opens the session at 4x CPU, types during open, and saves a screenshot at "Sending" and one after delivery.
4. Check Bot mode (`/?mode=bot`, `--wait-for 'main.lab-bot-workspace'`): no T5 word; the composer is enabled while opening.
5. Release Codex sessions if any were created. Report in the skill's format (Build, Site, Controller, Page, Feature, Model turn), with the screenshots and what they show.
6. The owner reviews on `pnpm local` before merge (Orchard acceptance).

## 10. Results

To be filled by Task 9 and Task 10: accounting against section 5, runner tables for both arms, suites, and the `pnpm local` report.

### Task 0: one word list and the control arm

**State accounting.** Product: 0. Test support: `connection-words.mjs` (+1 list, +1 pattern, +1 function). The runners: `local-switch.mjs` and `local-baselines.mjs` lose their own lists (the S4b `OPENING_WORDS`); T1's `OPENING_LABELS` subset stays, so its counts compare with P0. `session-control.mjs` loses its Restoring and Checking access regexes and gains `--type-during-open` and `--session`.

**Runner changes found while measuring** (method, not product):
- The link opens the session in the instance's Window, which docks other sessions beside it. The runner types into, and reads the pane status of, the selected primary group (`.lab-primary-group[data-selected]`); the page's toasts, app bar status and device banner are read anywhere. It waits for an editable editor in that pane: the shell painted before the Window loads has its own editor, which is replaced.
- The prompt carries the run and the open's ordinal, so its delivered row is told apart from the history's identical prompts.
- A key with no sending mark within 5 s counts as refused (`enterRefused`); that open has no delivery times.
- It reads the instance's Copilot sessions with `session list --provider copilot` (the unfiltered list's first 50 had none).

**Control arm.** Build `c1f1954e` (dirty only in the runners), journals on, smart reading on for Copilot, a fresh Copilot session with one real turn (`…/copilot/6c58098e`), 10 opens and 3 two-send views per condition; raw data in `.tmp/i1-control-*.json`. Times are p50 / p95 in ms; opens with a T5 word count every open of the condition.

| Condition | Opens with a T5 word | Words seen (opens) | Editor editable from load | Key to sending | Key to acknowledged | Key to delivered | Enter refused | Focus kept / text kept | `negotiated` to grant |
|---|---|---|---|---|---|---|---|---|---|
| 1x, 0 ms | 1 / 10 | Opening session 1, Synchronizing 1, Start with a Provider 1 | 200 / 266 | 20 / 47 | 40 / 67 | 103 / 128 | 0 | 10 / 10 | 28 / 71 |
| 4x, 0 ms | 1 / 10 | Opening session 1, Synchronizing 1, Start with a Provider 1 | 867 / 1021 | 92 / 112 | 140 / 158 | 304 / 325 | 0 | 10 / 10 | 78 / 81 |
| 1x, 100 ms | 6 / 10 | Opening session 6, Synchronizing 1, Start with a Provider 1 | 1030 / 1357 | 27 / 36 (n=6) | 148 / 156 (n=6) | 208 / 215 (n=6) | 4 | 4 / 4 (the refused opens) | 109 / 120 |
| 4x, 100 ms | 10 / 10 | Opening session 10, Synchronizing 1, Start with a Provider 1 | 1604 / 1970 | 106 / 181 | 260 / 317 | 358 / 427 | 0 | 0 / 0 | 118 / 131 |

What the control arm shows:
- The first open of each condition, in a fresh browser context, shows Start with a Provider, Opening session and Synchronizing. Later opens paint the rows this device stored and hide the opening words at 0 ms, but not at 100 ms: Opening session shows in 6 of 10 and 10 of 10 opens.
- The editor is editable (`contenteditable`) while Opening session shows, but Enter is refused until the session is ready: 4 of 10 opens at 1x and 100 ms. The other opens pressed Enter after `ready`, because the editor became editable late.
- At 100 ms every accepted send lost the editor's focus within 50 ms of Enter, and the text typed after it went nowhere: 6 of 6 at 1x, 10 of 10 at 4x. At 0 ms none did. Only the refused opens kept focus, because nothing was sent. Task 4's focus test and E9 cover this.
- The two-send views, for comparison with S5: first send sending 31 / 35, 105 / 110, 38 / 50, 199 / 223; acknowledged 53 / 60, 154 / 155, 159 / 175, 349 / 373 (same condition order).

### Task 1: the rule module

**State accounting.** `session-presentation.ts`: +0 state; +4 functions (`sessionNotice`, `sessionNoticeWords`, `composerAvailability`, `sessionActivityLabel`), +1 optional fact (`SessionFacts.replica`, for failure words only). No view reads it yet, so the three label chains are still three (Tasks 4 and 5 take them to one). Test support: `session-presentation-vectors.ts` (28 rows, the builders `buildPresentationReplica` and `buildSessionFacts`, the T5 copy).

**Deviations, with the reason.**
- `SessionFacts` gains `replica`: the `failed` and `unavailable` notices carry the runtime failure and the refusal reason, which `RemoteSessionState` does not hold.
- `sessionActivityLabel` is undefined for connection `unavailable`: a refused session has no activity to report, and its notice says why.
- A non-recoverable diagnostic while connecting gives the `unavailable` notice (today's "Connection failed") but leaves the composer enabled, as R2 says: diagnostics are not cleared on reconnect, so disabling on them could block a recovered session.
- R3 reads `send_message.allowed` alone (section 4.1, R3).

**Tests.** `session-presentation.test.ts`: 36 tests, 1,800 combinations in the R1 product (six connections, four leases, three runtimes, five activities, three Hosts, restored or not), about 50 ms of test time. Mutations checked: dropping the Host-offline notice, the agent-unavailable notice, or turning Working into a connection word each fail tests.

### Task 2: device link

**State accounting.** `SessionChannelPool`: +2 fields (`link`, `linkListeners`), +3 methods (`relayLink`, `subscribeRelayLink`, `setLink`), +0 recovery paths: the link only observes the activity channel's ready, failure and open deadline. `relay-link.ts` (new, pure): +1 function. `HttpWebSocketTransport` and `RemoteAgentTransport`: +2 forwarding methods (optional on the interface). Lab: +1 context (`RelayLinkReport`), GatewayController +1 input (channel link) and +1 input (the browser's `online` and `offline` events, which `RelayLinkFacts.browserOnline` names), the banner's words "Reconnecting…" become "Offline. Messages will be sent when this device is back online."; no new timer: the banner keeps `useRecoveryNotice`'s 5 s grace.

**Tests.** `relay-link.test.ts` 7, `session-channel-transport.test.ts` 4 (fake sockets, fake timers), `GatewayController.test.tsx` +2 (27 in the file). The pool's deadline test advances the 20 s open deadline with fake timers.

**Not yet seen by the page.** The browser specs that read `.gateway-recovery` (`e2e/seamless-access.spec.ts`) only check that it is hidden; Task 7 runs them.

### Task 3: the control check alongside the subscription

**State accounting.** 0 fields, 0 paths: no product change. Section 3's finding holds.

**Test.** The existing test "requests control before socket history so slow history cannot block ownership acquisition" already drove this flight and only checked that control preceded the tail. It is renamed to the plan's name and now asserts the exact order before any reply (`negotiate`, `timeline_subscription`, `session_control_request`, `timeline_request`), answers the tail first, stays `catching_up`, and turns `ready` on a granted `control`. A new test would have asserted the same rule twice. Mutation: deferring `beginSocketRecovery` behind `controlReady` fails it, and only it, of the 109 tests in the file.

### Task 4: React shells read the rules

**State accounting.** `AgentActivityStatus`: props -2 (`disabled`, `disabledLabel`), +1 (`host`); locals -5 (`disabled`, `unavailable`, `runtimeConnection`, `connectionLabel`, `connectionWordHidden`), +2 (`facts`, `notice`); label branches 15 to 0 (`sessionActivityLabel`). `AgentComposer`: props -3 (`disabled`, `disabledLabel`, `recovering`), +1 (`host`), `sessionState` required; the `'connecting'` default and `runtimeConnectionMessage` deleted; locals -4 (`controlChecking`, `runtimeConnection`, `runtimeUnavailable`, `terminal`), +4 (`availability`, `dispatch`, `sendNow`, `blocked`); the restored-replica draft-only rule deleted. `PendingSendQueue`: a waiting item says "Sending". `AgentSessionSettings` gets `disabled={false}`: its own `synchronized` and operation checks decide (its `disabled` prop goes in Task 9).

**Tests.** `agent-client-web` 655 (was 600), 8.4 s for the package. New: the vector rows through `AgentActivityStatus` (28) and the composer (28); "takes a message typed before the first Snapshot, says Sending at once, keeps focus, and sends it once when the session is ready"; the restored-replica send. Rewritten to rows: the pending suite's setup (`connection` instead of `disabled`/`recovering`), "waits for confirmed control, and keeps a waiting message while a terminal takes the session", the runtime-unavailable case (sends wait, decision 1). Seam S6: "takes a send over a restored replica, shows it as Sending, and sends it only after the first server page confirms the state"; `seams.md` S6 updated. Every composer render in the client-web and lab tests passes `sessionState` (a mechanical change: `remoteSessionState(state, 'ready')`, or `'connecting'` where the test passed `disabled`).

### Task 5: lab reads the rules

**State accounting.** `SessionWorkbench`: locals -9 (`connectionFailure`, `agentFailure`, `runtimeNotice`, `runtimeError`, `recoveryNoticeDue`, `rowsHeld`, `nativeLabel`, the `activityLabel` chain, `isAttaching`), +5 (`facts`, `notice`, `timelineNotice`, `hasTarget`, `hostNotice`); notes 4 to 1; the "Session runtime" toast and `reconnectingNotice` deleted; +1 prop (`host`). `useHostAndStack`: the label chain becomes notice words or the activity label; `helpers.ts` -1 function (`sessionStatusLabel`). `SessionControlNotice`: handoff words 3 to 1 ("Taking control…"). `lease-view.ts`: `leaseNoticeLabel` loses its `checking` case (its type excludes it). `ProviderSessionControls`: "Creating session…". `SessionConversation`: +1 derived flag (`opening`), passes `host`.

**Tests.** `agent-remote-lab` 3,279 (was 3,283: eight toast tests deleted, four added), 67 to 85 s for the package. New in `SessionWorkbench.test.tsx`: no T5 word in the heading, notes or toasts through catching up, checking and a lost link; the composer dock and an enabled editor before the first Snapshot with a target, the empty state only without one; an offline Host said once. Rewritten: `LabWorkbench.test.tsx` label rows (business labels), the runtime-recovery rows (no heading word, one note for an unavailable agent, the send waits), the failure notes (the failure's own words), the handoff phases; `App.test.tsx` and `App.host-providers.test.tsx` app bar labels; the succession take-over words; `SideConversation`; the capacity test becomes "keeps a stream capacity refusal and a pause out of the conversation".

**Deleted tests, with the reason.** `LabWorkbench.recovery.test.tsx` loses the eight tests of the "Session runtime" toast's 5 s debounce (short disconnects, the deadline through retries, foreground time after visibility and page suspension, session switches and hidden panels, the restoring runtime, background time, unmount): the toast itself is deleted by this task, so no rule remains for them to guard. One test replaces them: "raises no toast and shows no connection word through disconnects, retries, catch-up and a recovering runtime". The debounce rule lives on in `useRecoveryNotice` for the device banner, covered by `GatewayController.test.tsx`. The mapping table for Task 9 starts here.

### Task 6, the coordinator's points and the review of Tasks 0 to 5

**What changed, and why the plan's "measure first" was not followed.** The coordinator required two fixes regardless of the figure: the editor must keep its focus and content during a direct send, and a lost Relay link must not block sending. The plan's candidate fixes the first, so it was built before the measurement.
- **One send path for text.** Every plain-text send goes through the composer's queue, now or later. The editor clears at once, is never disabled under a send, and keeps its focus and what is typed meanwhile. A dispatched message is the conversation's outgoing row, so the chip leaves: one Sending, never two. Image and resource sends keep the retained direct path; the retention tests moved to them, and their two text-only cases (newer edit, text ABA) were deleted because a queued text send snapshots its text.
- **A lost link never blocks.** `WorkspaceReady` false and a lost live connection no longer set `mutationBlocked`. A view reopening its session takes sends that wait.
- **A message that cannot go.** A waiting message the session cannot take (ended, failed, refused, read-only, a native owner, an unopened view) says Not sent with Retry and Cancel, and is never sent unasked. A send the session refused with a code that means it never took it (`native_session_owned`, `session_read_only`, `session_control_changed`, `host_offline`, `host_unavailable`, `controller_offline`) is Not sent with Retry. Any other failure after dispatch is Check delivery.

**Review fixes.** (1) Only a refusal for good is an `unavailable` notice; the R1 product now carries a stale non-recoverable diagnostic in every combination. (2) As above. (3) The link is `unknown` once nobody watches the activity channel. (4) "Reconnect to take control" and "Reconnect before sending" are waits; the T5 list gains "Reconnect" (nine words), and the other session-level "Reconnect …" words were reworded. (5) The app bar says the activity label only; the notice is said once, by the conversation. (6) The banner's Retry reopens the activity channel now (`reopenRelayLink`). (7) One list: `agent-client/testing` (`connection-words.ts`), re-exported by `agent-e2e/faults/connection-words.mjs`; tests import the pattern. (8) `data-notice` and `agent-state-notice`.

**State accounting.** `AgentComposer`: the direct text branch is unused for text (one send path); +1 effect (hold). `usePendingSend`: +1 method (`hold`), +1 item field (`held`). `SessionChannelPool`: +1 method (`reopenRelayLink`), +0 fields. `RelayLinkReport`: a reporter object (+1 callback). `useHostAndStack`: the notice branch removed. `session-presentation`: -1 branch.

### Task 7

Component and browser specs, the refusals spec, `toast-placement` (a refused send's error toast replaces the deleted runtime toast), `workbench.spec.ts` and the smoke invariant `noSessionConnectionLabel`. The changed specs run at 390x844 in the component config's `chromium-mobile` and WebKit mobile projects. Results: `pnpm test:components` 454 passed and 6 failed under load, the 6 passing on rerun; `pnpm test:preview-browser` 73 of 73; `live-cache-browser` 1 of 1; `specs/workbench.spec.ts` 9 passed, 2 skipped (`node scripts/run-tests.mjs e2e specs/workbench.spec.ts`; `pnpm test:e2e -- …` runs the whole suite); `agent-e2e` unit 123 of 123.

### Task 8

`flows/e9-quiet-open.e2e.ts`, `PageOptions.hold: 'agent_snapshot'`, `PageOptions.mobile`, `watchWords`. Both tests run at desktop and at 390x844 with touch emulation, and `E2E_BROWSER=webkit` runs them in WebKit (`launchBrowser()` in `flows/browser.ts`; the mobile WebKit run at 390x844 passed). E4's refused text is now the queue chip, "Not sent" or "Check delivery" by whether the page already knew a terminal owned the session.

**The remount, found and fixed.** The first editable composer is a stand-in pane that `SessionDocks` renders while the Window loads (`ConversationPane` to `LabWorkbench`); about 100 ms later the Window renders the conversation through `SessionFamily`, `SessionConversationMount` and `SessionConversation`, a different component path, so React mounted a second composer and the first one's text, queued message and focus were lost (E9 failed in about half the whole-file runs). Two defects, both fixed in the composer:
- **State followed the instance.** The draft (`drafts`) and the waiting queue (`usePendingSend`) were per composer instance. They are now shared by `[draftScope, sessionKey]` (`shared-by-key.ts`): the composer that replaces another one in the same commit finds both, an entry is dropped once no composer holds it (after the commit), and the first composer to claim a queued message owns it, so two composers for one session never send it twice. A queued message is plain data (`PendingMessage`); the composer that is mounted delivers it through its own `ready` and `send`. The focus: a composer unmounted while it had focus hands it to the one that replaces it, with the caret after the text, retrying for 2 s while the editor is still disabled (`FOCUS_HANDOVER_MS`).
- **The stand-in ignored Enter.** It is draft-only, and a draft-only composer returned from `run('send')`, so the typed message stayed in the editor and was never queued. The stand-in now passes `opening` (`SessionDocks`, no Window and Windows available), and a draft-only composer that is `opening` takes a plain message into the queue as Sending; a draft-only view that is not `opening` still holds it as Not sent.

Not done: mounting the stand-in in the Window's slot (`SessionConversationMount` with the Window's slot id). The stand-in renders `LabWorkbench` directly, and the Window path renders it through `SessionConversation`, so one instance would need `SessionConversation` to serve both; the keyed state makes the second mount harmless instead.

State accounting: `AgentComposer` props +1 (`opening`), the per-instance `drafts` ref and the `usePendingSend` instance map removed, one module-level draft store and one queue store (`SharedByKey`, 20 lines) added; `usePendingSend` takes an executor (`ready`, `send`) and queued items carry a payload instead of closures. `SessionWorkbench` props +1 (`opening`). Tests: `AgentComposer.handoff.test.tsx` (5: text, queue and focus survive a replacement; no focus taken when the old composer had none; two composers send once; entries are dropped when the last one unmounts; a stand-in that is opening queues as Sending), `SessionWorkbench.test.tsx` (the stand-in replaced by the Window pane keeps text, Sending item and focus, and sends once when ready). E9: 14 of 14 whole-file runs (desktop and 390x844) after the fix, against about 6 of 12 before.

### Task 9

**Deleted.** `RemoteSessionState.holdingRows` and `holdsUnconfirmedRows`; `leaseActivityLabel`; `useRecoveryNotice`'s status and runtime arguments (only the device banner calls it); `sessionStatusLabel`; the runtime words, the Session runtime toast, `reconnectingNotice`, the capacity and pause notes; `noStaleLabel` and `RECONNECT_LABEL`; the locator's "still synchronizing" alert (now "not confirmed yet").

**Kept, with the reason.** `RemoteSessionStatus` and `session.recovering` (L3, succession, quotes); the per-session restart and pause loop (P2); `AgentSessionSettings`' Connection row and its `disabled` prop (an L2 panel; the composer passes `false`; removing the prop rewrites seven settings tests, left for P2); `access-page.ts` words (decision 4); `local-baselines.mjs`'s T1 subset (`OPENING_LABELS`), so T1 compares with P0; the `fixture-synchronizing` hook (`workbench.spec.ts` still drives it).

**Old test to new test.**
| Old | New owner | Mutations it caught |
|---|---|---|
| `LabWorkbench.recovery` toast debounce (8) | deleted with the toast; "raises no toast and shows no connection word …" | the toast's delay, which no longer exists |
| `session-state.test` "holds rows …" | vector rows "restored idle, connecting", "restored running turn, catching up, checking" | label from stored status |
| `lease-view.test` activity column | vector rows 7 and "another Controller has control" | native owner words |
| retention "newer edit", "text ABA" | `AgentComposer.test` "sends a message at once through the queue …" | text-only retained send, replaced by the queue |

### Task 10: I1 arm against the control arm

Build `563fee30`, the same Copilot session, journals and smart reading on, 10 opens and 3 two-send views per condition; raw data in `.tmp/i1-*.json`. Times p50 / p95 in ms from the key press. Control first, I1 second.

| Condition | Opens with a T5 word | Editable from load | Key to Sending | Key to acknowledged | Key to delivered | Enter refused | Focus / text kept | `negotiated` to grant |
|---|---|---|---|---|---|---|---|---|
| 1x, 0 ms | 1 → 0 | 200/266 → 230/252 | 20/47 → 12/13 | 40/67 → 31/4104 (one outlier) | 103/128 → 111/7638 (same) | 0 → 0 | 10/10 → 10/10 | 28/71 → 30/33 |
| 4x, 0 ms | 1 → 0 | 867/1021 → 852/877 | 92/112 → 47/51 | 140/158 → 98/111 | 304/325 → 165/177 | 0 → 0 | 10/10 → 10/10 | 78/81 → 72/97 |
| 1x, 100 ms | 6 → 0 | 1030/1357 → 635/1410 | 27/36 (n=6) → 10/11 | 148/156 (n=6) → 236/243 | 208/215 (n=6) → 304/310 | 4 → 0 | 4/4 → 10/10 | 109/120 → 122/130 |
| 4x, 100 ms | 10 → 0 | 1604/1970 → 1420/1614 | 106/181 → 49/55 | 260/317 → 234/267 | 358/427 → 316/337 | 0 → 0 | 0/0 → 10/10 | 118/131 → 114/122 |

Against section 8: no open shows a T5 word (0 of 40); the editor was editable at the composer's first paint in every open; Sending p95 at 4x and 100 ms is 55 ms (target 100; Task 6's candidate needed no second change); focus and later text kept 40 of 40; the grant time is not worse. At 1x and 100 ms acknowledgement is slower than control because the control arm's six measured sends were typed after the session was ready, while every I1 send was typed during the open and waited for it. The runner types into the Window's pane, so it does not see E9's stand-in swap (Task 8).

**Not done in this step.** `pnpm local` verification steps 3 to 5 beyond the runner (screenshots, the Bot mode check), and the owner's review. No Codex session was created.

## 11. Decisions (2026-11-20)

The owner asked for autonomous progress on the approved Orchard design. These answers follow its decisions 4 and 5:

1. **Runtime unavailable.** The composer stays enabled. A notice names the problem once ("The agent is not available on <Host>"), and sends wait.
2. **Settings before ready.** They are non-interactive without a label and are not queued. Queuing them belongs to P2.
3. **Commands, skills, files and next-turn queueing.** These are accepted only at `now`. Plain text and images wait.
4. **Sign-in page words.** They are out of I1. The I4 brand pass rewords the access page.
5. **Capacity and paused sessions.** They show in L3 only.
6. **100 ms at 4x CPU.** Measure after Task 6. If it still misses, record the figure, and the rendering change moves to I3's timeline.
7. **"Sending" with its age.** This belongs to P2.
8. **Crude-mode sessions.** The same rule applies to every session, with no mode branch.
