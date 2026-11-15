# P1-C1 Controller publisher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Controller publishes the sessions of journal-capable providers to their journals on the Relay, provider-agnostic and proven with a fake provider over the real uplink and the real hosted Relay. It opens each session's journal, reconciles it with its own timeline before any live row, publishes batched live rows, completions, amendments and the head one acknowledged message at a time, answers the Relay's fill and older-history requests, recovers from refusals by opening again, and takes a journal out of serving when it can no longer keep it current. It asks for `journal=2` only when some provider declares the capability, and no provider does until P1-C2.

**Architecture:** The provider SDK gains optional item identity on observations and a capability an adapter declares. The agent manager, which already turns observations into one ordered list of rows, carries that identity on its rows and can be followed by a tap that is not a viewer. A settled resource gets an id that is stable across restarts. The journal wire, core and hosted Relay gain what the publisher needs: open items and corrections, in-place amendments, late rows to evicted tools and todo lists, an attention item that the journal turns into a cursor in its own epoch, unserving, refusals, and an open without an index. All of it sits behind grant 2. In `agent-host`, two pure modules turn rows into items and compare them with the Relay's item index (`planPublication`); a state machine per session and a connection-level publisher run the protocol. The uplink client in `agent-remote-relay` only carries the messages, because the Controller depends on the journal package and the Relay's client must not.

**Tech Stack:** TypeScript 5.7/5.9 (ES2022, Node16 modules, strict, `noUncheckedIndexedAccess`), TypeBox through `@orchardworks/agent-remote-protocol`, Vitest 4.1.11, pnpm workspace, `ws` for the real-transport tests.

**Design reference:** `docs/superpowers/specs/2026-11-15-im-session-service-design.md` (Session journal, Compatibility and rollout, Failure handling, Measurement and testing) and the P1-C notes of `docs/superpowers/plans/2026-11-15-im-session-service-roadmap.md`. Predecessors, which must have landed completely: `2026-11-15-p1a-journal-core.md`, `2026-11-15-p1b1-relay-journal-service.md`, `2026-11-15-p1b2-journal-served-sessions.md` and `2026-11-15-p1b3a-journal-storage.md` (the bounded service with `unserve`, `served`, `indexPage`, `index_too_large`, `quota_exceeded`, the `incomplete` refusal of a head, `quotaFenced` per generation, and the connection adapter's `published` hook that reports `unserved`). Every edit below names the text of the landed code it expects.

**Commands.** Every test command sets a per-test deadline (`--testTimeout`). Run each with an outer deadline: the Bash tool `timeout` of at most 300000 ms. Packages import each other from `dist`, so rebuild a package before running tests of its dependents; each task says when. Web and lab tests run on Node 22 like CI (Node 26 breaks jsdom): prefix them with `PATH=/opt/homebrew/opt/node@22/bin:$PATH`. All work happens in the worktree `/Users/xian/projects/agent-remote-control/.worktrees/im-session-service`. Each task leaves the repository green: no task changes a signature without changing its callers and their tests in the same task.

## Decisions

1. **The publisher computes digests.** There is one merge function, the journal's own (`mergeRowIntoEntry`), and the digest must be taken over what it produces; and adapters stay out of Relay state: they say what only they know (the native key, whether an observation finishes the item, whether history cannot rebuild it) and nothing about how a journal stores or compares. A reread and a live run have one digest exactly when their merged content is equal, which the continuity fixture proves.
2. **The reread is the agent manager's timeline.** The publisher never opens a runtime or calls an adapter. On every open it groups the manager's rows into items, and it reads older history through the manager (`loadOlderHistory`). A read-only history capability for sessions without a manager is P1-C3.
3. **An open item gets a correction without a digest.** `replace` and `prepend` items may omit the digest for open items, so a journal keeps them open; marking a partial item complete would let a later reread, which lacks it, look like a genuine rewrite. A fill still needs a digest.
4. **An empty journal first gets a `replace`** of the newest items that fit one message. Older items follow as a prepend after reopening. A genuine rewrite is published the same way.
5. **Flow control.**
   - One message is in flight per session; the next waits for the Relay's acknowledgement, the durability signal.
   - All sessions of a connection share a budget of 64 messages and 16 MiB in flight.
   - A `journal_fill` answer reserves budget from the same pool.
   - At most four sessions open at a time, and a session releases its slot once it has read the index.
   - A head goes before queued prepends, which can be long.
   - Messages are cut at 4 MiB and 256 entries, measured as the uplink encodes them.
6. **Failures.**
   - A per-item refusal (`unknown_item`, `body_missing`, `type_changed`, `duplicate_item`, `invalid`) skips that item. A refused entry never consumes its sequence, so the publisher renumbers the entries that follow it, starting at the refused sequence; entries it had already sent after it were refused as `sequence_gap` and are sent again under their new numbers. A refusal that names no item, and a `sequence_gap` that follows no per-item refusal, reopen the session.
   - Any other failure (a `stale_revision` included), a missing acknowledgement after 30 seconds, a held-event overflow and a lost connection reopen the session with exponential backoff (250 ms up to 30 s), which resets only after a minute of sustained publishing.
   - Quota windows are 2,000, 200 and 20 items; `forceReplace` clears when the replacement is acknowledged; a refusal of the narrowest window stops the session.
   - `incomplete` forces a replacement without narrowing the window, then the head; a Relay that keeps saying it ends the session. Three replacements in a row (not counting forced ones) also end it.
7. **The attention cursor travels as an item key.** The head names `attentionItemKey`; the journal translates it into `{ epoch, seq }` of that item, or its latest cursor when none is named. The Controller cannot know the journal's epoch.
8. **Amendments are `outcome` and `rebind`.** `outcome` (stored; from `background_activity_updated`) and `rebind` (stored; a resource-binding replacement) are applied in place and sent to journal-served clients as the frames the session wire sends today. There are no `event` entries: heads carry what `turn_*`, `usage_updated` and `runtime_updated` change, and `runtime_updated` published as an event would undo the Relay's `restoring` override.
9. **The Relay holds interaction frames until the served head agrees.** A Controller's `interaction_requested`, `interaction_resolved` and `interaction_invalidated` frames wait for the head last sent to that browser (at most 2 seconds, at most 64 frames), because a head that arrives later through the journal would otherwise drop a new question or bring back a resolved one.
10. **The grant is versioned and enforced per connection.** The Controller asks for `journal=1` or `journal=2`. The broker acknowledges `registered.journal: 2` only when the Controller asked for 2 and `HostJournals.capabilities(hostId)` reports 2 (landed in P1-B3b); it acknowledges 1 when the Controller asked for 1, and when it asked for 2 of a service that reports only 1. A connection granted 1 that sends an entry or message that needs grant 2 (`rebind`, `outcome`, a `correct` without a digest, a `replace` or `prepend` item without one, a head with `attentionItemKey`, `journal_unserve`, `journal_request_refused`) is closed with 1008: that is a protocol violation, and refusing it entry by entry would loop. A Relay that grants only 1 gets no journal publishing from this Controller; no released Controller asks for 1.
11. **`journal_unserve { sessionKey, generation }` is sent on every terminal stop** (the journal cannot be opened for good, the head cannot be put on the wire, the quota is exhausted, replacements loop, the Relay keeps calling the journal incomplete). `generation` is required; the Relay ignores an older one and closes the session's journal-served streams so their clients read through the Controller. A refused open needs no unserve: the Relay already unserves on `index_too_large` and drops the opened state on any refused open.
12. **`journal_request_refused` answers fill and older-history requests** for sessions the publisher does not follow (`not_followed`) or has not opened yet (`not_ready`), so the Relay rejects them at once instead of at its 15 second deadline.
13. **Resource ids are stable.** A settled resource gets an HMAC-SHA-256 id under a secret persisted in the Controller's state directory, from its agent, locator and content, so a journal row's binding still names a readable resource after a restart.
14. **The core accepts appends to evicted `tool_call` and `todo` items**, whose rows replace the item's content; the item becomes resident and open, keeping its resources, collapse marks, time and background. It does not accept them for `compaction`: that merge spreads fields, so a late row would lose the fields it omits and break the digest.
15. **A reset open is the way out of an oversized index.** At 100,000 items `open` refuses with `index_too_large` and takes the session out of serving, so the publisher could never replace the journal. The publisher then opens again with `reset: true`: the Relay claims the journal without its index, clears its head, marks it incomplete, and refuses every entry except a first `replace` that fits (the head follows only after it) until one is stored. Serving resumes as it does after a quota refusal.
16. **The Controller advertises diagnostic delivery version 4.** Journal diagnostics (`journal_open_refused`, `journal_publication_refused`, `journal_row_rejected`, `journal_message_unencodable`, `journal_session_restarted`, `journal_replacement_published`, `journal_quota_window`, `journal_session_stopped`, `journal_session_unserved`) carry the provider id and at most a short reason, never content; the Relay's journal events (`journal_store_failed`, `journal_fanout_failed`, `journal_quota_exceeded`, `journal_live_only_dropped`) join the delivered set.
17. **A missing identity is a contract breach.** A journal-capable provider's observation without `itemIdentity` (a timeline observation, or an `interaction_resolved` one), or one whose key starts with `controller:`, is a defect of the adapter, not something the Controller papers over. The agent manager tells its journal tap (`identityMissing`); the publisher stops the session with `journal_session_stopped` (reason `identity_missing`, provider id only), sends `journal_unserve`, and publishes nothing more of it until the next connection. The `controller:` key prefix is reserved for items the Controller makes itself; a provider-supplied key never starts with it. Adapters set `completes` on history observations themselves, interaction items included; the Controller never infers completion.

Also decided here: taps are not viewers (the publisher follows the manager through `subscribeJournal`, which does not count in `canReleaseIdle`; an idle session is released after what is queued has been published); the `alias` entry exists but the operation queue of P2 produces it; and the Controller bundle includes the pure-TypeScript journal package (`scripts/build-agent-host.mjs` bundles every workspace dependency; it uses `crypto.subtle`, global in Node 22), so no native module or `node:sqlite` enters the Controller.

### The non-timeline events the session wire sends, and how they reach journal-served clients

| Source (manager event) | What the session wire sends today | Journal-served path before this plan | After this plan |
|---|---|---|---|
| `agent_state` | `agent_update` (the Snapshot) | From the head | The publisher publishes the head after each change; one whose pending interactions changed goes at once |
| `agent_stream` timeline row | `agent_stream` with epoch and seq | From journal rows | Unchanged; merged rows of one item |
| `agent_stream` `thread_started`, `turn_started`, `turn_completed`, `turn_failed`, `turn_canceled`, `usage_updated`, `runtime_updated` | `agent_stream` without epoch | Dropped | Not published (Decision 8): the head carries what they change |
| `agent_stream` `background_activity_updated` | `agent_stream` without epoch | Dropped | Published as `outcome`, applied in place to every item of that background, stored, and sent as the same frame; said again by every reconcile |
| `agent_stream` `interaction_*` | Not sent (the dedicated frames carry them) | n/a | Not published |
| `timeline_replacement` | `timeline_replacement` | From the `replaced` event | The publisher reconciles again after `timeline_rebuilt`; the journal replaces only on a genuine rewrite |
| `timeline_resource_binding_replaced` | `timeline_resource_binding_replaced` | Dropped (no amendment path) | Published as `rebind`, applied in place, sent with the item's epoch and sequence; settled resources get stable ids, so this fires once per resource |
| `resource_update` | `resource_update` | Forwarded from the Controller stream | Unchanged; it needs the Controller stream, like resource reads |
| `interaction_requested`, `interaction_resolved`, `interaction_invalidated` | The dedicated frames | Forwarded from the Controller stream | Forwarded once the head agrees (Decision 9) |

## File structure

| File | Responsibility |
|---|---|
| `packages/agent-provider-sdk/src/observation.ts`, `provider.ts`, `item-identity.ts`, `index.ts` | Modify and create: `ProviderItemIdentity`, `ProviderObservation.itemIdentity`, `AgentProviderAdapter.journal`, `supportsJournal`. |
| `packages/agent-remote-protocol/src/remote-host-journal.ts`, `remote-host-uplink.ts`, `remote-host-journal.test.ts` | Modify: `rebind`, `outcome`, optional digests, `attentionItemKey`, `journal_unserve`, `journal_request_refused`, `reset` on `journal_open`, grant 2, `JournalRelayMessage`. |
| `packages/agent-remote-journal/src/session-journal.ts`, `journal-amendments.test.ts`, `journal-late-rows.test.ts` | Modify and create: `rebind`, `outcome`, open corrections and items, late rows to evicted tools and todo lists, the served attention cursor. |
| `packages/agent-remote-hosted/src/host-journals.ts`, `journal-uplink.ts`, `journal-session-stream.ts`, `broker.ts` and five new tests (`host-journals-amendments`, `host-journals-reset-open`, `journal-uplink-controller-messages`, `journal-session-stream-amendments`, `broker-journal-grant`) | Modify and create: apply and fan out the new entries, unserve, request refusals, the reset open, the grant level, the held interaction frames. |
| `packages/agent-remote-relay/src/timeline-store.ts`, `timeline-projector.ts`, `agent-manager-events.ts`, `agent-manager.ts`, `session-wire.test.ts`, `agent-manager-journal.test.ts` | Modify and create: row identity, item index, the journal tap, older-history reading for the journal, the attention item. |
| `packages/agent-remote-relay/src/resources/resource-ingestor.ts`, `relay.ts`, `stable-resource-ids.test.ts` | Modify and create: stable resource ids. |
| `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts`, `remote-host-uplink-journal.test.ts` | Modify and create: the journal grant and message hand-over. |
| `packages/agent-host/src/journal-items.ts`, `journal-reconcile.ts` and tests | Create: items from rows, wire measurement, chunking, the reconcile plan. |
| `packages/agent-host/src/journal-publication.ts`, `journal-publisher.ts` and tests | Create: the state machine of one session and the connection-level publisher. |
| `packages/agent-host/src/resource-id-key.ts` and its test | Create: the secret behind stable resource ids. |
| `packages/agent-host/src/test-utils/journal-scripted-session.ts`, `journal-relay-loopback.ts`, `journal-continuity.ts` | Create: the fake provider session, the real Relay journal logic wired to a publisher, and the continuity fixture for adapters. |
| `packages/agent-host/src/host.ts`, `cli.ts`, `package.json`, `host-journal.test.ts` and edits to `host.test.ts`, `relay-diagnostics.test.ts` | Modify and create: wiring, diagnostic delivery 4, the real-transport tests. |
| `docs/blueprint/agent-remote-observation.md`, `docs/current/agent-remote/protocol.md`, `provider-onboarding.md` | Modify: contract and protocol documentation. |
| `packages/agent-remote-lab/compatibility.json` | Generated. |

Protocol fixtures: `packages/agent-remote-protocol/test/fixtures` holds only recordings of the old Team uplink shapes; the journal messages are opt-in, and their encode, decode and rejection tests (Task 2, and the real-transport tests of Tasks 4, 7, 9 and 10) are the contract. A Controller that does not ask for `journal=2` never receives a journal field.

---

### Task 1: Item identity and the journal capability in the Provider SDK

**Files:**
- Modify: `packages/agent-provider-sdk/src/observation.ts`
- Modify: `packages/agent-provider-sdk/src/provider.ts`
- Create: `packages/agent-provider-sdk/src/item-identity.ts`
- Modify: `packages/agent-provider-sdk/src/index.ts`
- Create: `packages/agent-provider-sdk/src/item-identity.test.ts`

- [x] **Step 1: Write the failing test.** Create `packages/agent-provider-sdk/src/item-identity.test.ts`:

<!-- write: packages/agent-provider-sdk/src/item-identity.test.ts -->
```ts
import { describe, expect, it } from 'vitest';

import { supportsJournal, type AgentProviderAdapter, type ProviderObservation } from './index.js';

const adapter = (journal?: AgentProviderAdapter['journal']): Pick<AgentProviderAdapter, 'journal'> => ({ ...(journal ? { journal } : {}) });

describe('the journal capability', () => {
  it('is declared only by an adapter that says so', () => {
    expect(supportsJournal(adapter())).toBe(false);
    expect(supportsJournal(adapter({ itemIdentity: 1 }))).toBe(true);
  });

  it('lets an observation carry the native identity of its item, its completion and whether history can rebuild it', () => {
    const observation: ProviderObservation = {
      type: 'observation', sourceKey: 'stream:1', occurredAt: 1, delivery: 'live',
      event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' } },
      itemIdentity: { key: 'assistant:m1', completes: true },
    };
    expect(observation.itemIdentity).toEqual({ key: 'assistant:m1', completes: true });
  });
});
```

- [x] **Step 2: Run the test and see it fail.**

Run: `pnpm --filter @orchardworks/agent-provider-sdk exec vitest run src/item-identity.test.ts --testTimeout=10000`
Expected: FAIL (`supportsJournal` is not exported).

- [x] **Step 3: Implement.** Create `packages/agent-provider-sdk/src/item-identity.ts`:

<!-- write: packages/agent-provider-sdk/src/item-identity.ts -->
```ts
/**
 * Declared by an adapter whose timeline observations all carry `itemIdentity`, and whose live and reread observations of
 * one native item agree on it. The adapter proves that with continuity fixtures. Only such adapters have their sessions
 * published to Relay journals; the others keep today's forwarding.
 */
export interface AgentJournalCapability {
  readonly itemIdentity: 1;
}

export function supportsJournal(adapter: { readonly journal?: AgentJournalCapability }): boolean {
  return adapter.journal?.itemIdentity === 1;
}
```

In `packages/agent-provider-sdk/src/observation.ts`, add the identity type above `ProviderObservation` and the field to it:

<!-- edit: packages/agent-provider-sdk/src/observation.ts -->
<!-- old -->
```ts
export interface ProviderObservation {
  type: 'observation';
  sourceKey: string;
  occurredAt: number;
  /** Monotonic for the same sourceKey within this observation stream; not a cross-process clock. */
  nativeRevision?: number;
  /** History is for presentation, never proof of current execution or a callable interaction. */
  delivery: 'history' | 'live';
  event: AgentStreamEvent;
  resourceReferences?: ProviderResourceReference[];
}
```
<!-- new -->
```ts
/**
 * The native identity of the finalized item a timeline observation belongs to. Live deltas and the rows read again from
 * native history after a reopen carry the same key for the same item, so a journal can recognize it.
 */
export interface ProviderItemIdentity {
  /** At most 4096 characters. Record, message, call or part identities of the native runtime, never a source key of a delta. */
  key: string;
  /** This observation finishes the item. A history observation completes its item unless the native record is still being written. A provider whose last live delta carries no content emits an empty body of the same item type to say so. */
  completes?: true;
  /** A reread of native history cannot reproduce this item, so the journal keeps its only copy. */
  liveOnly?: true;
}

export interface ProviderObservation {
  type: 'observation';
  sourceKey: string;
  occurredAt: number;
  /** Monotonic for the same sourceKey within this observation stream; not a cross-process clock. */
  nativeRevision?: number;
  /** History is for presentation, never proof of current execution or a callable interaction. */
  delivery: 'history' | 'live';
  event: AgentStreamEvent;
  /** Required, by an adapter that declares `AgentProviderAdapter.journal`, on every timeline observation and on every `interaction_resolved` observation, from which the agent manager builds an interaction item. */
  itemIdentity?: ProviderItemIdentity;
  resourceReferences?: ProviderResourceReference[];
}
```

In `packages/agent-provider-sdk/src/provider.ts`, declare the capability on the adapter:

<!-- edit: packages/agent-provider-sdk/src/provider.ts -->
<!-- old -->
```ts
export interface AgentProviderAdapter {
  readonly nativePrefix?: AgentNativePrefixCapability;
  readonly nativeEvidence?: AgentProviderNativeEvidence;
  readonly descriptor: AgentProviderDescriptor;
```
<!-- new -->
```ts
export interface AgentProviderAdapter {
  readonly nativePrefix?: AgentNativePrefixCapability;
  readonly nativeEvidence?: AgentProviderNativeEvidence;
  /** Present only once continuity fixtures prove that live and reread observations share item identities. */
  readonly journal?: import('./item-identity.js').AgentJournalCapability;
  readonly descriptor: AgentProviderDescriptor;
```

In `packages/agent-provider-sdk/src/index.ts`, export the module:

<!-- edit: packages/agent-provider-sdk/src/index.ts -->
<!-- old -->
```ts
export * from './native-evidence.js';
```
<!-- new -->
```ts
export * from './native-evidence.js';
export * from './item-identity.js';
```

- [x] **Step 4: Run the tests and see them pass, then typecheck and build.**

Run: `pnpm --filter @orchardworks/agent-provider-sdk run test` then `pnpm --filter @orchardworks/agent-provider-sdk run typecheck` then `pnpm --filter @orchardworks/agent-provider-sdk run build`
Expected: PASS for all.

- [x] **Step 5: Commit.**

```bash
git add packages/agent-provider-sdk/src
git commit -m "feat(sdk): let an observation carry the native identity of its item, and let an adapter declare journal support" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2: Amendments, open items, unserving and refusals in the uplink schema, and the journal grant 2

The journal gains what a Controller needs to publish:

- `rebind` (a resource binding replaced in place) and `outcome` (a background outcome applied in place);
- a `correct` entry without a digest (the item stays open), and `replace` and `prepend` items without a digest (an open item has none; a fill still needs one, so `journal_fill` keeps `CompleteItemInput`);
- `attentionItemKey` on the head, because the Controller does not know the journal's epoch and sequence;
- `journal_unserve`, with which a publisher that can no longer keep a journal current takes it out of serving;
- `journal_request_refused`, with which a Controller answers a fill or older-history request at once when it cannot serve it.

Heads already carry what the runtime events of the session wire change, so no event entry exists (see the decisions).

The new entries and messages are versioned with the grant: a Controller asks for `journal=2` and the Relay acknowledges `registered.journal: 2` only when it understands them. A Relay that grants only 1 gets no journal publishing from this Controller.

**Files:**
- Modify: `packages/agent-remote-protocol/src/remote-host-journal.ts`
- Modify: `packages/agent-remote-protocol/src/remote-host-uplink.ts`
- Modify: `packages/agent-remote-protocol/src/remote-host-journal.test.ts`
- Modify: `packages/agent-remote-hosted/src/host-journals.ts` and `host-journals.test.ts` (the guard below)

- [x] **Step 1: Write the failing tests.** In `packages/agent-remote-protocol/src/remote-host-journal.test.ts`, add a resource binding next to the other constants:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.test.ts -->
<!-- old -->
```ts
const message = (fields: Record<string, unknown>) => ({ uplinkVersion: 2, ...fields });
```
<!-- new -->
```ts
const binding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' };
const message = (fields: Record<string, unknown>) => ({ uplinkVersion: 2, ...fields });
```

Extend the publication that every operation round trips through, and the messages the Controller adds:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.test.ts -->
<!-- old -->
```ts
    { sequence: 8, op: 'head', head: { snapshot, observedAt: 1_725_000_000_000 } },
  ]),
```
<!-- new -->
```ts
    { sequence: 8, op: 'head', head: { snapshot, observedAt: 1_725_000_000_000, attentionItemKey: 'item-1' } },
    { sequence: 9, op: 'correct', row, expectedRevision: 3 },
    { sequence: 10, op: 'rebind', itemKey: 'item-1', previous: binding, replacement: { ...binding, resourceId: 'resource-2', status: 'available' } },
    { sequence: 11, op: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_000 },
    { sequence: 12, op: 'replace', items: [{ row }] },
    { sequence: 13, op: 'prepend', items: [{ row, digest: DIGEST }, { row: { ...row, itemKey: 'item-2' } }] },
  ]),
  message({ type: 'journal_unserve', sessionKey: SESSION, generation: 2 }),
  message({ type: 'journal_request_refused', requestId: 'fill-1', sessionKey: SESSION, reason: 'not_followed' }),
  message({ type: 'journal_request_refused', requestId: 'older-1', sessionKey: SESSION, reason: 'not_ready' }),
  message({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1', reset: true }),
```

Add rejections after the correction with revision zero:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.test.ts -->
<!-- old -->
```ts
    ['a correction with revision zero', publish([{ sequence: 1, op: 'correct', row, digest: DIGEST, expectedRevision: 0 }])],
```
<!-- new -->
```ts
    ['a correction with revision zero', publish([{ sequence: 1, op: 'correct', row, digest: DIGEST, expectedRevision: 0 }])],
    ['a correction without a revision', publish([{ sequence: 1, op: 'correct', row }])],
    ['a rebind without its replacement', publish([{ sequence: 1, op: 'rebind', itemKey: 'item-1', previous: binding }])],
    ['an outcome without a provider', publish([{ sequence: 1, op: 'outcome', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 }])],
    ['an outcome at a time that is no date', publish([{ sequence: 1, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 8_640_000_000_000_001 }])],
    ['a runtime event entry, which no longer exists', publish([{ sequence: 1, op: 'event', event: { type: 'turn_started', providerId: 'codex' }, occurredAt: 1 }])],
    ['a head whose attention item key is empty', publish([{ sequence: 1, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: '' } }])],
    ['a replacement item with an empty digest', publish([{ sequence: 1, op: 'replace', items: [{ row, digest: '' }] }])],
    ['a fill item without a digest', message({ type: 'journal_fill', requestId: 'f', sessionKey: SESSION, items: [{ row }] })],
    ['an unserve for generation zero', message({ type: 'journal_unserve', sessionKey: SESSION, generation: 0 })],
    ['a request refusal without a reason', message({ type: 'journal_request_refused', requestId: 'f', sessionKey: SESSION })],
    ['a request refusal with an unknown reason', message({ type: 'journal_request_refused', requestId: 'f', sessionKey: SESSION, reason: 'tired' })],
    ['an open that resets with a false flag', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION, publisherId: 'controller-1', reset: false })],
    ['an open whose reset is not a flag', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION, publisherId: 'controller-1', reset: 'yes' })],
```

Extend the test of the grant:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.test.ts -->
<!-- old -->
```ts
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, journal: 2 })).status).toBe('rejected');
```
<!-- new -->
```ts
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, journal: 2 })).status).toBe('ok');
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, journal: 3 })).status).toBe('rejected');
```

- [x] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/remote-host-journal.test.ts --testTimeout=10000`
Expected: FAIL (`rebind`, `outcome`, `journal_unserve` and `journal_request_refused` are unknown, an item needs its digest, and the grant 2 is refused).

- [x] **Step 3: Implement the schema.** In `packages/agent-remote-protocol/src/remote-host-journal.ts`, import the background schema:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
import { SafeNonNegativeInteger, SafeTimelinePosition, TimelineCursor } from './cursor.js';
```
<!-- new -->
```ts
import { BackgroundActivity } from './background-activity.js';
import { SafeNonNegativeInteger, SafeTimelinePosition, TimelineCursor } from './cursor.js';
```

The head names the item its attention cursor belongs to:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
export const JournalHead = Type.Object({ snapshot: AgentSnapshotPayload, observedAt: milliseconds }, object);
```
<!-- new -->
```ts
/**
 * The Controller's latest Snapshot. Its `attention.cursor` is stated in the Controller's own timeline, which the journal
 * does not share; `attentionItemKey` names the item that cursor points at, and the journal serves the cursor of that item
 * in its own epoch and sequence.
 */
export const JournalHead = Type.Object({ snapshot: AgentSnapshotPayload, observedAt: milliseconds, attentionItemKey: Type.Optional(itemKey) }, object);
```

A replacement and a prepend carry items with an optional digest: an item that is still open has none.

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
const items = Type.Array(CompleteItemInput, { maxItems: JOURNAL_ITEMS_PER_ENTRY_MAX });
```
<!-- new -->
```ts
/** An item of a replacement or a prepend: one row carrying its whole content, and its digest unless the item is still open. */
export const JournalItemInput = Type.Object({ row: JournalRowInput, digest: Type.Optional(digest) }, object);
export type JournalItemInput = Static<typeof JournalItemInput>;
const items = Type.Array(JournalItemInput, { maxItems: JOURNAL_ITEMS_PER_ENTRY_MAX });
```

The publication entries:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
  Type.Object({ sequence, op: Type.Literal('correct'), row: JournalRowInput, digest, expectedRevision: revision }, object),
```
<!-- new -->
```ts
  /** The item takes the row's content. With a digest it is complete; without one it stays open, as an item still streaming does. */
  Type.Object({ sequence, op: Type.Literal('correct'), row: JournalRowInput, digest: Type.Optional(digest), expectedRevision: revision }, object),
```

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
  Type.Object({ sequence, op: Type.Literal('head'), head: JournalHead }, object),
]);
```
<!-- new -->
```ts
  Type.Object({ sequence, op: Type.Literal('head'), head: JournalHead }, object),
  /** A resource binding of an item was replaced; the journal replaces it in place and tells subscribers. */
  Type.Object({ sequence, op: Type.Literal('rebind'), itemKey, previous: ResourceBinding, replacement: ResourceBinding }, object),
  /** A background outcome; the journal applies it in place to every item it concerns and tells subscribers. */
  Type.Object({ sequence, op: Type.Literal('outcome'), providerId: identity, turnId: Type.Optional(identity), background: BackgroundActivity, occurredAt: milliseconds }, object),
]);
```

The two messages of the Controller:

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
export const JournalOlderDone = Type.Object({ requestId, sessionKey, olderAvailable: Type.Boolean() }, object);
```
<!-- new -->
```ts
export const JournalOlderDone = Type.Object({ requestId, sessionKey, olderAvailable: Type.Boolean() }, object);
/**
 * The Controller can no longer keep the session's journal current, and says so: the Relay clears the journal's head, so
 * the session is read through the Controller again until a later publication sets a head. `generation` is the one the
 * Controller opened the journal with; an older one is ignored.
 */
export const JournalUnserve = Type.Object({ sessionKey, generation }, object);
export const JOURNAL_REQUEST_REFUSAL_REASONS = ['not_followed', 'not_ready'] as const;
export type JournalRequestRefusalReason = (typeof JOURNAL_REQUEST_REFUSAL_REASONS)[number];
/** The Controller cannot answer a fill or an older-history request: it does not follow the session, or has not opened its journal yet. */
export const JournalRequestRefused = Type.Object({ requestId, sessionKey, reason: Type.Union(JOURNAL_REQUEST_REFUSAL_REASONS.map(reason => Type.Literal(reason))) }, object);
```

An open can ask for no index, which is the way out of a journal whose index is too large to list (the Relay refuses such an open and can then never be asked to replace the journal):

<!-- edit: packages/agent-remote-protocol/src/remote-host-journal.ts -->
<!-- old -->
```ts
export const JournalOpen = Type.Object({ requestId, sessionKey, publisherId: identity }, object);
```
<!-- new -->
```ts
/**
 * `reset` opens the journal without its index: the Relay claims the journal, answers an empty index, and accepts nothing but
 * a replacement (and then a head) until one is stored. Only a Controller that was refused with `index_too_large` asks for it.
 */
export const JournalOpen = Type.Object({ requestId, sessionKey, publisherId: identity, reset: Type.Optional(Type.Literal(true)) }, object);
```

In `packages/agent-remote-protocol/src/remote-host-uplink.ts`, import and carry the two messages, and let `registered` acknowledge grant 2:

<!-- edit: packages/agent-remote-protocol/src/remote-host-uplink.ts -->
<!-- old -->
```ts
import { JournalAck, JournalFill, JournalFillRequest, JournalIndexPage, JournalIndexRequest, JournalOlderDone, JournalOlderRequest, JournalOpen, JournalOpened, JournalOpenRefused, JournalPublish, JournalRefused, validJournalMessage } from './remote-host-journal.js';
```
<!-- new -->
```ts
import { JournalAck, JournalFill, JournalFillRequest, JournalIndexPage, JournalIndexRequest, JournalOlderDone, JournalOlderRequest, JournalOpen, JournalOpened, JournalOpenRefused, JournalPublish, JournalRefused, JournalRequestRefused, JournalUnserve, validJournalMessage } from './remote-host-journal.js';
```

<!-- edit: packages/agent-remote-protocol/src/remote-host-uplink.ts -->
<!-- old -->
```ts
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_older_done'), ...JournalOlderDone.properties }, object),
```
<!-- new -->
```ts
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_older_done'), ...JournalOlderDone.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_unserve'), ...JournalUnserve.properties }, object),
  Type.Object({ uplinkVersion: version, type: Type.Literal('journal_request_refused'), ...JournalRequestRefused.properties }, object),
```

<!-- edit: packages/agent-remote-protocol/src/remote-host-uplink.ts -->
<!-- old -->
```ts
journal: Type.Optional(Type.Literal(1)), teamInbox:
```
<!-- new -->
```ts
journal: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])), teamInbox:
```

Name the messages the Relay sends to a Controller, for the Controller's uplink client:

<!-- edit: packages/agent-remote-protocol/src/remote-host-uplink.ts -->
<!-- old -->
```ts
export function decodeRemoteHostUplinkMessage(json: string): WireDecodeResult<RemoteHostUplinkMessage> {
```
<!-- new -->
```ts
/** The journal messages the Relay sends to a Controller that holds the journal grant. */
export type JournalRelayMessage = Extract<RemoteHostUplinkMessage,
  { type: 'journal_opened' | 'journal_index_page' | 'journal_open_refused' | 'journal_ack' | 'journal_refused' | 'journal_fill_request' | 'journal_older_request' }>;

export function decodeRemoteHostUplinkMessage(json: string): WireDecodeResult<RemoteHostUplinkMessage> {
```

- [x] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-protocol exec vitest run src/remote-host-journal.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-protocol run test` then `pnpm --filter @orchardworks/agent-remote-protocol run typecheck` then `pnpm --filter @orchardworks/agent-remote-protocol run build`
Expected: PASS for all (landed: SDK 97 tests, protocol 431). The two grants differ only in what the Controller may send: a Relay that acknowledges 2 applies `rebind`, `outcome`, open corrections, digest-less items, `attentionItemKey`, `journal_unserve` and `journal_request_refused`.

**Landed with this task, to keep `agent-remote-hosted` compiling and safe:** the schema change makes digests optional, which the hosted service's types did not allow. `host-journals.ts` gains `GrantOneEntry` and `requireGrantOneEntry`: until Task 4 applies the new entries, a publication entry that needs grant 2 (`rebind`, `outcome`, a `correct` or a `replace`/`prepend` item without a digest, a head with `attentionItemKey`) is refused as `invalid` with its sequence unconsumed (`JournalInvalidPublicationError`), so no journal stores what this Relay cannot serve. Task 4 removes the guard when it applies those entries. `broker.ts` still acknowledges `journal: 1` only, and `journal_unserve` and `journal_request_refused` are decoded but not yet handled (Task 4).

- [x] **Step 5: Commit.**

```bash
git add packages/agent-remote-protocol/src packages/agent-remote-hosted/src
git commit -m "feat(protocol): publish amendments and open items through the journal, take a session out of serving, refuse requests at once, and grant 2" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: Amendments, open items, late rows to evicted items and the attention cursor in the journal core

**Files:**
- Modify: `packages/agent-remote-journal/src/session-journal.ts`
- Modify: `packages/agent-remote-journal/src/types.ts`
- Modify: `packages/agent-remote-journal/src/replacement.ts`
- Create: `packages/agent-remote-journal/src/journal-amendments.test.ts`
- Create: `packages/agent-remote-journal/src/journal-late-rows.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `packages/agent-remote-journal/src/journal-amendments.test.ts`:

<!-- write: packages/agent-remote-journal/src/journal-amendments.test.ts -->
```ts
import type { AgentSnapshotPayload, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { openJournal, text } from './journal.test-fixture.js';

const DIGEST = 'a'.repeat(64);
const pending: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' };
const settled: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-2', status: 'available' };
const review = { id: 'review-1', kind: 'review' as const, status: 'pending' as const };

const snapshot = (attention: boolean): AgentSnapshotPayload => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
  ...(attention ? { attention: { cursor: { epoch: 'controller-epoch', seq: 99 } } } : {}),
});

function withTwoItems() {
  const fixture = openJournal();
  const { journal, publish } = fixture;
  journal.append(publish(), { ...text('a', 'a:1', 'Alpha'), resources: [pending], item: { type: 'assistant_message', text: 'Alpha', messageId: 'a', background: review } });
  journal.complete(publish(), 'a', DIGEST);
  journal.append(publish(), text('b', 'b:1', 'Beta'));
  journal.complete(publish(), 'b', DIGEST);
  return fixture;
}

describe('a correction without a digest', () => {
  it('replaces the content and leaves the item open', () => {
    const { journal, publish } = withTwoItems();
    const revision = journal.index().find(entry => entry.itemKey === 'b')!.revision;
    journal.correct(publish(), text('b', 'b:full', 'Beta, in full'), undefined, revision);
    const entry = journal.index().find(item => item.itemKey === 'b')!;
    expect(entry).toMatchObject({ state: 'open', revision: revision + 1 });
    expect(entry.digest).toBeUndefined();
    expect(journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false })).toMatchObject({
      kind: 'page', page: { payload: { entries: [{ item: { text: 'Alpha' } }, { item: { text: 'Beta, in full' } }] } },
    });
  });
});

describe('a resource binding replaced in place', () => {
  it('changes the binding of a resident item and reports the position clients know the item by', () => {
    const { journal, publish } = withTwoItems();
    const revision = journal.index()[0]!.revision;
    expect(journal.rebind(publish(), 'a', pending, settled)).toEqual({ epoch: 'epoch-1', seq: 1 });
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    expect(page).toMatchObject({ kind: 'page', page: { payload: { entries: [{ resources: [settled] }, { resources: [] }] } } });
    expect(journal.index()[0]!.revision).toBe(revision);
  });

  it('changes the binding an evicted item keeps, so it shows after the body is filled again', () => {
    const { journal, publish } = withTwoItems();
    journal.evict(0);
    expect(journal.index().map(entry => entry.resident)).toEqual([false, false]);
    journal.rebind(publish(), 'a', pending, settled);
    journal.fill('a', { item: { type: 'assistant_message', text: 'Alpha', messageId: 'a' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [pending] }, DIGEST);
    expect(journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 1 }, { olderBeyondJournal: false })).toMatchObject({ kind: 'missing' });
    journal.fill('b', { item: { type: 'assistant_message', text: 'Beta', messageId: 'b' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [] }, DIGEST);
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    expect(page).toMatchObject({ kind: 'page', page: { payload: { entries: [{ resources: [settled] }, {}] } } });
  });

  it('is a no-op for an item it does not know and for a publication it already applied', () => {
    const { journal, publish } = withTwoItems();
    const unknown = publish();
    expect(journal.rebind(unknown, 'missing', pending, settled)).toBeUndefined();
    expect(journal.publisher?.watermark).toBe(unknown.sequence);
    const again = publish();
    expect(journal.rebind(again, 'a', pending, settled)).toBeDefined();
    expect(journal.rebind(again, 'a', settled, pending)).toBeUndefined();
    expect(journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false })).toMatchObject({ page: { payload: { entries: [{ resources: [settled] }, {}] } } });
  });
});

describe('a background outcome applied in place', () => {
  it('reaches every item of that background, evicted ones included, and never regresses', () => {
    const { journal, publish } = withTwoItems();
    journal.append(publish(), { ...text('c', 'c:1', 'Gamma', 'turn-2'), item: { type: 'assistant_message', text: 'Gamma', messageId: 'c', background: { ...review, id: 'other' } } });
    journal.evict(1);
    expect(journal.index().map(entry => entry.resident)).toEqual([false, false, true]);
    expect(journal.outcome(publish(), { ...review, status: 'visible', summary: 'Found two issues.' })).toBe(true);
    expect(journal.outcome(publish(), { ...review, status: 'silent' })).toBe(true);
    journal.fill('a', { item: { type: 'assistant_message', text: 'Alpha', messageId: 'a' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [pending] }, DIGEST);
    journal.fill('b', { item: { type: 'assistant_message', text: 'Beta', messageId: 'b' }, timestamp: '2024-08-30T00:00:00.000Z', collapsed: [], resources: [] }, DIGEST);
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    if (page.kind !== 'page') throw new Error('Expected a page.');
    expect(page.page.payload.entries.map(entry => entry.item.background)).toEqual([{ ...review, status: 'visible', summary: 'Found two issues.' }, undefined, { ...review, id: 'other' }]);
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = withTwoItems();
    const publication = publish();
    expect(journal.outcome(publication, { ...review, status: 'visible' })).toBe(true);
    expect(journal.outcome(publication, { ...review, status: 'failed' })).toBe(false);
  });
});

describe('rows of a replacement or a prepend that only the Controller holds', () => {
  it('stay live-only, so a later reread does not count them as missing', () => {
    const { journal, publish } = openJournal();
    journal.replace(publish(), [
      { row: text('a', 'a:1', 'Alpha'), digest: DIGEST },
      { row: { ...text('q', 'q:1', 'Question'), liveOnly: true }, digest: DIGEST },
    ], 1_000);
    expect(journal.index().map(entry => [entry.itemKey, entry.liveOnly])).toEqual([['a', false], ['q', true]]);
    journal.prepend(publish(), [{ row: { ...text('p', 'p:1', 'Older'), liveOnly: true }, digest: DIGEST }]);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'p', liveOnly: true });
  });
});

describe('items of a replacement or a prepend that are still open', () => {
  it('carry no digest, stay open and are never evicted', () => {
    const { journal, publish } = openJournal();
    journal.replace(publish(), [
      { row: text('a', 'a:1', 'Alpha', 'turn-1'), digest: DIGEST },
      { row: text('b', 'b:1', 'Streaming', 'turn-2') },
    ], 1_000);
    expect(journal.index().map(entry => [entry.itemKey, entry.state, entry.digest])).toEqual([['a', 'complete', DIGEST], ['b', 'open', undefined]]);
    journal.prepend(publish(), [{ row: text('p', 'p:1', 'Older', 'turn-0') }]);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'p', state: 'open' });
    journal.evict(0);
    expect(journal.index().map(entry => [entry.itemKey, entry.resident])).toEqual([['p', true], ['a', false], ['b', true]]);
  });
});

describe('the attention cursor of the head', () => {
  it('is the cursor of the named item in the journal\'s own epoch and sequence', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'a' });
    expect(journal.head?.snapshot.attention).toEqual({ cursor: { epoch: 'epoch-1', seq: 1 } });
    expect(journal.head).not.toHaveProperty('attentionItemKey');
    journal.append(publish(), text('a', 'a:2', ' more'));
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch: 'epoch-1', seq: 3 });
  });

  it('is the journal\'s latest cursor when no item is named, and absent when the snapshot has no attention', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5 });
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
    journal.setHead(publish(), { snapshot: snapshot(false), observedAt: 6, attentionItemKey: 'a' });
    expect(journal.head?.snapshot.attention).toBeUndefined();
  });

  it('follows the item into the new epoch of a replacement', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'b' });
    const epoch = journal.replace(publish(), [
      { row: text('b', 'b:r', 'Beta'), digest: DIGEST },
      { row: text('a', 'a:r', 'Alpha'), digest: DIGEST },
    ], 1_000);
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch, seq: 1 });
  });

  it('is the journal\'s latest cursor, in its own epoch, when the named item is unknown', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'gone' });
    expect(journal.head?.snapshot.attention?.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
  });

  it('never goes below zero when the named item was prepended below the first sequence', () => {
    const { journal, publish } = openJournal();
    journal.replace(publish(), [{ row: text('a', 'a:1', 'Alpha'), digest: DIGEST }], 1_000);
    journal.prepend(publish(), [
      { row: text('p1', 'p1:1', 'One'), digest: DIGEST }, { row: text('p2', 'p2:1', 'Two'), digest: DIGEST }, { row: text('p3', 'p3:1', 'Three'), digest: DIGEST },
    ]);
    expect(journal.index()[0]!.seqStart).toBeLessThan(0);
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'p1' });
    expect(journal.head?.snapshot.attention?.cursor?.seq).toBe(0);
  });

  it('survives a store round trip with the item it names', () => {
    const { journal, publish } = withTwoItems();
    journal.setHead(publish(), { snapshot: snapshot(true), observedAt: 5, attentionItemKey: 'a' });
    expect(journal.takeChanges()?.meta.head?.attentionItemKey).toBe('a');
  });
});
```

Create `packages/agent-remote-journal/src/journal-late-rows.test.ts`. A late row of a content-replacing type reaches an evicted item:

<!-- write: packages/agent-remote-journal/src/journal-late-rows.test.ts -->
```ts
import type { ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { expectNoChange, openJournal, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import { JournalBodyMissingError, JournalItemTypeChangedError, type JournalRowInput } from './types.js';

const DIGEST = 'a'.repeat(64);
const one: ResourceBinding = { locator: 'one.md', resourceId: 'r1', status: 'available' };
const two: ResourceBinding = { locator: 'two.md', resourceId: 'r2', status: 'pending' };
const pending = { id: 'review-1', kind: 'review' as const, status: 'pending' as const };

const tool = (status: 'running' | 'completed', extra: Partial<JournalRowInput> & { background?: typeof pending } = {}): JournalRowInput => {
  const { background, ...rest } = extra;
  return {
    itemKey: 'tool:w1', providerId: 'codex', sourceKey: `tool:w1:${status}`, occurredAt: status === 'running' ? 1_725_000_000_000 : 1_725_000_001_000, turnId: 'turn-1',
    item: status === 'running'
      ? { type: 'tool_call', callId: 'w1', name: 'write', status, error: null, detail: { type: 'other', description: 'Writing' }, ...(background ? { background } : {}) }
      : { type: 'tool_call', callId: 'w1', name: 'write', status, error: null, detail: { type: 'other', description: 'Wrote' }, ...(background ? { background } : {}) },
    ...rest,
  };
};

/** A journal whose tool item, in turn 1, was evicted: complete with a digest, outside the latest turn. */
function withEvictedTool() {
  const { journal, publish } = openJournal();
  journal.append(publish(), { ...tool('running', { background: pending }), resources: [one] });
  journal.complete(publish(), 'tool:w1', DIGEST);
  journal.append(publish(), text('later', 'later:1', 'Next turn', 'turn-2'));
  journal.complete(publish(), 'later', DIGEST);
  journal.evict(1);
  expect(journal.index().map(entry => [entry.itemKey, entry.resident])).toEqual([['tool:w1', false], ['later', true]]);
  return { journal, publish };
}

const todoRow = (itemKey: string): JournalRowInput => ({ itemKey, providerId: 'codex', sourceKey: `${itemKey}:todo`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'todo', items: [{ text: 'Ship', completed: false }] } });

const tail = (journal: ReturnType<typeof openJournal>['journal']) => {
  const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
  if (page.kind !== 'page') throw new Error('Expected a page.');
  return page.page.payload.entries;
};

describe('a late row of a content-replacing type reaching an evicted item', () => {
  it('brings the item back with the row\'s content, open, keeping its time, its resources and its background merged with the row\'s', () => {
    const { journal, publish } = withEvictedTool();
    const before = journal.index()[0]!;
    const row = journal.append(publish(), { ...tool('completed', { background: { ...pending, status: 'visible' } }), resources: [two] });
    expect(row).toBeDefined();
    const entry = journal.index()[0]!;
    expect(entry).toMatchObject({ itemKey: 'tool:w1', state: 'open', resident: true, seqEnd: row!.seq });
    expect(entry.digest).toBeUndefined();
    expect(entry.revision).toBeGreaterThan(before.revision);
    const [shown] = tail(journal);
    expect(shown).toMatchObject({
      item: { type: 'tool_call', status: 'completed', detail: { description: 'Wrote' }, background: { id: 'review-1', status: 'visible' } },
      resources: [one, two], collapsed: ['tool_lifecycle'], timestamp: '2024-08-30T06:40:00.000Z',
    });
  });

  it('keeps an outcome that is worse than the row\'s background, and an outcome the row does not carry is dropped as it is for a resident item', () => {
    const { journal, publish } = withEvictedTool();
    journal.outcome(publish(), { ...pending, status: 'failed' });
    journal.append(publish(), tool('completed', { background: { ...pending, status: 'visible' } }));
    expect(tail(journal)[0]!.item.background).toMatchObject({ status: 'failed' });
    const other = withEvictedTool();
    other.journal.append(other.publish(), tool('completed'));
    expect(tail(other.journal)[0]!.item.background).toBeUndefined();
  });

  it('refuses a late row of a compaction, whose merge spreads fields the journal no longer holds', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), { itemKey: 'c', providerId: 'codex', sourceKey: 'c:1', occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'compaction', status: 'loading', trigger: 'auto', preTokens: 900 } });
    journal.complete(publish(), 'c', DIGEST);
    journal.append(publish(), text('later', 'later:1', 'Next turn', 'turn-2'));
    journal.complete(publish(), 'later', DIGEST);
    journal.evict(1);
    expectNoChange(journal, () => journal.append(publish(), { itemKey: 'c', providerId: 'codex', sourceKey: 'c:2', occurredAt: 1_725_000_002_000, turnId: 'turn-1', item: { type: 'compaction', status: 'completed' } }), JournalBodyMissingError);
  });

  it('refuses a row of another type for an evicted item, which remembers its type', () => {
    const { journal, publish } = withEvictedTool();
    expectNoChange(journal, () => journal.append(publish(), { ...text('tool:w1', 'w1:text', 'Text'), turnId: 'turn-1' }), JournalItemTypeChangedError);
    expectNoChange(journal, () => journal.append(publish(), todoRow('tool:w1')), JournalItemTypeChangedError);
  });

  it('still accepts a late row for an item stored without a type', () => {
    const state = withEvictedTool().journal.state();
    delete state.items[0]!.keptBody!.itemType;
    const restored = new SessionJournal(state);
    const { generation } = restored.claim('controller-2');
    restored.append({ publisherId: 'controller-2', generation, sequence: 1 }, tool('completed'));
    expect(restored.index()[0]).toMatchObject({ itemKey: 'tool:w1', resident: true, state: 'open' });
  });

  it('marks an evicted item live-only when the late row says so', () => {
    const { journal, publish } = withEvictedTool();
    journal.append(publish(), { ...tool('completed'), liveOnly: true });
    expect(journal.index()[0]).toMatchObject({ itemKey: 'tool:w1', liveOnly: true, state: 'open' });
    expect(journal.liveOnlyCount).toBe(1);
  });

  it('replaces a todo list', () => {
    const { journal, publish } = openJournal();
    const todo = (done: boolean, source: string): JournalRowInput => ({ itemKey: 'todo:t', providerId: 'codex', sourceKey: source, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'todo', items: [{ text: 'Ship', completed: done }] } });
    journal.append(publish(), todo(false, 't:1'));
    journal.complete(publish(), 'todo:t', DIGEST);
    journal.append(publish(), text('later', 'later:1', 'Next turn', 'turn-2'));
    journal.complete(publish(), 'later', DIGEST);
    journal.evict(1);
    journal.append(publish(), todo(true, 't:2'));
    expect(tail(journal)[0]!.item).toEqual({ type: 'todo', items: [{ text: 'Ship', completed: true }] });
  });

  it('still refuses a row that would append to content the journal no longer holds', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('a', 'a:1', 'Alpha', 'turn-1'));
    journal.complete(publish(), 'a', DIGEST);
    journal.append(publish(), text('b', 'b:1', 'Beta', 'turn-2'));
    journal.complete(publish(), 'b', DIGEST);
    journal.evict(1);
    expectNoChange(journal, () => journal.append(publish(), text('a', 'a:2', ' more', 'turn-1')), JournalBodyMissingError);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-amendments.test.ts --testTimeout=10000`
Expected: FAIL (`rebind` and `outcome` do not exist; `correct` requires a digest; an item of a replacement requires one too).

- [ ] **Step 3: Implement.** In `packages/agent-remote-journal/src/session-journal.ts`, import what the amendments use:

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
```
<!-- new -->
```ts
import { mergeBackgroundActivity, type BackgroundActivity, type ResourceBinding, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
```

The head serves the attention cursor of the item the publisher named:

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  /** The latest Snapshot the publisher reported, or undefined before the first one. */
  get head(): JournalHead | undefined { return this.meta.head === undefined ? undefined : structuredClone(this.meta.head); }
```
<!-- new -->
```ts
  /**
   * The latest Snapshot the publisher reported, or undefined before the first one. Its attention cursor is the cursor of
   * the item the publisher named, in this journal's epoch and sequence; without a named item it is the journal's latest cursor.
   */
  get head(): JournalHead | undefined {
    if (this.meta.head === undefined) return undefined;
    const { attentionItemKey, ...head } = structuredClone(this.meta.head);
    if (head.snapshot.attention) {
      const item = attentionItemKey === undefined ? undefined : this.byKey.get(attentionItemKey);
      // A live cursor is never negative; a prepended item sits below zero, so the cursor of the oldest items is the start.
      head.snapshot.attention.cursor = { epoch: this.meta.epoch, seq: Math.max(0, item ? item.seqEnd : this.meta.nextSeq - 1) };
    }
    return head;
  }
```

Amendments and pass-through publications go after `setHead`, and `correct` accepts a missing digest:

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
    this.advance(publication);
    this.meta.head = stored;
  }

  /** Replaces an item's content after a reread found it different, unless the item moved since the index was read. */
  correct(publication: JournalPublication, input: JournalRowInput, digest: string, expectedRevision: number): JournalRow | undefined {
```
<!-- new -->
```ts
    this.advance(publication);
    this.meta.head = stored;
  }

  /**
   * Replaces a resource binding of an item in place, in its body or, while that is evicted, in what the item keeps of it.
   * Returns the epoch and sequence clients know the item by, or undefined for a duplicate publication and for an item the
   * journal does not know, which has nothing to amend. An amendment does not move the item's revision.
   */
  rebind(publication: JournalPublication, itemKey: string, previous: ResourceBinding, replacement: ResourceBinding): { epoch: string; seq: number } | undefined {
    if (this.duplicate(publication)) return undefined;
    this.advance(publication);
    const item = this.byKey.get(itemKey);
    if (!item) return undefined;
    const resources = item.body ? item.body.resources : item.keptBody?.resources;
    resources?.forEach((resource, at) => {
      if (resource.locator === previous.locator && resource.resourceId === previous.resourceId) resources[at] = structuredClone(replacement);
    });
    this.touch(itemKey);
    return { epoch: this.meta.epoch, seq: item.seqEnd };
  }

  /** Applies a background outcome in place to every item of that background, evicted ones included; an outcome never regresses. False for a duplicate publication. */
  outcome(publication: JournalPublication, background: BackgroundActivity): boolean {
    if (this.duplicate(publication)) return false;
    this.advance(publication);
    for (const item of this.items) {
      const current = item.body ? item.body.item.background : item.background;
      if (current?.id !== background.id) continue;
      const merged = structuredClone(mergeBackgroundActivity(current, background));
      if (item.body) item.body.item.background = merged;
      else item.background = merged;
      this.touch(item.itemKey);
    }
    return true;
  }

  /**
   * Replaces an item's content after a reread found it different, unless the item moved since the index was read. With a
   * digest the item is complete; without one it stays open, as an item the Controller still receives deltas of does.
   */
  correct(publication: JournalPublication, input: JournalRowInput, digest: string | undefined, expectedRevision: number): JournalRow | undefined {
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
    item.sourceSeqRanges = includeSequence(item.sourceSeqRanges, row.seq);
    item.state = 'complete';
    item.digest = digest;
    item.revision = this.nextRevision();
    this.touch(item.itemKey);
    return row;
```
<!-- new -->
```ts
    item.sourceSeqRanges = includeSequence(item.sourceSeqRanges, row.seq);
    if (digest === undefined) {
      item.state = 'open';
      delete item.digest;
    } else {
      item.state = 'complete';
      item.digest = digest;
    }
    item.revision = this.nextRevision();
    this.touch(item.itemKey);
    return row;
```

An item of a replacement or a prepend keeps its live-only mark, and has no digest when it is still open. The Controller's own timeline holds items that native history will not give back, and a replacement that starts from that timeline must not make them look rebuildable; an item the provider has not finished is not complete:

<!-- edit: packages/agent-remote-journal/src/types.ts -->
<!-- old -->
```ts
  AgentTimelineItem, BackgroundActivity, CompleteItemInput, JournalHead, JournalIndexEntry, JournalRowInput, ResourceBinding, TimelineCollapse, TimelineSeqRange,
} from '@orchardworks/agent-remote-protocol';

/** The wire shapes the journal consumes and produces; the Host uplink carries them unchanged. */
export type { CompleteItemInput, JournalHead, JournalIndexEntry, JournalRowInput };
```
<!-- new -->
```ts
  AgentTimelineItem, BackgroundActivity, CompleteItemInput, JournalHead, JournalIndexEntry, JournalItemInput, JournalRowInput, ResourceBinding, TimelineCollapse, TimelineSeqRange,
} from '@orchardworks/agent-remote-protocol';

/** The wire shapes the journal consumes and produces; the Host uplink carries them unchanged. */
export type { CompleteItemInput, JournalHead, JournalIndexEntry, JournalItemInput, JournalRowInput };
```

<!-- edit: packages/agent-remote-journal/src/replacement.ts -->
<!-- old -->
```ts
import type { CompleteItemInput, JournalItem } from './types.js';

export type ReplacementEntry =
  | { kind: 'reread'; complete: CompleteItemInput }
```
<!-- new -->
```ts
import type { JournalItem, JournalItemInput } from './types.js';

export type ReplacementEntry =
  | { kind: 'reread'; complete: JournalItemInput }
```

<!-- edit: packages/agent-remote-journal/src/replacement.ts -->
<!-- old -->
```ts
export function replacementOrder(previous: readonly JournalItem[], reread: readonly CompleteItemInput[]): ReplacementEntry[] {
```
<!-- new -->
```ts
export function replacementOrder(previous: readonly JournalItem[], reread: readonly JournalItemInput[]): ReplacementEntry[] {
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  replace(publication: JournalPublication, items: readonly CompleteItemInput[], now: number): string {
```
<!-- new -->
```ts
  replace(publication: JournalPublication, items: readonly JournalItemInput[], now: number): string {
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  prepend(publication: JournalPublication, older: readonly CompleteItemInput[]): JournalRow[] {
```
<!-- new -->
```ts
  prepend(publication: JournalPublication, older: readonly JournalItemInput[]): JournalRow[] {
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  protected requireDistinct(items: readonly CompleteItemInput[]): void {
```
<!-- new -->
```ts
  protected requireDistinct(items: readonly JournalItemInput[]): void {
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  carriedOnReplace(reread: readonly CompleteItemInput[]): { count: number; bytes: number } {
```
<!-- new -->
```ts
  carriedOnReplace(reread: readonly JournalItemInput[]): { count: number; bytes: number } {
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  /** A complete item built from native history; `previous` is the item of the same key whose alias and background it keeps. */
  protected completeItem(epoch: string, complete: CompleteItemInput, seq: number, previous?: JournalItem): JournalItem {
    const item: JournalItem = { ...this.openItem(stampRow(epoch, seq, complete.row), false), state: 'complete', digest: complete.digest };
```
<!-- new -->
```ts
  /** An item built from a reread: complete with its digest, or open without one. `previous` is the item of the same key whose alias and background it keeps. */
  protected completeItem(epoch: string, complete: JournalItemInput, seq: number, previous?: JournalItem): JournalItem {
    const item: JournalItem = { ...this.openItem(stampRow(epoch, seq, complete.row), complete.row.liveOnly === true), ...(complete.digest === undefined ? {} : { state: 'complete' as const, digest: complete.digest }) };
```

The type import of the journal's own file names the new type:

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  type CompleteItemInput, type JournalChanges, type JournalHead,
```
<!-- new -->
```ts
  type CompleteItemInput, type JournalItemInput, type JournalChanges, type JournalHead,
```

A row that replaces an item's content reaches an item whose body was evicted:

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
    if (existing && existing.body === null) throw new JournalBodyMissingError(input.itemKey);
```
<!-- new -->
```ts
    if (existing && existing.body === null) {
      const keptType = existing.keptBody?.itemType;
      if (keptType !== undefined && keptType !== input.item.type) throw new JournalItemTypeChangedError(input.itemKey, keptType, input.item.type);
      if (!CONTENT_REPLACING_TYPES.has(input.item.type)) throw new JournalBodyMissingError(input.itemKey);
      return this.appendToEvicted(publication, existing, row, input.liveOnly === true);
    }
```

Eviction records the item's type, so a late row of another type is refused as `type_changed`; data stored before it was recorded has none and is still accepted. In `types.ts`, `keptBody?: Omit<JournalBody, 'item'> & { itemType?: AgentTimelineItem['type'] }`; `evictKeys` stores `itemType: body.item.type` in `keptBody`; `fill` copies `keptBody` without `itemType` into the body.

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
  /** Marks an item complete with the digest of its whole content. */
```
<!-- new -->
```ts
  /**
   * A row of a type whose rows replace the item's content (`tool_call` and `todo`, as `mergeRowIntoEntry` does)
   * reaches an item whose body was evicted. The row brings all the content, so the item is resident again and open, with:
   * - the content of the row;
   * - the resources the item kept, plus the row's, and the collapse marks and time the item kept;
   * - the background the item kept, merged with the row's so an outcome never regresses.
   * A row of any other type, which would append to or spread over content the journal no longer holds, is refused as before (a compaction's merge spreads fields, so a late row would lose the fields it omits and break the digest).
   */
  protected appendToEvicted(publication: JournalPublication, existing: JournalItem, row: JournalRow, liveOnly: boolean): JournalRow {
    const kept = existing.keptBody;
    if (!kept) throw new JournalBodyMissingError(existing.itemKey);
    const entry: ProjectedTimelineEntry = {
      providerId: existing.providerId, item: { ...structuredClone(row.item), ...(existing.background ? { background: structuredClone(existing.background) } : {}) } as AgentTimelineItem,
      ...(existing.turnId === undefined ? {} : { turnId: existing.turnId }), timestamp: kept.timestamp, seqStart: existing.seqStart, seqEnd: existing.seqEnd,
      sourceSeqRanges: [], collapsed: [...kept.collapsed], resources: structuredClone(kept.resources),
    };
    mergeRowIntoEntry(entry, canonicalRow(structuredClone(row)));
    this.advance(publication);
    this.meta.nextSeq += 1;
    existing.body = entryBody(entry);
    delete existing.keptBody;
    delete existing.background;
    existing.seqEnd = row.seq;
    extendSequenceRanges(existing.sourceSeqRanges, row.seq);
    if (liveOnly) existing.liveOnly = true;
    existing.state = 'open';
    delete existing.digest;
    existing.revision = this.nextRevision();
    this.touch(existing.itemKey);
    return row;
  }

  /** Marks an item complete with the digest of its whole content. */
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
/** How long a retired epoch is remembered, for diagnostics only. */
```
<!-- new -->
```ts
/** The item types whose rows replace the item's content instead of adding to it. */
const CONTENT_REPLACING_TYPES: ReadonlySet<string> = new Set(['tool_call', 'todo']);

/** How long a retired epoch is remembered, for diagnostics only. */
```

<!-- edit: packages/agent-remote-journal/src/session-journal.ts -->
<!-- old -->
```ts
import { mergeBackgroundActivity, type BackgroundActivity, type ResourceBinding, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
```
<!-- new -->
```ts
import { mergeBackgroundActivity, type AgentTimelineItem, type BackgroundActivity, type ProjectedTimelineEntry, type ResourceBinding, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
```

- [ ] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-journal exec vitest run src/journal-amendments.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-journal run test` then `pnpm --filter @orchardworks/agent-remote-journal run typecheck` then `pnpm --filter @orchardworks/agent-remote-journal run build`
Expected: PASS for all (the package has 200 tests). Rebuild the package so `agent-remote-hosted` and `agent-host` see the new methods.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-journal/src
git commit -m "feat(journal): apply amendments in place, keep open corrections open, take late rows of evicted tools and todo lists, and serve the attention cursor in the journal's epoch" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 4: The Relay applies, fans out and answers what the Controller publishes, and holds interaction frames until the head agrees

Jobs in `agent-remote-hosted`:

- The Host journal service applies `rebind` and `outcome` entries and lists what subscribers hear (`rebound`, `outcome`); it takes a session out of serving when the Controller says so (`journal_unserve`); and its live-only cap now counts prepended items.
- The connection adapter applies `journal_unserve`, rejects the Relay's pending fill or older-history request at once when the Controller answers `journal_request_refused`, and the broker grants journals per connection: at level 2 only to a Controller that asks for `journal=2` of a service whose `capabilities(hostId)` reports 2, at level 1 to one that asks for 1. A grant-1 connection that sends a grant-2 entry or message is closed with 1008.
- A journal-served browser stream sends amendments as the frames today's session wire sends (`timeline_resource_binding_replaced` and a non-timeline `agent_stream` for a background outcome).
- A journal-served browser stream forwards the Controller's `interaction_requested`, `interaction_resolved` and `interaction_invalidated` frames only once the head it last sent to that browser agrees with them. Otherwise an older head, which arrives through the journal after a frame that came straight from the Controller, makes the client drop a new question or bring back a resolved one (the client's reducer takes the pending interactions of the latest Snapshot). A frame waits at most two seconds and at most 64 frames wait.

**Files:**
- Modify: `packages/agent-remote-hosted/src/host-journals.ts`
- Modify: `packages/agent-remote-hosted/src/journal-uplink.ts`
- Modify: `packages/agent-remote-hosted/src/journal-session-stream.ts`
- Modify: `packages/agent-remote-hosted/src/broker.ts`
- Modify: `packages/agent-remote-hosted/src/journal-partition.ts`, `journal-partition.contract.json` and `journal-partition.test.ts` (the partition carries `reset` and `unserveHead`; the recorded contract only gains steps)
- Modify: `packages/agent-remote-hosted/src/host-journals.test.ts` (the test of the removed grant-1 guard goes)
- Modify: `packages/agent-remote-cloudflare/src/journal-partition.ts` and `test/journal-partition.test.ts` (the Durable Object exposes `unserveHead`)
- Create: `packages/agent-remote-hosted/src/host-journals-amendments.test.ts`
- Create: `packages/agent-remote-hosted/src/host-journals-reset-open.test.ts`
- Create: `packages/agent-remote-hosted/src/journal-uplink-controller-messages.test.ts`
- Create: `packages/agent-remote-hosted/src/journal-session-stream-amendments.test.ts`
- Create: `packages/agent-remote-hosted/src/broker-journal-grant.test.ts`

This task expects P1-B2 and P1-B3a to have landed completely (the bounded service with `unserve`, `served` and `indexPage`, the connection adapter's pulled index pages, and the journal-served gate of P1-B3a Task 6 whose `published` handler closes the streams of a session whose publication reports `unserved`). It changes only the `JournalLiveEvent` type, `HostJournals.unserve`, the `apply` function, the `admission` function and the `liveOnlyChanged` line of `publish` in `host-journals.ts`, and it removes the grant-1 guard Task 2 added there (`GrantOneEntry`, `requireGrantOneEntry` and its call in `publish`); `JournalHostMessage`, `receive` and `JournalRequestError` in `journal-uplink.ts`; `register`, `registered`, the message handler (where it checks the grant before `host.journal.receive`), the Host record and the `journal` query in `broker.ts`; and the `deliver`, `hostFrame`, `negotiate`, `refreshHead` and `shutdown` functions of `journal-session-stream.ts`.

- [ ] **Step 1: Write the failing service test.** Create `packages/agent-remote-hosted/src/host-journals-amendments.test.ts`. It seeds the store with a claimed journal, so it does not depend on how `open` is called:

<!-- write: packages/agent-remote-hosted/src/host-journals-amendments.test.ts -->
```ts
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import type { AgentSnapshotPayload, JournalPublishEntry, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const KEY = `${HOST}:${SESSION}`;
const PUBLISHER = 'controller-1';
const pending: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' };
const settled: ResourceBinding = { locator: 'docs/plan.md', resourceId: 'resource-2', status: 'available' };
const row = (itemKey: string, text: string, resources: ResourceBinding[] = []) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', resources,
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const snapshot: AgentSnapshotPayload = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};

async function seeded(limits?: { liveOnlyItems?: number; sessionBytes?: number }) {
  const store = new MemoryJournalStore();
  const journal = SessionJournal.create(KEY);
  journal.claim(PUBLISHER);
  await store.apply(journal.takeChanges()!);
  return { store, journals: createHostJournals({ store, now: () => 1_000, ...(limits ? { limits } : {}) }) };
}

describe('amendments published to a journal', () => {
  it('applies a rebind and an outcome in place, stores them, and lists what subscribers hear in order', async () => {
    const { store, journals } = await seeded();
    const entries: JournalPublishEntry[] = [
      { sequence: 1, op: 'append', row: row('a', 'Alpha', [pending]) },
      { sequence: 2, op: 'rebind', itemKey: 'a', previous: pending, replacement: settled },
      { sequence: 3, op: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_500 },
    ];
    const result = await journals.publish(HOST, SESSION, 1, entries);
    expect(result.refusal).toBeUndefined();
    expect(result.watermark).toBe(3);
    expect(result.events.map(event => event.kind)).toEqual(['row', 'rebound', 'outcome']);
    expect(result.events[1]).toEqual({ kind: 'rebound', epoch: result.cursor!.epoch, seq: 1, previous: pending, replacement: settled });
    expect(result.events[2]).toEqual({ kind: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_500 });
    const saved = await store.load(KEY);
    expect(saved?.items[0]?.body?.resources).toEqual([settled]);
    expect(saved?.meta.publisher?.watermark).toBe(3);
  });

  it('tells subscribers nothing for a publication it already applied', async () => {
    const { journals } = await seeded();
    const entries: JournalPublishEntry[] = [
      { sequence: 1, op: 'append', row: row('a', 'Alpha', [pending]) },
      { sequence: 2, op: 'rebind', itemKey: 'a', previous: pending, replacement: settled },
    ];
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toHaveLength(2);
    expect((await journals.publish(HOST, SESSION, 1, entries)).events).toEqual([]);
  });

  it('refuses an open correction that names a stale revision, and keeps the entries before it', async () => {
    const { journals } = await seeded();
    const result = await journals.publish(HOST, SESSION, 1, [
      { sequence: 1, op: 'append', row: row('a', 'Alpha') },
      { sequence: 2, op: 'correct', row: row('a', 'Alpha, in full'), expectedRevision: 99 },
      { sequence: 3, op: 'rebind', itemKey: 'a', previous: pending, replacement: settled },
    ]);
    expect(result.refusal).toEqual({ sequence: 2, reason: 'stale_revision', itemKey: 'a' });
    expect(result.watermark).toBe(1);
    expect(result.events.map(event => event.kind)).toEqual(['row']);
  });

  it('accepts the entries after a refused one when they are sent again under the refused entry\'s number, and does not take them for a duplicate', async () => {
    const { store, journals } = await seeded();
    const result = await journals.publish(HOST, SESSION, 1, [
      { sequence: 1, op: 'append', row: row('a', 'Alpha') },
      { sequence: 2, op: 'correct', row: row('b', 'Ghost'), expectedRevision: 1 },
      { sequence: 3, op: 'append', row: row('c', 'Gamma') },
    ]);
    expect(result.refusal).toEqual({ sequence: 2, reason: 'unknown_item', itemKey: 'b' });
    expect(result.watermark).toBe(1);
    // The entry that followed was not applied, and the refused sequence is still free.
    expect((await journals.publish(HOST, SESSION, 1, [{ sequence: 3, op: 'append', row: row('c', 'Gamma') }])).refusal).toEqual({ sequence: 3, reason: 'sequence_gap' });
    const again = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'append', row: row('c', 'Gamma') }]);
    expect(again.refusal).toBeUndefined();
    expect(again.watermark).toBe(2);
    expect(again.events.map(event => event.kind)).toEqual(['row']);
    expect((await store.load(KEY))?.items.map(item => item.itemKey)).toEqual(['a', 'c']);
  });

  it('takes a replacement whose last item is still open, without a digest', async () => {
    const { store, journals } = await seeded();
    const result = await journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'replace', items: [{ row: row('a', 'Alpha'), digest: 'd'.repeat(64) }, { row: row('b', 'Still streaming') }] }]);
    expect(result.refusal).toBeUndefined();
    const saved = await store.load(KEY);
    expect(saved?.items.map(item => [item.itemKey, item.state, item.digest])).toEqual([['a', 'complete', 'd'.repeat(64)], ['b', 'open', undefined]]);
  });

  it('counts a rebind against the session\'s size limit, like the entries that carry content', async () => {
    const { journals } = await seeded({ sessionBytes: 3000 });
    expect((await journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'append', row: row('a', 'Alpha', [pending]) }])).refusal).toBeUndefined();
    const large: ResourceBinding = { ...settled, locator: 'docs/' + 'x'.repeat(3500) };
    const result = await journals.publish(HOST, SESSION, 1, [{ sequence: 2, op: 'rebind', itemKey: 'a', previous: pending, replacement: large }]);
    expect(result.refusal).toEqual({ sequence: 2, reason: 'quota_exceeded' });
    expect(result.watermark).toBe(1);
  });

  it('counts prepended live-only items against the live-only cap', async () => {
    const { journals } = await seeded({ liveOnlyItems: 1 });
    const live = (itemKey: string) => ({ row: { ...row(itemKey, itemKey), liveOnly: true }, digest: 'd'.repeat(64) });
    const result = await journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'prepend', items: [live('q1'), live('q2')] }]);
    expect(result.droppedLiveOnly).toBe(1);
  });
});

describe('taking a session out of serving at the Controller\'s word', () => {
  const served = async () => {
    const fixture = await seeded();
    await fixture.journals.publish(HOST, SESSION, 1, [{ sequence: 1, op: 'append', row: row('a', 'Alpha') }, { sequence: 2, op: 'head', head: { snapshot, observedAt: 5 } }]);
    return fixture;
  };

  it('clears the head, persists that, and reports it as unserved', async () => {
    const { store, journals } = await served();
    expect(journals.served(HOST, SESSION)).toBe(true);
    const result = await journals.unserveHead(HOST, SESSION, 1);
    expect(result).toMatchObject({ unserved: true, hasHead: false, events: [], watermark: 2 });
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect((await store.load(KEY))?.meta.head).toBeUndefined();
    expect(await journals.status(HOST, SESSION)).toMatchObject({ cursor: { seq: 1 } });
    expect((await journals.status(HOST, SESSION))?.head).toBeUndefined();
  });

  it('serves the session again when a later publication sets a head', async () => {
    const { journals } = await served();
    await journals.unserveHead(HOST, SESSION, 1);
    await journals.publish(HOST, SESSION, 1, [{ sequence: 3, op: 'head', head: { snapshot, observedAt: 6 } }]);
    expect(journals.served(HOST, SESSION)).toBe(true);
  });

  it('ignores a generation that is not the publisher\'s, and a session that has no head to clear', async () => {
    const { store, journals } = await served();
    expect(await journals.unserveHead(HOST, SESSION, 7)).toBeUndefined();
    expect((await store.load(KEY))?.meta.head).toBeDefined();
    expect(await journals.unserveHead(HOST, SESSION, 1)).toMatchObject({ unserved: true });
    expect(await journals.unserveHead(HOST, SESSION, 1)).toMatchObject({ hasHead: false });
    expect((await journals.unserveHead(HOST, SESSION, 1))?.unserved).toBeUndefined();
    expect(await journals.unserveHead(HOST, 'codex:unknown', 1)).toBeUndefined();
  });
});
```

A journal whose index is too large to list cannot be opened, so its publisher could never replace it. An open that asks for no index is the way out. Create `packages/agent-remote-hosted/src/host-journals-reset-open.test.ts`:

<!-- write: packages/agent-remote-hosted/src/host-journals-reset-open.test.ts -->
```ts
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import type { AgentSnapshotPayload, JournalPublishEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type JournalOpened } from './host-journals.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const LIMITS = { maxIndexItems: 1_000_000, pageItems: 1_000_000 };
const snapshot: AgentSnapshotPayload = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const row = (itemKey: string, text: string) => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message' as const, text, messageId: itemKey },
});
const append = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'append', row: row(itemKey, itemKey) });
const complete = (sequence: number, itemKey: string): JournalPublishEntry => ({ sequence, op: 'complete', itemKey, digest: `digest-${itemKey}` });
const head = (sequence: number): JournalPublishEntry => ({ sequence, op: 'head', head: { snapshot, observedAt: 5 } });

async function overlarge() {
  const store = new MemoryJournalStore();
  const journals = createHostJournals({ store, now: () => 1_000 });
  await journals.open(HOST, SESSION, 'controller-1', LIMITS);
  await journals.publish(HOST, SESSION, 1, [append(1, 'm1'), complete(2, 'm1'), append(3, 'm2'), complete(4, 'm2'), append(5, 'm3'), complete(6, 'm3'), head(7)]);
  return { store, journals };
}

describe('opening a journal without its index', () => {
  it('claims a journal whose index is too large, takes it out of serving, and accepts only a replacement until one is stored', async () => {
    const { journals } = await overlarge();
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 })).toEqual({ refused: 'index_too_large', unserved: true });

    const opened = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true }) as JournalOpened;
    expect(opened).toMatchObject({ generation: 2, index: [], more: false });
    expect(journals.served(HOST, SESSION)).toBe(false);

    const next = opened.watermark + 1;
    expect((await journals.publish(HOST, SESSION, 2, [append(next, 'm4')])).refusal).toEqual({ sequence: next, reason: 'incomplete' });
    expect((await journals.publish(HOST, SESSION, 2, [head(next)])).refusal).toEqual({ sequence: next, reason: 'incomplete' });

    const replaced = await journals.publish(HOST, SESSION, 2, [
      { sequence: next, op: 'replace', items: [{ row: row('m3', 'm3'), digest: 'digest-m3' }] },
      head(next + 1),
    ]);
    expect(replaced.refusal).toBeUndefined();
    expect(replaced.hasHead).toBe(true);
    expect(journals.served(HOST, SESSION)).toBe(true);
    const again = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2 }) as JournalOpened;
    expect(again.index.map(entry => entry.itemKey)).toEqual(['m3']);
  });

  it('refuses every entry but a replacement while the journal waits for one', async () => {
    const { journals } = await overlarge();
    const opened = await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true }) as JournalOpened;
    const next = opened.watermark + 1;
    const binding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' as const };
    const refused: JournalPublishEntry[] = [
      complete(next, 'm1'), { sequence: next, op: 'seal', itemKey: 'm1' }, { sequence: next, op: 'alias', itemKey: 'm1', clientMessageId: 'operation-1' },
      { sequence: next, op: 'correct', row: row('m1', 'm1'), digest: 'digest-m1', expectedRevision: 1 },
      { sequence: next, op: 'prepend', items: [{ row: row('m0', 'm0'), digest: 'digest-m0' }] },
      { sequence: next, op: 'rebind', itemKey: 'm1', previous: binding, replacement: { ...binding, status: 'available' } },
      { sequence: next, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 },
    ];
    for (const entry of refused) expect((await journals.publish(HOST, SESSION, 2, [entry])).refusal).toEqual({ sequence: next, reason: 'incomplete' });
    expect((await journals.publish(HOST, SESSION, 2, [{ sequence: next, op: 'replace', items: [{ row: row('m3', 'm3'), digest: 'digest-m3' }] }])).refusal).toBeUndefined();
  });

  it('keeps the journal out of serving across a restart of the Relay until a replacement is stored', async () => {
    const { store, journals } = await overlarge();
    await journals.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true });
    const restarted = createHostJournals({ store, now: () => 1_000 });
    expect(await restarted.servedSessions(HOST)).toEqual([]);
    const reopened = await restarted.open(HOST, SESSION, 'controller-1', { maxIndexItems: 2, pageItems: 2, reset: true }) as JournalOpened;
    expect((await restarted.publish(HOST, SESSION, reopened.generation, [append(reopened.watermark + 1, 'm4')])).refusal).toMatchObject({ reason: 'incomplete' });
  });

  it('opens a journal that has no head and no rows the same way', async () => {
    const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const opened = await journals.open(HOST, SESSION, 'controller-1', { ...LIMITS, reset: true }) as JournalOpened;
    expect(opened).toMatchObject({ generation: 1, index: [], more: false });
    expect(opened.unserved).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals-amendments.test.ts src/host-journals-reset-open.test.ts --testTimeout=10000`
Expected: FAIL (the service ignores the new operations, `unserveHead` does not exist, prepended live-only items are not counted, and an open cannot reset).

- [ ] **Step 3: Implement the service.** In `packages/agent-remote-hosted/src/host-journals.ts`, extend what subscribers see of a publication:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
  /** A head that was not already applied. */
  | { kind: 'head'; head: JournalHead };
```
<!-- new -->
```ts
  /** A head that was not already applied. */
  | { kind: 'head'; head: JournalHead }
  /** A resource binding was replaced in place; clients find the item by its epoch and sequence. */
  | { kind: 'rebound'; epoch: string; seq: number; previous: ResourceBinding; replacement: ResourceBinding }
  /** A background outcome was applied in place to the items of that background. */
  | { kind: 'outcome'; providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number };
```

with the types imported next to the other protocol types (`BackgroundActivity`, `ResourceBinding`).

and apply the entries:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
      case 'prepend': journal.prepend(publication, entry.items); break;
```
<!-- new -->
```ts
      case 'prepend': journal.prepend(publication, entry.items); break;
      case 'rebind': {
        const at = journal.rebind(publication, entry.itemKey, entry.previous, entry.replacement);
        if (at) published.events.push({ kind: 'rebound', ...at, previous: entry.previous, replacement: entry.replacement });
        break;
      }
      case 'outcome':
        if (journal.outcome(publication, entry.background)) {
          published.events.push({ kind: 'outcome', providerId: entry.providerId, ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }), background: entry.background, occurredAt: entry.occurredAt });
        }
        break;
```

A prepend can bring live-only items too, so it takes part in the live-only cap:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
              if (entry.op === 'complete' || entry.op === 'seal' || entry.op === 'replace' || (entry.op === 'append' && entry.row.liveOnly === true)) liveOnlyChanged = true;
```
<!-- new -->
```ts
              if (entry.op === 'complete' || entry.op === 'seal' || entry.op === 'replace' || (entry.op === 'append' && entry.row.liveOnly === true)
                || (entry.op === 'prepend' && entry.items.some(({ row: { liveOnly } }) => liveOnly === true))) liveOnlyChanged = true;
```

The service takes a session out of serving when its Controller says so:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
  unserve(hostId: string, sessionKey: string): void;
```
<!-- new -->
```ts
  unserve(hostId: string, sessionKey: string): void;
  /**
   * The Controller of generation `generation` can no longer keep the session's journal current: clears the head, stores that,
   * and forgets the session in the head index, so it is read through the Controller until a later publication sets a head.
   * Undefined when the session has no journal or `generation` is not the publisher's. `unserved` is set only when a head was cleared.
   */
  unserveHead(hostId: string, sessionKey: string, generation: number): Promise<JournalPublished | undefined>;
```

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
      bump(hostId);
    },
```
<!-- new -->
```ts
    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
      bump(hostId);
    },

    unserveHead: (hostId, sessionKey, generation) => serialized<JournalPublished | undefined>(hostId, async () => {
      const key = storeKey(hostId, sessionKey);
      if (needsReopen.has(key)) return undefined;
      let journal: SessionJournal | undefined;
      let cleared = false;
      let bytes = 0;
      try {
        await loadHost(hostId);
        journal = await load(hostId, sessionKey, false);
        if (!journal || journal.publisher?.generation !== generation) return undefined;
        cleared = journal.hasHead;
        if (cleared) journal.clearHead();
        bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      } catch (error) {
        drop(key);
        needsReopen.add(key);
        throw error;
      }
      const kept = journal as SessionJournal;
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, kept, bytes);
      heads.remove(hostId, sessionKey);
      bump(hostId);
      trimCache(key);
      return { events: [], watermark: kept.publisher?.watermark ?? 0, cursor: kept.cursor, hasHead: false, ...(cleared ? { unserved: true as const } : {}) };
    }),
```

The open that resets claims the journal without its index and marks it incomplete, so nothing but a replacement is admitted:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
  /** Asked inside the Host's queue: false means the connection that asked is gone, so nothing is created or claimed. */
  allowed?(): boolean;
}
```
<!-- new -->
```ts
  /** Asked inside the Host's queue: false means the connection that asked is gone, so nothing is created or claimed. */
  allowed?(): boolean;
  /**
   * Claims the journal without listing its index, whatever its size: the answer has an empty index, the head is cleared, and
   * the journal is incomplete, so it accepts a replacement (and then a head) before anything else. This is the way out of an
   * index over `maxIndexItems`, which a normal open refuses.
   */
  reset?: boolean;
}
```

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
  /** Whether the index has entries beyond `index`. */
  more: boolean;
}
```
<!-- new -->
```ts
  /** Whether the index has entries beyond `index`. */
  more: boolean;
  /** A reset took a served session out of serving: its head was cleared and the head index forgot the session. */
  unserved?: true;
}
```

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
      if (openOptions.allowed && !openOptions.allowed()) return refuse('unavailable');
      const index = journal.index();
```
<!-- new -->
```ts
      if (openOptions.allowed && !openOptions.allowed()) return refuse('unavailable');
      if (openOptions.reset) {
        const unserved = journal.hasHead;
        if (unserved) journal.clearHead();
        journal.markIncomplete();
        const { generation, watermark } = journal.claim(publisherId);
        const kept = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
        needsReopen.delete(key);
        account(hostId, sessionKey, kept);
        remember(hostId, sessionKey, journal, kept);
        if (unserved) { heads.remove(hostId, sessionKey); bump(hostId); }
        trimCache(key);
        return { generation, watermark, epoch: journal.epoch, index: [], more: false, ...(unserved ? { unserved: true as const } : {}) };
      }
      const index = journal.index();
```

The journal that is missing rows takes a replacement before anything else, and a `rebind` counts against the quota like the other entries that carry content. The head check moves up and covers every entry but a replacement:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
      if (entry.op === 'head') {
        if (journal.incomplete) throw new JournalIncompleteRefused();
        return;
      }
```
<!-- new -->
```ts
      // A journal that is missing rows takes a replacement before anything else, the head included.
      if (entry.op !== 'replace' && journal.incomplete) throw new JournalIncompleteRefused();
      if (entry.op === 'head') return;
```

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
      if (entry.op !== 'append' && entry.op !== 'correct' && entry.op !== 'prepend') return;
```
<!-- new -->
```ts
      if (entry.op !== 'append' && entry.op !== 'correct' && entry.op !== 'prepend' && entry.op !== 'rebind') return;
```

Take the grant-1 guard of Task 2 out, and let the entry types be the wire's own:

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
/** The entries a grant 1 Controller sends: every item and correction is complete, and a head names no attention item. */
type GrantOneEntry = Exclude<JournalPublishEntry, { op: 'rebind' | 'outcome' }> extends infer Entry
  ? Entry extends { op: 'correct' } ? Entry & { digest: string }
    : Entry extends { op: 'replace' | 'prepend' } ? Omit<Entry, 'items'> & { items: CompleteItemInput[] }
    : Entry
  : never;

```
<!-- new -->
```ts
```

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
  /**
   * A Controller holding grant 1 sends complete items only. Entries that need grant 2 (amendments, open items, attention
   * item keys) are refused as invalid publications, so no journal ever holds what this Relay cannot serve.
   */
  function requireGrantOneEntry(entry: JournalPublishEntry): asserts entry is GrantOneEntry {
    const needsGrantTwo = entry.op === 'rebind' || entry.op === 'outcome'
      || (entry.op === 'correct' && entry.digest === undefined)
      || ((entry.op === 'replace' || entry.op === 'prepend') && entry.items.some(item => item.digest === undefined))
      || (entry.op === 'head' && entry.head.attentionItemKey !== undefined);
    if (needsGrantTwo) throw new JournalInvalidPublicationError(entry.sequence);
  }

```
<!-- new -->
```ts
```

<!-- edit: packages/agent-remote-hosted/src/host-journals.ts -->
<!-- old -->
```ts
            requireGrantOneEntry(entry);
            if (fresh) admit(entry);
```
<!-- new -->
```ts
            if (fresh) admit(entry);
```

`admission` and `apply` take `JournalPublishEntry` again (`CompleteItemInput` stays imported for the fill path). The grant is enforced per connection in the broker (Step 11), where a violation closes the connection instead of refusing entries one by one. The landed `host-journals.test.ts` has a test of the removed guard ("refuses entries that need a later journal grant"); delete it, since the broker test below covers the same entries at the connection.

The journal partition is the other implementation of `HostJournals`, so it carries the two new service calls. In `packages/agent-remote-hosted/src/journal-partition.ts`, `JournalPartitionApi.open` takes `options: { maxIndexItems: number; pageItems: number; reset?: true }`, the interface gains `unserveHead(hostId, sessionKey, generation): Promise<JournalPublished | undefined>`, `serveJournalPartition` forwards it, and `createPartitionJournals` passes `reset` when it is set, forgets the session in its head index for any open that reports `unserved` (a reset included) and for an `unserveHead` that found a journal. `packages/agent-remote-cloudflare/src/journal-partition.ts` exposes `unserveHead` on the Durable Object. The recorded contract `journal-partition.contract.json` is only extended: new steps at its end open a session, publish `append`, `rebind`, `outcome`, an open `correct` and a `head` with `attentionItemKey`, call `unserveHead`, and open a second session with `reset: true`; `journal-partition.test.ts` lists `unserveHead` among the contract's methods and gains a test of the proxy, and the Cloudflare test calls `unserveHead` and a reset open through Durable Object RPC. `capabilities()` of the proxy answers `{ journal: 1 }` only for a partition that lacks the method (the RPC error "does not implement the method"); any other failure is thrown and remembered as nothing. The broker waits at most 3 seconds for it and closes the uplink with 1013 on a failure or a timeout, so the Controller connects again and asks again; a transient error never fixes a connection at grant 1. Held interaction frames are bounded to 64 frames and 1 MiB, the oldest is released beyond either, and a frame that arrives after the stream closed is dropped without a timer. A partitions Worker deployed before this change reports `journal: 2` without these calls, so it must be redeployed before any Relay that is allowed to grant 2 serves a Controller that asks for it.

- [ ] **Step 4: Run the service test and see it pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/host-journals-amendments.test.ts src/host-journals-reset-open.test.ts src/host-journals-bounds.test.ts --testTimeout=10000`
Expected: PASS.

- [ ] **Step 5: Write the failing connection test.** The connection adapter applies `journal_unserve` and rejects a pending request when the Controller refuses it. Create `packages/agent-remote-hosted/src/journal-uplink-controller-messages.test.ts`:

<!-- write: packages/agent-remote-hosted/src/journal-uplink-controller-messages.test.ts -->
```ts
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { REMOTE_HOST_UPLINK_VERSION, type AgentSnapshotPayload, type RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type JournalPublished } from './host-journals.js';
import { createJournalConnection, JournalRequestError, type JournalHostMessage } from './journal-uplink.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const snapshot: AgentSnapshotPayload = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const wire = (message: Record<string, unknown>) => ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, ...message }) as unknown as JournalHostMessage;

function fixture() {
  const journals = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
  const sent: RemoteHostUplinkMessage[] = [];
  const published: Array<{ sessionKey: string; result: JournalPublished }> = [];
  const timers: Array<() => void> = [];
  const connection = createJournalConnection({
    hostId: HOST, journals, current: () => true, send: message => { sent.push(message); },
    scheduler: { setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => undefined },
    published: (sessionKey, result) => { published.push({ sessionKey, result }); },
  });
  const open = async (): Promise<number> => {
    await connection.receive(wire({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }));
    const opened = sent.find(message => message.type === 'journal_opened');
    return (opened as { generation: number }).generation;
  };
  return { journals, connection, sent, published, open };
}

describe('the Controller\'s unserve and request refusals', () => {
  it('clears the head of a session the Controller gave up on, and tells the broker so its streams close', async () => {
    const { journals, connection, published, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    expect(journals.served(HOST, SESSION)).toBe(true);
    published.length = 0;
    await connection.receive(wire({ type: 'journal_unserve', sessionKey: SESSION, generation }));
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ sessionKey: SESSION, result: { unserved: true, hasHead: false } });
  });

  it('ignores an unserve from a generation this connection did not open', async () => {
    const { journals, connection, published, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    published.length = 0;
    await connection.receive(wire({ type: 'journal_unserve', sessionKey: SESSION, generation: generation + 1 }));
    await connection.receive(wire({ type: 'journal_unserve', sessionKey: 'codex:other', generation }));
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(published).toEqual([]);
  });

  it('ignores an unserve for a session this connection never opened, whoever published its head', async () => {
    const { journals, connection, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    const published: string[] = [];
    const other = createJournalConnection({ hostId: HOST, journals, current: () => true, send: () => undefined,
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined }, published: sessionKey => { published.push(sessionKey); } });
    await other.receive(wire({ type: 'journal_unserve', sessionKey: SESSION, generation }));
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(published).toEqual([]);
  });

  it('rejects a pending fill or older-history request at once when the Controller refuses it', async () => {
    const { connection, sent } = fixture();
    const fill = connection.requestFill(SESSION, ['m1']);
    const older = connection.requestOlder(SESSION, 20);
    const ids = sent.flatMap(message => 'requestId' in message ? [[message.type, message.requestId] as const] : []);
    const fillId = ids.find(([type]) => type === 'journal_fill_request')![1];
    const olderId = ids.find(([type]) => type === 'journal_older_request')![1];
    await connection.receive(wire({ type: 'journal_request_refused', requestId: fillId, sessionKey: SESSION, reason: 'not_followed' }));
    await connection.receive(wire({ type: 'journal_request_refused', requestId: olderId, sessionKey: SESSION, reason: 'not_ready' }));
    await expect(fill).rejects.toMatchObject({ code: 'refused' });
    await expect(older).rejects.toBeInstanceOf(JournalRequestError);
  });

  it('opens without an index when the Controller asks for a reset, and tells the broker the session stopped being served', async () => {
    const { journals, connection, sent, published, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    published.length = 0;
    sent.length = 0;
    await connection.receive(wire({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1', reset: true }));
    const opened = sent.find(message => message.type === 'journal_opened') as { generation: number; watermark: number; index: unknown[]; indexAfter?: number };
    expect(opened).toMatchObject({ generation: generation + 1, index: [] });
    expect(opened.indexAfter).toBeUndefined();
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect(published).toEqual([{ sessionKey: SESSION, result: { events: [], watermark: 0, unserved: true } }]);
    sent.length = 0;
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation: opened.generation, entries: [{ sequence: opened.watermark + 1, op: 'head', head: { snapshot, observedAt: 6 } }] }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'journal_refused', reason: 'incomplete' }));
  });

  it('accepts the entry that follows a refused one under the refused number, and does not take it for a duplicate', async () => {
    const { connection, sent, open } = fixture();
    const generation = await open();
    const row = (itemKey: string) => ({ itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1, item: { type: 'assistant_message', text: itemKey, messageId: itemKey } });
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [
      { sequence: 1, op: 'append', row: row('a') }, { sequence: 2, op: 'correct', row: row('ghost'), expectedRevision: 1 }, { sequence: 3, op: 'append', row: row('b') },
    ] }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'journal_ack', watermark: 1 }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'journal_refused', sequence: 2, reason: 'unknown_item', itemKey: 'ghost' }));
    sent.length = 0;
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 2, op: 'append', row: row('b') }] }));
    expect(sent).toEqual([expect.objectContaining({ type: 'journal_ack', watermark: 2, cursor: expect.objectContaining({ seq: 2 }) })]);
  });

  it('ignores a refusal that names no pending request of that session', async () => {
    const { connection, sent } = fixture();
    const fill = connection.requestFill(SESSION, ['m1']);
    const fillId = sent.flatMap(message => message.type === 'journal_fill_request' ? [message.requestId] : [])[0]!;
    await connection.receive(wire({ type: 'journal_request_refused', requestId: fillId, sessionKey: 'codex:other', reason: 'not_followed' }));
    await connection.receive(wire({ type: 'journal_request_refused', requestId: 'unknown', sessionKey: SESSION, reason: 'not_followed' }));
    connection.close();
    await expect(fill).rejects.toMatchObject({ code: 'closed' });
  });
});
```

- [ ] **Step 6: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-uplink-controller-messages.test.ts --testTimeout=10000`
Expected: FAIL (the adapter does not handle the two messages).

- [ ] **Step 7: Implement the connection adapter.** In `packages/agent-remote-hosted/src/journal-uplink.ts`:

<!-- edit: packages/agent-remote-hosted/src/journal-uplink.ts -->
<!-- old -->
```ts
export type JournalHostMessage = Extract<RemoteHostUplinkMessage, { type: 'journal_open' | 'journal_index_request' | 'journal_publish' | 'journal_fill' | 'journal_older_done' }>;

export function isJournalHostMessage(message: RemoteHostUplinkMessage): message is JournalHostMessage {
  return message.type === 'journal_open' || message.type === 'journal_index_request' || message.type === 'journal_publish' || message.type === 'journal_fill' || message.type === 'journal_older_done';
}
```
<!-- new -->
```ts
export type JournalHostMessage = Extract<RemoteHostUplinkMessage,
  { type: 'journal_open' | 'journal_index_request' | 'journal_publish' | 'journal_fill' | 'journal_older_done' | 'journal_unserve' | 'journal_request_refused' }>;

export function isJournalHostMessage(message: RemoteHostUplinkMessage): message is JournalHostMessage {
  return message.type === 'journal_open' || message.type === 'journal_index_request' || message.type === 'journal_publish' || message.type === 'journal_fill' || message.type === 'journal_older_done'
    || message.type === 'journal_unserve' || message.type === 'journal_request_refused';
}
```

<!-- edit: packages/agent-remote-hosted/src/journal-uplink.ts -->
<!-- old -->
```ts
  constructor(readonly code: 'invalid' | 'unavailable' | 'busy' | 'in_flight' | 'timeout' | 'closed', message: string) {
```
<!-- new -->
```ts
  constructor(readonly code: 'invalid' | 'unavailable' | 'busy' | 'in_flight' | 'timeout' | 'closed' | 'refused', message: string) {
```

<!-- edit: packages/agent-remote-hosted/src/journal-uplink.ts -->
<!-- old -->
```ts
        case 'journal_older_done': {
          const found = pendingFor(message.requestId, 'older', message.sessionKey);
          if (!found) return;
          settle(message.requestId, found);
          found.resolve({ olderAvailable: message.olderAvailable });
          return;
        }
```
<!-- new -->
```ts
        case 'journal_older_done': {
          const found = pendingFor(message.requestId, 'older', message.sessionKey);
          if (!found) return;
          settle(message.requestId, found);
          found.resolve({ olderAvailable: message.olderAvailable });
          return;
        }
        case 'journal_unserve': {
          const { sessionKey, generation } = message;
          if (opened.get(sessionKey) !== generation) return;
          const result = await journals.unserveHead(hostId, sessionKey, generation);
          if (!result) return;
          try { options.published?.(sessionKey, result); }
          catch { options.diagnostic?.('journal_fanout_failed'); }
          return;
        }
        case 'journal_request_refused': {
          const found = pending.get(message.requestId);
          if (!found || found.sessionKey !== message.sessionKey) return;
          settle(message.requestId, found);
          found.reject(new JournalRequestError('refused', `The Controller refused the journal ${found.kind} request: ${message.reason}.`));
          return;
        }
```

The reset reaches the journal, and a reset that cleared a served head tells the broker as a refused open does:

<!-- edit: packages/agent-remote-hosted/src/journal-uplink.ts -->
<!-- old -->
```ts
            { maxIndexItems: JOURNAL_INDEX_MAX_ITEMS, pageItems: JOURNAL_INDEX_PAGE_MAX_ITEMS, allowed: () => options.current() });
          if ('refused' in result && result.unserved) {
            // The refusal took the session out of serving, as a quota refusal of a publication does: the broker is told the same way.
```
<!-- new -->
```ts
            { maxIndexItems: JOURNAL_INDEX_MAX_ITEMS, pageItems: JOURNAL_INDEX_PAGE_MAX_ITEMS, allowed: () => options.current(), ...(message.reset ? { reset: true } : {}) });
          if (result.unserved) {
            // The open took the session out of serving, as a quota refusal of a publication does: the broker is told the same way.
```

- [ ] **Step 8: Run the connection test and see it pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-uplink-controller-messages.test.ts --testTimeout=10000`
Expected: PASS.

- [ ] **Step 9: Write the failing test of the grant.** The Relay grants journals at the level the Controller asks for, and only that. Create `packages/agent-remote-hosted/src/broker-journal-grant.test.ts`:

<!-- write: packages/agent-remote-hosted/src/broker-journal-grant.test.ts -->
```ts
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostBroker } from './index.js';
import { createHostJournals, type HostJournals } from './host-journals.js';
import { createPartitionJournals, type JournalPartitionApi } from './journal-partition.js';
import { collect, socketPair, until } from './test-utils/journal-session-fixture.js';

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function connected(query: string, journals: MemoryJournalStore | undefined, journalService?: HostJournals) {
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000, ...(journalService ? { journalService } : journals ? { journals } : {}) });
  closers.push(() => broker.close());
  const pairing = await broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${query}`, { headers: { authorization: `Bearer ${key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = socketPair(closers);
  const inbox = collect(pair.native);
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const registered = await inbox.take(message => message.type === 'registered', 'registered');
  return { pair, inbox, registered };
}

async function connectWithoutRegistered(query: string, journalService: HostJournals) {
  const broker = createHostBroker({ origin: 'https://relay.example', rpcTimeoutMs: 1000, journalService });
  closers.push(() => broker.close());
  const pairing = await broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const prepared = await broker.prepareUpgrade(new Request(`https://relay.example/ws/remote-host${query}`, { headers: { authorization: `Bearer ${key}` } }));
  if (!prepared || prepared instanceof Response) throw new Error('Host upgrade rejected');
  const pair = socketPair(closers);
  const inbox = collect(pair.native);
  prepared.accept(pair.server);
  pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  return { pair, inbox };
}

const registered = async (query: string, journals: MemoryJournalStore | undefined, journalService?: HostJournals): Promise<Record<string, unknown>> =>
  (await connected(query, journals, journalService)).registered;

describe('the journal grant', () => {
  it('is acknowledged at level 2 for a Controller that asks for 2', async () => {
    expect((await registered('?journal=2', new MemoryJournalStore())).journal).toBe(2);
  });

  it('is acknowledged at level 1 for one that asks for 1, and absent for one that does not ask', async () => {
    expect((await registered('?journal=1', new MemoryJournalStore())).journal).toBe(1);
    expect((await registered('', new MemoryJournalStore())).journal).toBeUndefined();
  });

  it('grants level 1 to a Controller that asks for 2 of a journal service that reports only 1', async () => {
    const service = { ...createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 }), capabilities: async () => ({ journal: 1 as const }) };
    expect((await registered('?journal=2', undefined, service)).journal).toBe(1);
  });

  it('grants level 1 when the partition lacks the capabilities method', async () => {
    const own = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const service = createPartitionJournals({ partition: () => ({ capabilities: async () => { throw new TypeError('The RPC receiver does not implement the method "capabilities".'); } }) as unknown as JournalPartitionApi });
    expect((await registered('?journal=2', undefined, { ...own, capabilities: service.capabilities })).journal).toBe(1);
  });

  it('closes the connection with 1013 when the capabilities fail, so the Controller connects and asks again', async () => {
    const own = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const { pair, inbox } = await connectWithoutRegistered('?journal=2', { ...own, capabilities: async () => { throw new Error('The Durable Object is overloaded.'); } });
    await until(() => pair.native.closeCode === 1013 || undefined, 'the connection to close');
    expect(inbox.all.some(message => message.type === 'registered')).toBe(false);
  });

  it('closes the connection with 1013 when the capabilities do not arrive within three seconds', async () => {
    const own = createHostJournals({ store: new MemoryJournalStore(), now: () => 1_000 });
    const started = Date.now();
    const { pair, inbox } = await connectWithoutRegistered('?journal=2', { ...own, capabilities: () => new Promise(() => undefined) });
    while (pair.native.closeCode === undefined && Date.now() - started < 4500) await new Promise(resolve => setTimeout(resolve, 20));
    expect(pair.native.closeCode).toBe(1013);
    expect(Date.now() - started).toBeLessThan(4500);
    expect(inbox.all.some(message => message.type === 'registered')).toBe(false);
  });

  it('closes, with 1008, a connection granted 1 that sends what needs 2, and keeps one granted 2', async () => {
    const row = { itemKey: 'a', providerId: 'codex', sourceKey: 'a:1', occurredAt: 1, item: { type: 'assistant_message', text: 'Hi', messageId: 'a' } };
    const open = { uplinkVersion: 2, type: 'journal_open', requestId: 'open-1', sessionKey: 'codex:thread-1', publisherId: 'controller-1' };
    const entries = [{ sequence: 1, op: 'append', row }, { sequence: 2, op: 'rebind', itemKey: 'a', previous: { locator: 'x', resourceId: 'r1', status: 'pending' }, replacement: { locator: 'x', resourceId: 'r2', status: 'available' } }];
    for (const [query, closed] of [['?journal=1', 1008], ['?journal=2', undefined]] as const) {
      const { pair, inbox } = await connected(query, new MemoryJournalStore());
      pair.native.send(JSON.stringify(open));
      const opened = await inbox.take(message => message.type === 'journal_opened', 'journal_opened');
      pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'journal_publish', sessionKey: 'codex:thread-1', generation: opened.generation, entries }));
      if (closed) await until(() => pair.native.closeCode === closed || undefined, 'the connection to close');
      else { await inbox.take(message => message.type === 'journal_ack', 'journal_ack'); expect(pair.native.closeCode).toBeUndefined(); }
    }
  });

  it('closes, with 1008, a connection granted 1 for each message that needs 2', async () => {
    const row = { itemKey: 'a', providerId: 'codex', sourceKey: 'a:1', occurredAt: 1, item: { type: 'assistant_message', text: 'Hi', messageId: 'a' } };
    const snapshot = { id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
      capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
      pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' } };
    const sessionKey = 'codex:thread-1';
    const needsTwo: Array<(generation: number) => Record<string, unknown>> = [
      generation => ({ type: 'journal_unserve', sessionKey, generation }),
      () => ({ type: 'journal_request_refused', requestId: 'request-1', sessionKey, reason: 'not_followed' }),
      () => ({ type: 'journal_open', requestId: 'open-2', sessionKey, publisherId: 'controller-1', reset: true }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'correct', row, expectedRevision: 1 }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'replace', items: [{ row }] }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'prepend', items: [{ row }] }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: 'a' } }] }),
      generation => ({ type: 'journal_publish', sessionKey, generation, entries: [{ sequence: 1, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 }] }),
    ];
    for (const message of needsTwo) {
      const { pair, inbox } = await connected('?journal=1', new MemoryJournalStore());
      pair.native.send(JSON.stringify({ uplinkVersion: 2, type: 'journal_open', requestId: 'open-1', sessionKey, publisherId: 'controller-1' }));
      const opened = await inbox.take(candidate => candidate.type === 'journal_opened', 'journal_opened');
      pair.native.send(JSON.stringify({ uplinkVersion: 2, ...message(opened.generation) }));
      await until(() => pair.native.closeCode === 1008 || undefined, `the connection to close for ${String(message(1).type)}`);
    }
  });

  it('is never acknowledged by a Relay without a journal store', async () => {
    expect((await registered('?journal=2', undefined)).journal).toBeUndefined();
  });
});
```

- [ ] **Step 10: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journal-grant.test.ts --testTimeout=10000`
Expected: FAIL (`journal=2` is not understood, so no grant at all; a grant-1 connection is not closed for a grant-2 entry; a service that reports 1 still gets 2).

- [ ] **Step 11: Implement the grant.** In `packages/agent-remote-hosted/src/broker.ts`, the Host remembers the level it granted:

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
  journal?: JournalConnection;
```
<!-- new -->
```ts
  journal?: JournalConnection;
  /** The journal level acknowledged to this Controller: 2 includes amendments, open items, unserving and request refusals. */
  journalGrant?: 1 | 2;
```

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
outboxRequested = false, journalRequested = false) {
```
<!-- new -->
```ts
outboxRequested = false, journalRequested: 0 | 1 | 2 = 0) {
```

The level is settled once, before the journal connection is made. `registered` already resumes itself after a wait (the pending deletion), so it does the same for the capability read:

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
    let pendingDeletionHandled = false;
```
<!-- new -->
```ts
    let pendingDeletionHandled = false;
    /** The journal level this connection is granted; known once the service has told what it supports. */
    let capabilitiesPending = false;
    let journalLevel: 0 | 1 | 2 | undefined = journals && journalRequested ? (journalRequested === 2 ? undefined : 1) : 0;
```

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
      host.tunnelToken ??= randomBytes(32).toString('base64url');
      const journalHost = host;
```
<!-- new -->
```ts
      if (journalLevel === undefined) {
        // A Controller that asked for 2 gets it only from a service that reports 2.
        // A failure to learn what the service supports is not a reason to grant less: the Controller connects again and asks again.
        if (capabilitiesPending) return;
        capabilitiesPending = true;
        const unavailable = setTimeout(() => closeConnection(1013, 'Journal capabilities unavailable'), JOURNAL_CAPABILITIES_WAIT_MS);
        journals!.capabilities(host.id).then(capabilities => {
          clearTimeout(unavailable);
          if (retired) return;
          journalLevel = capabilities.journal >= 2 ? 2 : 1;
          registered();
        }, () => { clearTimeout(unavailable); closeConnection(1013, 'Journal capabilities unavailable'); });
        return;
      }
      host.tunnelToken ??= randomBytes(32).toString('base64url');
      const journalHost = host;
```

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
      host.journal ??= journalRequested && journals
```
<!-- new -->
```ts
      if (journalLevel && journals && !host.journal) host.journalGrant = journalLevel;
      host.journal ??= journalRequested && journals
```

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
...(host.journal ? { journal: 1 as const } : {}),
```
<!-- new -->
```ts
...(host.journal ? { journal: host.journalGrant ?? 1 } : {}),
```

A connection granted 1 never sends grant-2 entries or messages. When one does, it is closed, as every other protocol violation of the uplink is. The check sits next to the existing journal gate of the message handler:

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
        if (!host.journal) return closeConnection(1008, 'Journals were not acknowledged');
```
<!-- new -->
```ts
        if (!host.journal) return closeConnection(1008, 'Journals were not acknowledged');
        if (host.journalGrant !== 2 && needsJournalGrantTwo(message)) return closeConnection(1008, 'Journal grant 2 was not acknowledged');
```

`needsJournalGrantTwo` is a pure function in `journal-uplink.ts`, exported with `isJournalHostMessage`; `JournalHostMessage` gains `journal_unserve` and `journal_request_refused`:

```ts
export function needsJournalGrantTwo(message: JournalHostMessage): boolean {
  switch (message.type) {
    case 'journal_unserve': case 'journal_request_refused': return true;
    case 'journal_open': return message.reset === true;
    case 'journal_publish': return message.entries.some(entry => entry.op === 'rebind' || entry.op === 'outcome'
      || (entry.op === 'correct' && entry.digest === undefined)
      || ((entry.op === 'replace' || entry.op === 'prepend') && entry.items.some(item => item.digest === undefined))
      || (entry.op === 'head' && entry.head.attentionItemKey !== undefined));
    default: return false;
  }
}
```

The broker imports it next to `isJournalHostMessage`.

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
    host.journal?.close(); host.journal = undefined;
```
<!-- new -->
```ts
    host.journal?.close(); host.journal = undefined; host.journalGrant = undefined;
```

<!-- edit: packages/agent-remote-hosted/src/broker.ts -->
<!-- old -->
```ts
url.searchParams.get('journal') === '1');
```
<!-- new -->
```ts
url.searchParams.get('journal') === '2' ? 2 : url.searchParams.get('journal') === '1' ? 1 : 0);
```

- [ ] **Step 12: Run the grant test and see it pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/broker-journal-grant.test.ts --testTimeout=10000`
Expected: PASS.

- [ ] **Step 13: Write the failing stream tests.** Create `packages/agent-remote-hosted/src/journal-session-stream-amendments.test.ts`. It has a small fixture of its own: a journal read straight from a `SessionJournal`, a recording browser socket, and a Controller stream the test drives:

<!-- write: packages/agent-remote-hosted/src/journal-session-stream-amendments.test.ts -->
```ts
import { SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { JournalPublished } from './host-journals.js';
import type { HostStream, HostStreamOpener, HostStreamSink } from './journal-host-stream.js';
import { createJournalSessionStream, type JournalReads } from './journal-session-stream.js';

type Wire = Record<string, any>;
const request = { kind: 'question' as const, requestId: 'question-1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single' as const, options: [{ value: 'a', label: 'A', description: 'a' }], allowCustomText: false, allowDismiss: false }] };
const snapshot = (pending: unknown[] = []): AgentSnapshotPayload => ({
  id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: pending as never, runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status: 'idle' },
});
const frame = (fields: Wire) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...fields });

function fixture() {
  const journal = SessionJournal.create('host-1:codex:thread-1');
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
  const reads: JournalReads = {
    status: async () => ({ cursor: journal.cursor, ...(journal.head ? { head: journal.head } : {}) }),
    page: async pageRequest => journal.page(pageRequest, { olderBeyondJournal: false }),
    fill: async () => undefined, older: async () => undefined, olderBeyondJournal: () => false,
  };
  const sent: Wire[] = [];
  const closes: Array<number | undefined> = [];
  const client = { readyState: 1, bufferedAmount: 0 as number | undefined, send: (data: string) => { sent.push(JSON.parse(data)); }, close: (code?: number) => { closes.push(code); } };
  let sink: HostStreamSink | undefined;
  const hostStreams: HostStreamOpener = { async open(next) { sink = next; const stream: HostStream = { send: () => undefined, close: () => undefined }; return stream; } };
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const scheduler = { setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (timer: unknown) => { timers.delete(timer as number); } };
  const stream = createJournalSessionStream({ publicAgentId: 'agent', client, reads, hostStreams, scheduler });
  const published = (events: JournalPublished['events']): JournalPublished => ({ events, watermark: sequence, cursor: journal.cursor });
  return {
    journal, sent, closes, at, stream, sink: () => sink!, timers,
    types: () => sent.map(message => message.type),
    fromController: (fields: Wire) => sink!.frame(frame(fields)),
    setHead(pending: unknown[]): JournalPublished {
      journal.setHead(at(), { snapshot: snapshot(pending), observedAt: 6 });
      return published([{ kind: 'head', head: journal.head! }]);
    },
    async ready(subscribe = true) {
      stream.receive(frame({ type: 'negotiate' }));
      await vi.waitFor(() => expect(sink).toBeDefined());
      if (subscribe) stream.receive(frame({ type: 'timeline_subscription', payload: { requestId: 'sub-1', agentIds: ['agent'] } }));
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(subscribe ? 4 : 3));
      sink!.ready();
      await vi.waitFor(() => expect(sent.at(-1)?.type).toBe('agent_update'));
    },
    published,
  };
}

describe('amendments of a journal-served stream', () => {
  it('sends a replaced resource binding to a subscriber, found by the item\'s epoch and sequence', async () => {
    const f = await (async () => { const value = fixture(); await value.ready(); return value; })();
    const previous = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' as const };
    const replacement = { locator: 'docs/plan.md', resourceId: 'resource-2', status: 'available' as const };
    f.stream.deliver(f.published([{ kind: 'rebound', epoch: 'epoch-1', seq: 7, previous, replacement }]));
    expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_resource_binding_replaced', payload: { agentId: 'agent', epoch: 'epoch-1', seq: 7, previous, replacement } });
  });

  it('sends a background outcome as the agent_stream frame the session wire sends', async () => {
    const f = await (async () => { const value = fixture(); await value.ready(); return value; })();
    f.stream.deliver(f.published([
      { kind: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_000 },
    ]));
    expect(f.sent.at(-1)).toEqual({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: { agentId: 'agent', timestamp: '2024-08-30T06:40:00.000Z',
      event: { type: 'background_activity_updated', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' } } } });
  });

  it('does not send an amendment of the timeline to a stream that did not subscribe, but still sends an outcome', async () => {
    const f = fixture();
    await f.ready(false);
    const before = f.sent.length;
    f.stream.deliver(f.published([{ kind: 'rebound', epoch: 'epoch-1', seq: 1, previous: { locator: 'a', resourceId: 'r1', status: 'pending' }, replacement: { locator: 'a', resourceId: 'r2', status: 'available' } }]));
    expect(f.sent).toHaveLength(before);
    f.stream.deliver(f.published([{ kind: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'failed' }, occurredAt: 1_725_000_000_000 }]));
    expect(f.sent.at(-1)).toMatchObject({ type: 'agent_stream', payload: { event: { type: 'background_activity_updated' } } });
  });
});

describe('the attention cursor of a served head', () => {
  it('is served as a live cursor when the attention item sits below the first sequence', async () => {
    const f = fixture();
    const text = (itemKey: string) => ({ row: { itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'assistant_message' as const, text: itemKey, messageId: itemKey } }, digest: 'a'.repeat(64) });
    f.journal.replace(f.at(), [text('a')], 1_000);
    f.journal.prepend(f.at(), [text('p1'), text('p2'), text('p3')]);
    f.journal.setHead(f.at(), { snapshot: { ...snapshot(), attention: { cursor: { epoch: 'controller-epoch', seq: 7 } } }, observedAt: 7, attentionItemKey: 'p1' });
    await f.ready(false);
    expect(f.sent.find(message => message.type === 'agent_snapshot')?.payload.attention.cursor).toEqual({ epoch: f.journal.epoch, seq: 0 });
    expect(f.closes).toEqual([]);
  });
});

describe('interaction frames from the Controller', () => {
  it('reach the browser at once when the head it was sent already agrees', async () => {
    const f = fixture();
    await f.ready();
    f.stream.deliver(f.setHead([request]));
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request } });
    expect(f.sent.at(-1)).toMatchObject({ type: 'interaction_requested', payload: { request: { requestId: 'question-1' } } });
    f.stream.deliver(f.setHead([]));
    f.fromController({ type: 'interaction_resolved', payload: { agentId: 'agent', requestId: 'question-1', response: { kind: 'question', answers: [] } } });
    expect(f.sent.at(-1)).toMatchObject({ type: 'interaction_resolved' });
  });

  it('wait for the head that carries the question, so an older head never overtakes the question', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request } });
    expect(f.sent).toHaveLength(before);
    f.stream.deliver(f.setHead([request]));
    expect(f.types().slice(before)).toEqual(['agent_update', 'interaction_requested']);
    expect(f.sent[before]!.payload.pendingInteractions).toHaveLength(1);
  });

  it('wait for the head that no longer lists a resolved question, and keep their order', async () => {
    const f = fixture();
    await f.ready();
    f.stream.deliver(f.setHead([request]));
    const before = f.sent.length;
    f.fromController({ type: 'interaction_resolved', payload: { agentId: 'agent', requestId: 'question-1', response: { kind: 'question', answers: [] } } });
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request: { ...request, requestId: 'question-2' } } });
    expect(f.sent).toHaveLength(before);
    f.stream.deliver(f.setHead([{ ...request, requestId: 'question-2' }]));
    expect(f.types().slice(before)).toEqual(['agent_update', 'interaction_resolved', 'interaction_requested']);
  });

  it('are sent after two seconds even when no head agrees, and the timer is cleared when the stream ends', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request } });
    expect(f.timers.size).toBe(1);
    for (const [id, callback] of [...f.timers]) { f.timers.delete(id); callback(); }
    expect(f.sent.slice(before).map(message => message.type)).toEqual(['interaction_requested']);
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request: { ...request, requestId: 'question-3' } } });
    expect(f.timers.size).toBe(1);
    f.stream.close();
    expect(f.timers.size).toBe(0);
  });

  it('are bounded in bytes too: past one mebibyte of waiting frames the oldest is sent at once', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    const large = (at: number) => ({ ...request, requestId: `large-${at}`, questions: [{ ...request.questions[0]!, prompt: 'x'.repeat(400_000) }] });
    for (let at = 0; at < 3; at += 1) f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request: large(at) } });
    expect(f.sent.slice(before).map(message => message.payload.request.requestId)).toEqual(['large-0']);
    expect(f.timers.size).toBe(2);
  });

  it('are dropped, without a timer, when they arrive after the stream closed', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    f.stream.close();
    f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request } });
    expect(f.timers.size).toBe(0);
    expect(f.sent).toHaveLength(before);
  });

  it('are bounded: past 64 waiting frames the oldest is sent at once', async () => {
    const f = fixture();
    await f.ready();
    const before = f.sent.length;
    for (let at = 0; at < 70; at += 1) f.fromController({ type: 'interaction_requested', payload: { agentId: 'agent', request: { ...request, requestId: `question-${at}` } } });
    expect(f.sent.length - before).toBe(6);
    expect(f.sent[before]!.payload.request.requestId).toBe('question-0');
    expect(f.timers.size).toBe(64);
  });
});
```

- [ ] **Step 14: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-session-stream-amendments.test.ts --testTimeout=10000`
Expected: FAIL (the stream ignores the new events and forwards interaction frames at once).

- [ ] **Step 15: Implement the stream.** In `packages/agent-remote-hosted/src/journal-session-stream.ts`, import the background type, and add the hold bounds next to the other constants:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
  type AgentSnapshotPayload, type AgentStatus, type ClientMessage,
```
<!-- new -->
```ts
  type AgentSnapshotPayload, type AgentStatus, type BackgroundActivity, type ClientMessage,
```


<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
const ACTIVITY_COALESCE_MS = 500;
```
<!-- new -->
```ts
const ACTIVITY_COALESCE_MS = 500;
/** How long an interaction frame of the Controller waits for the head to agree with it. */
const INTERACTION_HOLD_MS = 2000;
/** How many interaction frames wait at once; past it the oldest is sent without waiting. */
const INTERACTION_PARKED_MAX = 64;
const INTERACTION_FRAMES = new Set(['interaction_requested', 'interaction_resolved', 'interaction_invalidated']);
```

Track the head that was sent to the browser and the frames that wait for it:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
  /** The control revision of the Controller session, once it has reported one. */
  let controlRevision: string | undefined;
```
<!-- new -->
```ts
  /** The control revision of the Controller session, once it has reported one. */
  let controlRevision: string | undefined;
  /** The head the browser was last sent: the pending interactions it shows are what the browser's reducer takes from it. */
  let servedHead: JournalHead | undefined;
  /** Interaction frames of the Controller that wait for the served head to agree, in the order they arrived. */
  const parkedInteractions: Array<{ raw: string; requestId: string; present: boolean; expired: boolean; timer: unknown }> = [];
```

Release them when the stream ends:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
    held.length = 0;
    heldControl.length = 0;
    queued.length = 0;
    if (code !== undefined) closeClient(code, reason);
```
<!-- new -->
```ts
    held.length = 0;
    heldControl.length = 0;
    queued.length = 0;
    for (const item of parkedInteractions.splice(0)) scheduler.clearTimeout(item.timer);
    if (code !== undefined) closeClient(code, reason);
```

Add the helpers after `snapshotMessage`:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
  const streamFrame = (row: JournalRow): ServerMessage => ({
```
<!-- new -->
```ts
  /** Sends the head and then the interaction frames that were waiting for it. */
  function sendHead(type: 'agent_snapshot' | 'agent_update', head: JournalHead): void {
    sendServer(snapshotMessage(type, head));
    servedHead = head;
    releaseInteractionFrames();
  }

  const headAgrees = (item: { requestId: string; present: boolean }): boolean =>
    servedHead === undefined || servedHead.snapshot.pendingInteractions.some(({ requestId }) => requestId === item.requestId) === item.present;

  /** Sends the waiting frames from the front while the head agrees with them or they waited long enough. */
  function releaseInteractionFrames(): void {
    while (parkedInteractions.length > 0) {
      const next = parkedInteractions[0]!;
      if (!next.expired && !headAgrees(next)) return;
      parkedInteractions.shift();
      scheduler.clearTimeout(next.timer);
      sendRaw(next.raw);
    }
  }

  /** A frame that says a question was asked waits for a head that lists it; one that says it ended waits for a head that does not. */
  function holdInteractionFrame(raw: string, type: string, payload: { requestId?: unknown; request?: { requestId?: unknown } } | undefined): void {
    const requestId = type === 'interaction_requested' ? payload?.request?.requestId : payload?.requestId;
    if (typeof requestId !== 'string') { sendRaw(raw); return; }
    const item = { raw, requestId, present: type === 'interaction_requested', expired: false, timer: undefined as unknown };
    if (parkedInteractions.length === 0 && headAgrees(item)) { sendRaw(raw); return; }
    if (parkedInteractions.length >= INTERACTION_PARKED_MAX) {
      const oldest = parkedInteractions.shift()!;
      scheduler.clearTimeout(oldest.timer);
      sendRaw(oldest.raw);
    }
    item.timer = scheduler.setTimeout(() => { item.expired = true; releaseInteractionFrames(); }, INTERACTION_HOLD_MS);
    parkedInteractions.push(item);
  }

  /** The frame the session wire sends for a background outcome: an `agent_stream` event with no place in the timeline. */
  const outcomeFrame = (outcome: { providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number }): ServerMessage => ({
    protocolVersion: PROTOCOL_VERSION, type: 'agent_stream',
    payload: { agentId: publicAgentId, timestamp: new Date(outcome.occurredAt).toISOString(),
      event: { type: 'background_activity_updated', providerId: outcome.providerId, ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }), background: outcome.background } },
  });

  const streamFrame = (row: JournalRow): ServerMessage => ({
```

Use `sendHead` where a head is sent to a content stream:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
    if (activityOnly) observe(status.head.snapshot, status.cursor);
    else sendServer(snapshotMessage('agent_update', status.head));
  }
```
<!-- new -->
```ts
    if (activityOnly) observe(status.head.snapshot, status.cursor);
    else sendHead('agent_update', status.head);
  }
```

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
      sendServer(snapshotMessage('agent_snapshot', status.head));
```
<!-- new -->
```ts
      sendHead('agent_snapshot', status.head);
```

Hold the interaction frames of the Controller:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
    let parsed: { type?: unknown; payload?: { revision?: unknown } } | undefined;
    try { parsed = JSON.parse(raw); } catch { return; }
    const type = parsed?.type;
    if (typeof type !== 'string' || READ_PATH_FRAMES.has(type)) return;
    sendRaw(raw);
```
<!-- new -->
```ts
    let parsed: { type?: unknown; payload?: { revision?: unknown; requestId?: unknown; request?: { requestId?: unknown } } } | undefined;
    try { parsed = JSON.parse(raw); } catch { return; }
    const type = parsed?.type;
    if (typeof type !== 'string' || READ_PATH_FRAMES.has(type)) return;
    if (INTERACTION_FRAMES.has(type)) { holdInteractionFrame(raw, type, parsed?.payload); return; }
    sendRaw(raw);
```

Deliver every kind of event:

<!-- edit: packages/agent-remote-hosted/src/journal-session-stream.ts -->
<!-- old -->
```ts
    for (const event of result.events) {
      if (event.kind === 'head') { sendServer(snapshotMessage('agent_update', event.head)); continue; }
      if (!subscribed) continue;
      sendServer(event.kind === 'row' ? streamFrame(event.row)
        : { protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: publicAgentId, epoch: event.epoch } });
    }
  }
```
<!-- new -->
```ts
    for (const event of result.events) {
      switch (event.kind) {
        case 'head':
          sendHead('agent_update', event.head);
          break;
        case 'row':
          if (subscribed) sendServer(streamFrame(event.row));
          break;
        case 'replaced':
          if (subscribed) sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_replacement', payload: { agentId: publicAgentId, epoch: event.epoch } });
          break;
        case 'rebound':
          if (subscribed) {
            sendServer({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_resource_binding_replaced',
              payload: { agentId: publicAgentId, epoch: event.epoch, seq: event.seq, previous: event.previous, replacement: event.replacement } });
          }
          break;
        case 'outcome':
          sendServer(outcomeFrame(event));
          break;
      }
    }
  }
```

- [ ] **Step 16: Run the package and see it pass.**

Run: `pnpm --filter @orchardworks/agent-remote-hosted exec vitest run src/journal-session-stream-amendments.test.ts src/host-journals-amendments.test.ts src/journal-uplink-controller-messages.test.ts src/broker-journal-grant.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-hosted run test` then `pnpm --filter @orchardworks/agent-remote-hosted run typecheck` then `pnpm --filter @orchardworks/agent-remote-hosted run build`
Expected: PASS for all (989 tests of the package, with the partition tests). Rebuild the package: the Controller's tests use its journal service and its connection adapter from `dist`. Run the Cloudflare suite in two halves (22 and 15 test files); it covers the partition's Durable Object. The compatibility digest changes with this task: `git add` the new files, run `pnpm compatibility:update`, and commit `packages/agent-remote-lab/compatibility.json` with it. The landed suites of `journal-session-stream.test.ts` and `broker-journal-sessions.test.ts` must stay green; none of them sends an interaction frame through a stream whose head disagrees.

- [ ] **Step 17: Commit.**

```bash
git add packages/agent-remote-hosted/src packages/agent-remote-cloudflare packages/agent-remote-lab/compatibility.json
git commit -m "feat(hosted): grant journals at level 2, fan out amendments, take a session out of serving at the Controller's word, refuse requests at once and hold interaction frames until the served head agrees" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 5: The agent manager carries item identity and lets the journal publisher tap it

The Controller's timeline lives in `AgentManager`, which already turns every provider observation, history and live, into one ordered list of rows. The publisher needs three things from it that are not there: the item identity each row came with, a way to follow the manager without counting as a viewer (a listener keeps a session from being released), and the means to read older history for the journal without a browser asking.

**Files:**
- Modify: `packages/agent-remote-relay/src/timeline-store.ts`
- Modify: `packages/agent-remote-relay/src/timeline-projector.ts`
- Modify: `packages/agent-remote-relay/src/agent-manager-events.ts`
- Modify: `packages/agent-remote-relay/src/agent-manager.ts`
- Modify: `packages/agent-remote-relay/src/session-wire.test.ts`
- Create: `packages/agent-remote-relay/src/agent-manager-journal.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `packages/agent-remote-relay/src/agent-manager-journal.test.ts`:

<!-- write: packages/agent-remote-relay/src/agent-manager-journal.test.ts -->
```ts
import type { AgentCapabilities, AgentResourceReadResult, AgentRuntimeInfo, AgentSession, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentManagerEvent } from './agent-manager-events.js';
import { AgentManager, type AgentJournalTap } from './agent-manager.js';
import { rowItemKey } from './timeline-projector.js';

const capabilities: AgentCapabilities = {
  history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: true, planApproval: true, toolApproval: true },
};

class Stream implements AsyncIterable<ProviderStreamItem> {
  private readonly values: ProviderStreamItem[] = [];
  private waiter: ((result: IteratorResult<ProviderStreamItem>) => void) | undefined;
  private finished = false;
  push(value: ProviderStreamItem): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter({ done: false, value }); } else this.values.push(value);
  }
  finish(): void { this.finished = true; this.waiter?.({ done: true, value: undefined }); }
  [Symbol.asyncIterator](): AsyncIterator<ProviderStreamItem> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ done: false as const, value });
      if (this.finished) return Promise.resolve({ done: true as const, value: undefined });
      return new Promise<IteratorResult<ProviderStreamItem>>(resolve => { this.waiter = resolve; });
    } };
  }
}

interface Options { journalContract?: boolean; older?: Array<{ observations: ProviderObservation[]; nextCursor?: string }>; readResource?: () => Promise<AgentResourceReadResult> }

function session(stream: Stream, options: Options = {}): AgentSession {
  const runtime: AgentRuntimeInfo = { providerId: 'fake', sessionId: 'session-1', status: 'idle', persistence: { providerId: 'fake', sessionId: 'session-1', opaque: 'resume-1' } };
  const pages = [...(options.older ?? [])];
  return {
    capabilities: { ...capabilities, ...(options.readResource ? { readResource: true } : {}) },
    observe: () => stream,
    async sendMessage() {}, async respondToInteraction() {},
    async runtimeInfo() { return runtime; },
    async dispose() { stream.finish(); },
    ...(options.older ? { async readTimelineHistory() { return pages.shift() ?? { observations: [] }; } } : {}),
    ...(options.readResource ? { readResource: options.readResource } : {}),
  };
}

const observation = (sourceKey: string, text: string, key: string, extra: Partial<ProviderObservation> = {}): ProviderObservation => ({
  type: 'observation', sourceKey, occurredAt: 1_725_000_000_000, delivery: 'live',
  event: { type: 'timeline', provider: 'fake', turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key } },
  itemIdentity: { key }, ...extra,
});

async function attach(stream: Stream, options: Options = {}) {
  const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'fake', displayName: 'Fake' }, epoch: 'epoch-1', session: session(stream, options), ...(options.journalContract ? { journalContract: true } : {}) });
  return manager;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('the journal tap of an agent manager', () => {
  it('hands over the timeline as it stands, with the identity each row came with, and then every event', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:1', 'Hello', 'm1', { delivery: 'history' }), itemIdentity: { key: 'm1', completes: true } });
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    const subscription = manager.subscribeJournal({ event: event => events.push(event), closed: () => undefined });
    expect(subscription.rows.map(row => [row.seq, row.sourceKey, row.identity])).toEqual([[1, 'history:1', { key: 'm1', completes: true }]]);
    expect(subscription.snapshot.payload.id).toBe('agent-1');
    stream.push(observation('stream:2', 'Wor', 'm2'));
    stream.push(observation('stream:3', 'ld', 'm2', { itemIdentity: { key: 'm2', completes: true } }));
    await flush();
    const rows = events.flatMap(event => event.type === 'agent_stream' && event.row ? [event.row] : []);
    expect(rows.map(row => [row.seq, row.identity])).toEqual([[2, { key: 'm2' }], [3, { key: 'm2', completes: true }]]);
    expect(manager.itemRows('m2').map(row => row.sourceKey)).toEqual(['stream:2', 'stream:3']);
    expect(manager.itemRows('unknown')).toEqual([]);
    await manager.close();
  });

  it('does not count as a viewer, so an idle session can still be released', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    expect(manager.canReleaseIdle()).toBe(true);
    const subscription = manager.subscribeJournal({ event: () => undefined, closed: () => undefined });
    expect(manager.canReleaseIdle()).toBe(true);
    manager.subscribe(() => undefined);
    expect(manager.canReleaseIdle()).toBe(false);
    subscription.release();
    await manager.close();
  });

  it('stops delivering after release, and tells a tap that the session closed', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    const released: AgentManagerEvent[] = [], kept: AgentManagerEvent[] = [];
    let closed = 0;
    manager.subscribeJournal({ event: event => released.push(event), closed: () => undefined }).release();
    const tap: AgentJournalTap = { event: event => kept.push(event), closed: () => { closed += 1; } };
    manager.subscribeJournal(tap);
    stream.push(observation('stream:1', 'Hi', 'm1'));
    await flush();
    expect(released).toEqual([]);
    expect(kept.length).toBeGreaterThan(0);
    await manager.close();
    expect(closed).toBe(1);
  });

  it('tells a tap that subscribes after the manager closed, and gives it nothing', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    await manager.close();
    let closed = 0;
    const subscription = manager.subscribeJournal({ event: () => { throw new Error('No event can follow.'); }, closed: () => { closed += 1; } });
    expect(closed).toBe(1);
    expect(subscription.rows).toEqual([]);
    subscription.release();
  });

  it('gives a row without identity the key of its source, and finds the item of the row an attention cursor points at', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    stream.push({ ...observation('stream:1', 'Hi', 'm1'), itemIdentity: undefined });
    stream.push(observation('stream:2', 'There', 'm2'));
    await flush();
    const [first] = manager.itemRows('controller:stream:1');
    expect(first && rowItemKey(first)).toBe('controller:stream:1');
    expect(manager.attentionItemKey()).toBe('m2');
    await manager.close();
  });

  it('tells the tap once when a journal-capable provider emits an observation without identity, or a key of the Controller\'s own prefix', async () => {
    for (const breach of [{ itemIdentity: undefined }, { itemIdentity: { key: 'controller:m1' } }, { delivery: 'history' as const, itemIdentity: undefined }]) {
      const stream = new Stream();
      stream.push({ type: 'history_boundary' });
      const manager = await attach(stream, { journalContract: true });
      await manager.ready;
      let told = 0;
      manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
      stream.push(observation('stream:1', 'Hi', 'm1', breach));
      stream.push(observation('stream:2', 'Again', 'm2', { itemIdentity: undefined }));
      await flush();
      expect(told).toBe(1);
      await manager.close();
    }
  });

  it('tells a tap that an interaction was resolved without identity, and accepts one that carries it', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream, { journalContract: true });
    await manager.ready;
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    const resolved = { type: 'observation' as const, sourceKey: 'stream:1', occurredAt: 1, delivery: 'live' as const,
      event: { type: 'interaction_resolved' as const, provider: 'fake', requestId: 'q1', response: { kind: 'question' as const, answers: [] } } };
    stream.push({ ...resolved, itemIdentity: { key: 'question:q1', completes: true } });
    await flush();
    expect(told).toBe(0);
    stream.push({ ...resolved, sourceKey: 'stream:2' });
    await flush();
    expect(told).toBe(1);
    await manager.close();
  });

  it('does not tell a tap about a provider that does not declare journal support', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    const manager = await attach(stream);
    await manager.ready;
    let told = 0;
    manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    stream.push({ ...observation('stream:1', 'Hi', 'm1'), itemIdentity: undefined });
    await flush();
    expect(told).toBe(0);
    await manager.close();
  });

  it('reads one older page of native history into the timeline for the journal, and says whether more remains', async () => {
    const stream = new Stream();
    stream.push({ ...observation('history:5', 'Newest', 'm5', { delivery: 'history' }), itemIdentity: { key: 'm5', completes: true } });
    stream.push({ type: 'history_boundary', olderCursor: 'page-2' });
    const manager = await attach(stream, { older: [
      { observations: [
        { ...observation('history:3', 'Third', 'm3', { delivery: 'history' }), itemIdentity: { key: 'm3', completes: true } },
        { ...observation('history:4', 'Fourth', 'm4', { delivery: 'history' }), itemIdentity: { key: 'm4', completes: true } },
      ], nextCursor: 'page-3' },
      { observations: [{ ...observation('history:1', 'First', 'm1', { delivery: 'history' }), itemIdentity: { key: 'm1', completes: true } }] },
    ] });
    await manager.ready;
    expect(manager.hasOlderHistory()).toBe(true);
    expect(await manager.loadOlderHistory()).toEqual({ added: 2, more: true });
    expect(manager.timelineRows().map(row => row.identity?.key)).toEqual(['m3', 'm4', 'm5']);
    expect(await manager.loadOlderHistory()).toEqual({ added: 1, more: false });
    expect(manager.hasOlderHistory()).toBe(false);
    expect(await manager.loadOlderHistory()).toEqual({ added: 0, more: false });
    await manager.close();
  });

  it('tells a tap which item a replaced resource binding belongs to', async () => {
    const stream = new Stream();
    stream.push({ type: 'history_boundary' });
    let release!: (result: AgentResourceReadResult) => void;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    let reads = 0;
    const manager = await attach(stream, { readResource: () => {
      reads += 1;
      return reads === 1 ? Promise.resolve({ status: 'available', mediaType: 'image/png', bytes: png } as const) : new Promise<AgentResourceReadResult>(resolve => { release = resolve; });
    } });
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    manager.subscribeJournal({ event: event => events.push(event), closed: () => undefined });
    stream.push(observation('stream:1', 'First [output](output.png).', 'm1'));
    await flush();
    stream.push({ type: 'observation', sourceKey: 'stream:2', occurredAt: 2, delivery: 'live', itemIdentity: { key: 'tool:write-1', completes: true },
      event: { type: 'timeline', provider: 'fake', item: { type: 'tool_call', callId: 'write-1', name: 'write', status: 'completed', error: null, detail: { type: 'other', description: 'Reuse [output](output.png).' } } } });
    await flush();
    release({ status: 'available', mediaType: 'image/png', bytes: png });
    await flush();
    expect(events.find(event => event.type === 'timeline_resource_binding_replaced')).toMatchObject({ itemKey: 'tool:write-1', seq: 2 });
    await manager.close();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/agent-manager-journal.test.ts --testTimeout=10000`
Expected: FAIL (`subscribeJournal` and `rowItemKey` do not exist).

- [ ] **Step 3: Implement the row identity.** In `packages/agent-remote-relay/src/timeline-store.ts`, import the identity type and add it to the row:

<!-- edit: packages/agent-remote-relay/src/timeline-store.ts -->
<!-- old -->
```ts
import type { AgentTimelineItem } from '@orchardworks/agent-provider-sdk';
```
<!-- new -->
```ts
import type { AgentTimelineItem, ProviderItemIdentity } from '@orchardworks/agent-provider-sdk';
```

<!-- edit: packages/agent-remote-relay/src/timeline-store.ts -->
<!-- old -->
```ts
  turnId?: string;
  item: AgentTimelineItem;
  resources: ResourceBinding[];
}

export type TimelineRowInput
```
<!-- new -->
```ts
  turnId?: string;
  item: AgentTimelineItem;
  resources: ResourceBinding[];
  /** What the provider said about the item this row belongs to; absent for a provider that does not declare journal support. */
  identity?: ProviderItemIdentity;
}

/** The key a row's item has in a journal: the provider's, or one made from the row's source for a row that has none. */
export function rowItemKey(row: Pick<CanonicalTimelineRow, 'identity' | 'sourceKey'>): string {
  return row.identity?.key ?? `controller:${row.sourceKey}`;
}

export type TimelineRowInput
```

Index the rows by item and look them up:

<!-- edit: packages/agent-remote-relay/src/timeline-store.ts -->
<!-- old -->
```ts
  private readonly rowsBySourceRevision = new Map<string, Map<number | null, CanonicalTimelineRow>>();
```
<!-- new -->
```ts
  private readonly rowsBySourceRevision = new Map<string, Map<number | null, CanonicalTimelineRow>>();
  /** The rows of each item in sequence order; they are the rows of `timelineRows`, so later changes to a row show here. */
  private readonly rowsByItem = new Map<string, CanonicalTimelineRow[]>();
```

<!-- edit: packages/agent-remote-relay/src/timeline-store.ts -->
<!-- old -->
```ts
    this.applyBackground(row);
    this.timelineRows.push(row);
    if (sourceRevisions) sourceRevisions.set(revision, row);
    else this.rowsBySourceRevision.set(input.sourceKey, new Map([[revision, row]]));
    return { status: 'appended', row: structuredClone(row) };
  }
```
<!-- new -->
```ts
    this.applyBackground(row);
    this.timelineRows.push(row);
    this.indexItem(row, 'end');
    if (sourceRevisions) sourceRevisions.set(revision, row);
    else this.rowsBySourceRevision.set(input.sourceKey, new Map([[revision, row]]));
    return { status: 'appended', row: structuredClone(row) };
  }
```

<!-- edit: packages/agent-remote-relay/src/timeline-store.ts -->
<!-- old -->
```ts
    this.applyBackground(row);
    this.timelineRows.unshift(row);
    if (revisions) revisions.set(revision, row);
```
<!-- new -->
```ts
    this.applyBackground(row);
    this.timelineRows.unshift(row);
    this.indexItem(row, 'start');
    if (revisions) revisions.set(revision, row);
```

<!-- edit: packages/agent-remote-relay/src/timeline-store.ts -->
<!-- old -->
```ts
  updateBackground(background: BackgroundActivity): void {
```
<!-- new -->
```ts
  private indexItem(row: CanonicalTimelineRow, end: 'start' | 'end'): void {
    const key = rowItemKey(row);
    const rows = this.rowsByItem.get(key);
    if (!rows) this.rowsByItem.set(key, [row]);
    else if (end === 'end') rows.push(row);
    else rows.unshift(row);
  }

  /** How many rows the timeline holds. */
  rowCount(): number { return this.timelineRows.length; }

  /** The rows of one item in sequence order, as they stand now; none for a key the timeline does not know. */
  rowsOfItem(key: string): CanonicalTimelineRow[] {
    return structuredClone(this.rowsByItem.get(key) ?? []);
  }

  /** The key of the item the row at `seq` belongs to. */
  itemKeyAt(seq: number): string | undefined {
    let low = 0;
    let high = this.timelineRows.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const row = this.timelineRows[middle] as CanonicalTimelineRow;
      if (row.seq === seq) return rowItemKey(row);
      if (row.seq < seq) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  updateBackground(background: BackgroundActivity): void {
```

In `packages/agent-remote-relay/src/timeline-projector.ts`, export the key function with the row type, for the subpath `@orchardworks/agent-remote-relay/timeline-projection`:

<!-- edit: packages/agent-remote-relay/src/timeline-projector.ts -->
<!-- old -->
```ts
export type { CanonicalTimelineRow } from './timeline-store.js';
```
<!-- new -->
```ts
export { rowItemKey, type CanonicalTimelineRow } from './timeline-store.js';
```

- [ ] **Step 4: Implement the manager.** The resource-binding event names its item:

<!-- edit: packages/agent-remote-relay/src/agent-manager-events.ts -->
<!-- old -->
```ts
      epoch: string;
      seq: number;
      previous: ResourceBinding;
```
<!-- new -->
```ts
      epoch: string;
      seq: number;
      /** The key of the item whose row was rebound, as `rowItemKey` names it. */
      itemKey: string;
      previous: ResourceBinding;
```

<!-- edit: packages/agent-remote-relay/src/session-wire.test.ts -->
<!-- old -->
```ts
      type: 'timeline_resource_binding_replaced',
      agentId: 'agent-1',
      epoch: 'epoch-1',
      seq: 2,
      previous: { locator: 'output.png', resourceId: 'resource-2', status: 'pending' },
      replacement: { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
    };
```
<!-- new -->
```ts
      type: 'timeline_resource_binding_replaced',
      agentId: 'agent-1',
      epoch: 'epoch-1',
      seq: 2,
      itemKey: 'item-1',
      previous: { locator: 'output.png', resourceId: 'resource-2', status: 'pending' },
      replacement: { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
    };
```

In `packages/agent-remote-relay/src/agent-manager.ts`, import the key function and the row type:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
import { TimelineStore } from './timeline-store.js';
```
<!-- new -->
```ts
import { rowItemKey, TimelineStore, type CanonicalTimelineRow } from './timeline-store.js';
```

Declare what a tap is, next to the listener type:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
export type AgentManagerListener = (event: AgentManagerEvent) => void;
```
<!-- new -->
```ts
export type AgentManagerListener = (event: AgentManagerEvent) => void;

/**
 * A follower that is not a viewer: it receives every event, but its presence does not keep an idle session from being
 * released. The journal publisher is one.
 */
export interface AgentJournalTap {
  event(event: AgentManagerEvent): void;
  /** The manager closed; no more events follow. */
  closed(): void;
  /** A journal-capable provider broke the identity contract: an observation without `itemIdentity`, or with a key of the reserved `controller:` prefix. Told once per manager. */
  identityMissing?(): void;
}

export interface AgentJournalSubscription {
  /** The timeline as it stood when the tap began, oldest first. Events delivered to the tap after it are the changes since. */
  rows: CanonicalTimelineRow[];
  snapshot: AgentSnapshot;
  release(): void;
}
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
  private readonly listeners = new Set<AgentManagerListener>();
```
<!-- new -->
```ts
  private readonly listeners = new Set<AgentManagerListener>();
  private readonly taps = new Set<AgentJournalTap>();
```

Row identity reaches the store from both places that append a row:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
        occurredAt: observation.occurredAt,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        item: event.item,
      });
      if (result.status === 'duplicate') return;
```
<!-- new -->
```ts
        occurredAt: observation.occurredAt,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        item: event.item,
        ...(observation.itemIdentity === undefined ? {} : { identity: observation.itemIdentity }),
      });
      if (result.status === 'duplicate') return;
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          item: completed.item,
        });
```
<!-- new -->
```ts
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          item: completed.item,
          ...(observation.itemIdentity === undefined ? {} : { identity: observation.itemIdentity }),
        });
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
              epoch: result.row.epoch,
              seq: result.row.seq,
              previous,
```
<!-- new -->
```ts
              epoch: result.row.epoch,
              seq: result.row.seq,
              itemKey: rowItemKey(result.row),
              previous,
```

Reading an older page is shared by a browser's request and the journal:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
      || page.payload.entries.length >= request.limit || !this.session.readTimelineHistory) return page;
    if (!this.historyLoading) {
      const timeline = this.timeline;
      const cursor = this.olderHistoryCursor;
      const load = async () => {
        const history = await this.session.readTimelineHistory!(cursor);
        if (this.closed || this.timeline !== timeline) return;
        if (history.nextCursor === cursor) throw new Error('Provider history cursor did not advance.');
        if (history.observations.some(row => row.delivery !== 'history' || row.event.type !== 'timeline')) throw new Error('Provider history page contains live runtime state.');
        for (const observation of [...history.observations].reverse()) {
          if (this.closed || this.timeline !== timeline) return;
          await this.applyObservation(observation, true);
        }
        if (this.timeline === timeline) this.olderHistoryCursor = history.nextCursor;
      };
      const pending = load().finally(() => { if (this.historyLoading === pending) this.historyLoading = undefined; });
      this.historyLoading = pending;
    }
    await this.historyLoading;
    return this.fetchTimeline(request);
  }

  subscribe(listener: AgentManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
```
<!-- new -->
```ts
      || page.payload.entries.length >= request.limit || !this.session.readTimelineHistory) return page;
    await this.readOlderPage();
    return this.fetchTimeline(request);
  }

  /** Reads one older page of native history into the timeline; callers that arrive while a read is running share it. */
  private readOlderPage(): Promise<void> {
    if (!this.historyLoading) {
      const timeline = this.timeline;
      const cursor = this.olderHistoryCursor;
      if (!cursor || !this.session.readTimelineHistory) return Promise.resolve();
      const load = async () => {
        const history = await this.session.readTimelineHistory!(cursor);
        if (this.closed || this.timeline !== timeline) return;
        if (history.nextCursor === cursor) throw new Error('Provider history cursor did not advance.');
        if (history.observations.some(row => row.delivery !== 'history' || row.event.type !== 'timeline')) throw new Error('Provider history page contains live runtime state.');
        for (const observation of [...history.observations].reverse()) {
          if (this.closed || this.timeline !== timeline) return;
          await this.applyObservation(observation, true);
        }
        if (this.timeline === timeline) this.olderHistoryCursor = history.nextCursor;
      };
      const pending = load().finally(() => { if (this.historyLoading === pending) this.historyLoading = undefined; });
      this.historyLoading = pending;
    }
    return this.historyLoading as Promise<void>;
  }

  /** Whether native history may hold rows older than the timeline's oldest. */
  hasOlderHistory(): boolean {
    return this.olderHistoryCursor !== undefined && this.session.readTimelineHistory !== undefined;
  }

  /** Reads one older page of native history into the timeline, as a reader scrolling back would. */
  async loadOlderHistory(): Promise<{ added: number; more: boolean }> {
    if (!this.hasOlderHistory()) return { added: 0, more: false };
    const before = this.timeline.rowCount();
    await this.readOlderPage();
    return { added: this.timeline.rowCount() - before, more: this.hasOlderHistory() };
  }

  subscribe(listener: AgentManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Follows this manager without being a viewer. The timeline and the events after it join without a gap. A manager that
   * is closed already tells the tap so at once and delivers nothing, so a follower never waits for events that cannot come.
   */
  subscribeJournal(tap: AgentJournalTap): AgentJournalSubscription {
    if (this.closed) {
      try { tap.closed(); } catch { /* A tap cannot keep the manager open. */ }
      return { rows: [], snapshot: this.snapshot(), release: () => undefined };
    }
    this.taps.add(tap);
    return { rows: this.timelineRows(), snapshot: this.snapshot(), release: () => { this.taps.delete(tap); } };
  }

  /** The timeline's rows, oldest first, with the item identity each came with. */
  timelineRows(): CanonicalTimelineRow[] {
    return [...this.timeline.rows()];
  }

  /** The rows of one item in sequence order; none for an unknown key. */
  itemRows(key: string): CanonicalTimelineRow[] {
    return this.timeline.rowsOfItem(key);
  }

  /** The key of the item the attention cursor points at, when that row is still in the timeline. */
  attentionItemKey(): string | undefined {
    return this.attentionCursor.epoch === this.timeline.epoch ? this.timeline.itemKeyAt(this.attentionCursor.seq) : undefined;
  }
```

A manager made for a journal-capable provider checks the identity contract on every timeline observation and every `interaction_resolved` observation, and tells its taps once when it is broken. The adapter's declaration reaches it as `journalContract`:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
export interface AgentManagerAttachOptions {
```
<!-- new -->
```ts
export interface AgentManagerAttachOptions {
  /** The provider declares `journal`: its observations carry item identities, and a missing one is told to the journal taps. */
  journalContract?: true;
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
        provider: options.adapter.descriptor,
        session,
```
<!-- new -->
```ts
        provider: options.adapter.descriptor,
        session,
        ...(supportsJournal(options.adapter) ? { journalContract: true as const } : {}),
```

The check itself is one private method, called with every observation at the top of the manager's observation handler, before the observation is turned into a row (the row keeps the `controller:` key of its source, which only matters to a provider that does not declare journal support):

```ts
  private identityBroken = false;

  /** A journal-capable provider owes an identity to every timeline observation and every `interaction_resolved` one. */
  private checkIdentity(observation: ProviderObservation): void {
    if (!this.journalContract || this.identityBroken) return;
    const event = observation.event;
    if (event.type !== 'timeline' && event.type !== 'interaction_resolved') return;
    const key = observation.itemIdentity?.key;
    if (key !== undefined && key.length > 0 && key.length <= 4096 && !key.startsWith('controller:')) return;
    this.identityBroken = true;
    for (const tap of [...this.taps]) {
      try { tap.identityMissing?.(); } catch { /* A tap cannot keep the manager open. */ }
    }
  }
```

`agent-manager.ts` imports `supportsJournal` from `@orchardworks/agent-provider-sdk`. The manager keeps the option in `private readonly journalContract: boolean`, set from `options.journalContract === true` where the other attach options are stored. A tap that subscribes after the breach is told at once:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
    this.taps.add(tap);
    return { rows: this.timelineRows(), snapshot: this.snapshot(), release: () => { this.taps.delete(tap); } };
```
<!-- new -->
```ts
    this.taps.add(tap);
    if (this.identityBroken) queueMicrotask(() => { try { tap.identityMissing?.(); } catch { /* A tap cannot keep the manager open. */ } });
    return { rows: this.timelineRows(), snapshot: this.snapshot(), release: () => { this.taps.delete(tap); } };
```

Taps hear every event and are told when the manager closes:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
    this.resolveReadiness();
    this.listeners.clear();
    try {
```
<!-- new -->
```ts
    this.resolveReadiness();
    this.listeners.clear();
    for (const tap of [...this.taps]) {
      this.taps.delete(tap);
      try { tap.closed(); } catch { /* A tap cannot keep the manager open. */ }
    }
    try {
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
  private emit(event: AgentManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(event));
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
```
<!-- new -->
```ts
  private emit(event: AgentManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(event));
      } catch {
        this.listeners.delete(listener);
      }
    }
    for (const tap of [...this.taps]) {
      try {
        tap.event(structuredClone(event));
      } catch {
        this.taps.delete(tap);
      }
    }
  }
```

- [ ] **Step 5: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/agent-manager-journal.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-relay run test` then `pnpm --filter @orchardworks/agent-remote-relay run typecheck` then `pnpm --filter @orchardworks/agent-remote-relay run build`
Expected: PASS for all. Rebuild the package so `agent-remote-journal`, `agent-remote-hosted` and `agent-host` see `rowItemKey` and `subscribeJournal`.

- [ ] **Step 6: Commit.**

```bash
git add packages/agent-remote-relay/src
git commit -m "feat(relay): carry item identity on timeline rows and let the journal publisher tap an agent manager" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 6: Resource ids that survive a restart

A journal row carries the resource bindings its text produced, and a binding names a resource by `resourceId`. Today the ids are random per agent manager (`resource-ingestor.ts`), so after a Controller restart the same image has a new id and the journal's rows name resources nobody can read. This task makes the id of a settled resource stable for the same agent, locator and bytes, and not guessable.

The id is a keyed hash (HMAC-SHA-256) of the agent id, the normalized locator and the SHA-256 of the bytes, under a secret the Controller keeps with its state. It is assigned when a resource settles as available: the pending binding a row first carries keeps its random id and is replaced by the settled one through the existing `timeline_resource_binding_replaced` event, which the publisher turns into a `rebind`. Because the hash includes the bytes, a file overwritten with new content still gets a new id, as today. Failed and unavailable resources keep their random ids.

Access stays as it is: every read checks that the record belongs to the asking agent, and the agent id is part of the hash, so two agents never share an id even for the same file.

**Files:**
- Modify: `packages/agent-remote-relay/src/resources/resource-ingestor.ts`
- Modify: `packages/agent-remote-relay/src/agent-manager.ts`, `relay.ts`
- Create: `packages/agent-remote-relay/src/resources/stable-resource-ids.test.ts`
- Create: `packages/agent-host/src/resource-id-key.ts`, `resource-id-key.test.ts`
- Modify: `packages/agent-host/src/host.ts`

- [ ] **Step 1: Write the failing tests of the ingestor.** Create `packages/agent-remote-relay/src/resources/stable-resource-ids.test.ts`:

<!-- write: packages/agent-remote-relay/src/resources/stable-resource-ids.test.ts -->
```ts
import { describe, expect, it } from 'vitest';

import { ResourceIngestor } from './resource-ingestor.js';
import { InMemoryResourceStore } from './resource-store.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
const otherPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const reader = (bytes: Uint8Array) => async () => ({ status: 'available' as const, bytes, mediaType: 'image/png' });

async function settle(ingestor: ResourceIngestor, agentId: string, locator: string, bytes: Uint8Array) {
  const acquisition = ingestor.acquire({ agentId, locator, reader: reader(bytes) });
  expect(acquisition?.binding.status).toBe('pending');
  return { provisional: acquisition!.binding.resourceId, settled: await acquisition!.settled };
}

describe('resource ids with a key', () => {
  it('are the same for the same agent, locator and bytes in another ingestor, as after a restart', async () => {
    const first = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const second = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const a = await settle(first, 'agent-1', 'shot.png', png);
    const b = await settle(second, 'agent-1', 'shot.png', png);
    expect(a.settled).toMatchObject({ locator: 'shot.png', status: 'available' });
    expect(a.settled.resourceId).toBe(b.settled.resourceId);
    expect(a.settled.resourceId).toMatch(/^rid_[A-Za-z0-9_-]{32}$/);
    expect(a.provisional).not.toBe(a.settled.resourceId);
  });

  it('are reused when the same resource settles again in one ingestor', async () => {
    const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const a = await settle(ingestor, 'agent-1', 'shot.png', png);
    const b = await settle(ingestor, 'agent-1', 'shot.png', png);
    expect(b.settled.resourceId).toBe(a.settled.resourceId);
    expect(ingestor.readState('agent-1', a.settled.resourceId)).toMatchObject({ status: 'available' });
  });

  it('differ for other bytes, another locator, another agent and another key', async () => {
    const store = new InMemoryResourceStore();
    const ingestor = new ResourceIngestor({ store, resourceIdKey: 'secret-one' });
    const base = (await settle(ingestor, 'agent-1', 'shot.png', png)).settled.resourceId;
    expect((await settle(ingestor, 'agent-1', 'shot.png', otherPng)).settled.resourceId).not.toBe(base);
    expect((await settle(ingestor, 'agent-1', 'other.png', png)).settled.resourceId).not.toBe(base);
    expect((await settle(ingestor, 'agent-2', 'shot.png', png)).settled.resourceId).not.toBe(base);
    const rekeyed = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-two' });
    expect((await settle(rekeyed, 'agent-1', 'shot.png', png)).settled.resourceId).not.toBe(base);
  });

  it('still belong to one agent: another agent cannot read the resource', async () => {
    const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const { settled } = await settle(ingestor, 'agent-1', 'shot.png', png);
    expect(ingestor.readState('agent-1', settled.resourceId)).toMatchObject({ status: 'available' });
    expect(ingestor.readState('agent-2', settled.resourceId)).toMatchObject({ status: 'unavailable' });
    expect(ingestor.readResponse('r', 'agent-2', settled.resourceId).payload.state).toMatchObject({ status: 'unavailable' });
  });

  it('keep random ids for a resource that did not settle as available', async () => {
    const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const acquisition = ingestor.acquire({ agentId: 'agent-1', locator: 'gone.png', reader: async () => ({ status: 'unavailable', reason: 'No such file.' }) })!;
    const settled = await acquisition.settled;
    expect(settled).toMatchObject({ status: 'unavailable', resourceId: acquisition.binding.resourceId });
    expect(settled.resourceId).not.toMatch(/^rid_/);
  });
});

describe('resource ids without a key', () => {
  it('are random, as before', async () => {
    const first = new ResourceIngestor({ store: new InMemoryResourceStore() });
    const second = new ResourceIngestor({ store: new InMemoryResourceStore() });
    const a = await settle(first, 'agent-1', 'shot.png', png);
    const b = await settle(second, 'agent-1', 'shot.png', png);
    expect(a.settled.resourceId).toBe(a.provisional);
    expect(a.settled.resourceId).not.toBe(b.settled.resourceId);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/resources/stable-resource-ids.test.ts --testTimeout=10000`
Expected: FAIL (`resourceIdKey` is not an option, so ids stay random).

- [ ] **Step 3: Implement the ingestor.** In `packages/agent-remote-relay/src/resources/resource-ingestor.ts`:

<!-- edit: packages/agent-remote-relay/src/resources/resource-ingestor.ts -->
<!-- old -->
```ts
import { createHash, randomUUID } from 'node:crypto';
```
<!-- new -->
```ts
import { createHash, createHmac, randomUUID } from 'node:crypto';
```

<!-- edit: packages/agent-remote-relay/src/resources/resource-ingestor.ts -->
<!-- old -->
```ts
  retryAfterMs?: number;
  createResourceId?: () => string;
}
```
<!-- new -->
```ts
  retryAfterMs?: number;
  createResourceId?: () => string;
  /**
   * A secret the owner keeps with the Controller's state. With it, a resource that settles as available gets an id that is
   * the same for the same agent, locator and bytes in every process, and that nobody can derive. Without it ids are random.
   */
  resourceIdKey?: string;
}

/** The id of an available resource: a keyed hash of its agent, normalized locator and content. */
export function stableResourceId(key: string, agentId: string, normalizedLocator: string, sha256: string): string {
  return `rid_${createHmac('sha256', key).update(JSON.stringify([agentId, normalizedLocator, sha256])).digest('base64url').slice(0, 32)}`;
}
```

<!-- edit: packages/agent-remote-relay/src/resources/resource-ingestor.ts -->
<!-- old -->
```ts
        const imageDimensions = readImageDimensions(result.bytes, detectedMediaType);
        return this.finish(agentId, resourceId, {
          ...(imageDimensions ? { imageDimensions } : {}),
          status: 'available', mediaType: detectedMediaType, byteLength: result.bytes.byteLength, sha256,
        });
```
<!-- new -->
```ts
        const imageDimensions = readImageDimensions(result.bytes, detectedMediaType);
        const available: StoredResourceState = {
          ...(imageDimensions ? { imageDimensions } : {}),
          status: 'available', mediaType: detectedMediaType, byteLength: result.bytes.byteLength, sha256,
        };
        const key = this.options.resourceIdKey;
        if (key === undefined) return this.finish(agentId, resourceId, available);
        // The record the acquisition began with has a random id; the settled resource takes the stable one.
        const stableId = stableResourceId(key, agentId, normalizedLocator, sha256);
        const provisional = this.options.store.getRecord(agentId, resourceId);
        this.options.store.createRecord({ resourceId: stableId, agentId, locator: provisional?.locator ?? normalizedLocator, normalizedLocator, state: available });
        this.options.store.deleteRecord(agentId, resourceId);
        return { resourceId: stableId, state: available };
```

The manager and the relay pass the key through:

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
  settingIntent?: OperationLifecycle['settingIntent'];
}

export interface AgentManagerCreateOptions {
```
<!-- new -->
```ts
  settingIntent?: OperationLifecycle['settingIntent'];
  /** See `ResourceIngestorOptions.resourceIdKey`. */
  resourceIdKey?: string;
}

export interface AgentManagerCreateOptions {
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
  settingIntent?: OperationLifecycle['settingIntent'];
}

export interface AgentManagerResumeOptions {
```
<!-- new -->
```ts
  settingIntent?: OperationLifecycle['settingIntent'];
  resourceIdKey?: string;
}

export interface AgentManagerResumeOptions {
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
  settingIntent?: OperationLifecycle['settingIntent'];
}

export type AgentManagerListener
```
<!-- new -->
```ts
  settingIntent?: OperationLifecycle['settingIntent'];
  resourceIdKey?: string;
}

export type AgentManagerListener
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
      new ResourceIngestor({ store: options.resourceStore ?? new InMemoryResourceStore() }),
```
<!-- new -->
```ts
      new ResourceIngestor({ store: options.resourceStore ?? new InMemoryResourceStore(), ...(options.resourceIdKey === undefined ? {} : { resourceIdKey: options.resourceIdKey }) }),
```

<!-- edit: packages/agent-remote-relay/src/agent-manager.ts -->
<!-- old -->
```ts
        ...(options.settingIntent === undefined ? {} : { settingIntent: options.settingIntent }),
      });
      await manager.ready;
```
<!-- new -->
```ts
        ...(options.settingIntent === undefined ? {} : { settingIntent: options.settingIntent }),
        ...(options.resourceIdKey === undefined ? {} : { resourceIdKey: options.resourceIdKey }),
      });
      await manager.ready;
```

<!-- edit: packages/agent-remote-relay/src/relay.ts -->
<!-- old -->
```ts
  inputImageStore?: InputImageStore;
}

export class AgentAlreadyExistsError
```
<!-- new -->
```ts
  inputImageStore?: InputImageStore;
  /** See `ResourceIngestorOptions.resourceIdKey`; the Controller passes a secret it keeps with its state. */
  resourceIdKey?: string;
}

export class AgentAlreadyExistsError
```

<!-- edit: packages/agent-remote-relay/src/relay.ts -->
<!-- old -->
```ts
    private readonly inputResourceStore?: InputResourceStore,
  ) {
```
<!-- new -->
```ts
    private readonly inputResourceStore?: InputResourceStore,
    private readonly resourceIdKey?: string,
  ) {
```

<!-- edit: packages/agent-remote-relay/src/relay.ts -->
<!-- old -->
```ts
        config: request.payload.config,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
```
<!-- new -->
```ts
        config: request.payload.config,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
        ...(this.resourceIdKey === undefined ? {} : { resourceIdKey: this.resourceIdKey }),
```

<!-- edit: packages/agent-remote-relay/src/relay.ts -->
<!-- old -->
```ts
        handle: request.payload.persistence,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
```
<!-- new -->
```ts
        handle: request.payload.persistence,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
        ...(this.resourceIdKey === undefined ? {} : { resourceIdKey: this.resourceIdKey }),
```

<!-- edit: packages/agent-remote-relay/src/relay.ts -->
<!-- old -->
```ts
    options.operationLifecycle,
    options.inputResourceStore,
  );
```
<!-- new -->
```ts
    options.operationLifecycle,
    options.inputResourceStore,
    options.resourceIdKey,
  );
```

- [ ] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/resources/stable-resource-ids.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-relay run test` then `pnpm --filter @orchardworks/agent-remote-relay run typecheck` then `pnpm --filter @orchardworks/agent-remote-relay run build`
Expected: PASS for all. Without a key nothing changes, so the existing resource and manager tests are unaffected.

- [ ] **Step 5: Write the failing test of the key file.** Create `packages/agent-host/src/resource-id-key.test.ts`:

<!-- write: packages/agent-host/src/resource-id-key.test.ts -->
```ts
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { loadResourceIdKey } from './resource-id-key.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const location = async () => { const root = await mkdtemp(join(tmpdir(), 'resource-id-key-')); roots.push(root); return join(root, 'resource-id.key'); };

it('creates a private random key the first time and returns the same key afterwards', async () => {
  const file = await location();
  const first = loadResourceIdKey(file);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(loadResourceIdKey(file)).toBe(first);
  expect(await readFile(file, 'utf8')).toBe(`${first}\n`);
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('makes a new key, and keeps nothing of the old content, when the file holds something that is not a key', async () => {
  const file = await location();
  await writeFile(file, 'not a key');
  const key = loadResourceIdKey(file);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(await readFile(file, 'utf8')).toBe(`${key}\n`);
});

it('gives different Controllers different keys', async () => {
  expect(loadResourceIdKey(await location())).not.toBe(loadResourceIdKey(await location()));
});
```

- [ ] **Step 6: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/resource-id-key.test.ts --testTimeout=10000`
Expected: FAIL (`./resource-id-key.js` does not exist).

- [ ] **Step 7: Implement the key file and the wiring.** Create `packages/agent-host/src/resource-id-key.ts`:

<!-- write: packages/agent-host/src/resource-id-key.ts -->
```ts
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The secret behind stable resource ids, kept in the Controller's state directory so ids survive a restart. A missing or
 * damaged file is replaced by a new key; ids made under the old key are then replaced as the resources settle again.
 */
export function loadResourceIdKey(file: string): string {
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(saved)) return saved;
  } catch { /* No key yet. */ }
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}
```

In `packages/agent-host/src/host.ts`, import it and let the runtime take the file:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
import { SessionOutbox } from './session-outbox.js';
```
<!-- new -->
```ts
import { SessionOutbox } from './session-outbox.js';
import { loadResourceIdKey } from './resource-id-key.js';
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
  sessionRepliesFile?: string;
```
<!-- new -->
```ts
  sessionRepliesFile?: string;
  /** Where the secret of stable resource ids is kept; without it resource ids are random per process. */
  resourceIdKeyFile?: string;
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
    ...(options.sessionRepliesFile || !stateDirectory ? {} : { sessionRepliesFile: join(stateDirectory, 'session-replies.json') }),
```
<!-- new -->
```ts
    ...(options.sessionRepliesFile || !stateDirectory ? {} : { sessionRepliesFile: join(stateDirectory, 'session-replies.json') }),
    ...(options.resourceIdKeyFile || !stateDirectory ? {} : { resourceIdKeyFile: join(stateDirectory, 'resource-id.key') }),
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
  const relay = createAgentRemoteRelay({ providers: relayAdapters, operationCache, operationLifecycle: {
```
<!-- new -->
```ts
  const relay = createAgentRemoteRelay({ providers: relayAdapters, ...(options.resourceIdKeyFile ? { resourceIdKey: loadResourceIdKey(options.resourceIdKeyFile) } : {}), operationCache, operationLifecycle: {
```

- [ ] **Step 8: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/resource-id-key.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-controller run typecheck`
Expected: PASS. The restart test with an image whose id survives is in Task 9, where a journal is under it.

- [ ] **Step 9: Commit.**

```bash
git add packages/agent-remote-relay/src packages/agent-host/src
git commit -m "feat(relay): give a settled resource an id that is stable for its agent, locator and bytes, under a secret the Controller keeps" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 7: The Host uplink client asks for the journal grant and hands journal messages to the publisher

`agent-remote-relay` cannot depend on the journal package (the journal depends on it), so the client only carries the messages (and keeps its test that a Controller granted 1, or not at all, is handed no writer and publishes nothing): it asks the Relay for journals, tells its owner when the connection may write them, and hands every journal message of the Relay to its owner. The publisher in `agent-host` (Tasks 8 and 9) is the owner.

**Files:**
- Modify: `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts`
- Create: `packages/agent-remote-relay/src/transport/remote-host-uplink-journal.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `packages/agent-remote-relay/src/transport/remote-host-uplink-journal.test.ts`. It runs the real client against a real WebSocket server:

<!-- write: packages/agent-remote-relay/src/transport/remote-host-uplink-journal.test.ts -->
```ts
import { setTimeout as delay } from 'node:timers/promises';
import type { JournalRelayMessage } from '@orchardworks/agent-remote-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { createAgentRemoteRelay } from '../relay.js';
import { createRemoteHostUplinkClient } from './remote-host-uplink-client.js';

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closeables.splice(0).reverse()) await close(); });

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) { if (check()) return; await delay(5); }
  throw new Error('Timed out.');
}

async function connect(options: { acknowledge: boolean | 1; journal: boolean }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  closeables.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  let asked: string | null = null;
  let relaySocket: WebSocket | undefined;
  const received: Array<Record<string, unknown>> = [];
  server.on('connection', (socket, request) => {
    asked = new URL(request.url!, 'http://relay').searchParams.get('journal');
    relaySocket = socket;
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'register') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 }, ...(options.acknowledge ? { journal: options.acknowledge === 1 ? 1 : 2 } : {}) }));
      else if (message.type.startsWith('journal_')) received.push(message);
    });
  });
  const relay = createAgentRemoteRelay({ providers: [] });
  closeables.push(() => relay.close());
  const available: Array<{ send(json: string): void } | undefined> = [];
  const messages: JournalRelayMessage[] = [];
  const client = createRemoteHostUplinkClient({ relay, installationId: 'machine', name: 'Machine', remoteKey: 'key', providers: [], reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10,
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, resolveSession: () => undefined, control: async () => ({ status: 404, body: '{}' }),
    ...(options.journal ? { journal: { available: writer => { available.push(writer); }, receive: message => { messages.push(message); } } } : {}) });
  closeables.push(() => client.close());
  await client.ready;
  return { client, available, messages, received, asked: () => asked, relaySocket: () => relaySocket! };
}

describe('the journal grant on the Host uplink', () => {
  it('is not asked for without a journal owner, and nothing is handed over', async () => {
    const { asked, available } = await connect({ acknowledge: true, journal: false });
    expect(asked()).toBeNull();
    expect(available).toEqual([]);
  });

  it('is asked for, and the connection may write journal messages once the Relay acknowledges it', async () => {
    const { asked, available, received } = await connect({ acknowledge: true, journal: true });
    expect(asked()).toBe('2');
    expect(available).toHaveLength(1);
    available[0]!.send(JSON.stringify({ uplinkVersion: 2, type: 'journal_open', requestId: 'open-1', sessionKey: 'codex:thread-1', publisherId: 'controller-1' }));
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'journal_open', requestId: 'open-1' });
  });

  it('hands every journal message of the Relay to its owner, decoded', async () => {
    const { messages, relaySocket } = await connect({ acknowledge: true, journal: true });
    relaySocket().send(JSON.stringify({ uplinkVersion: 2, type: 'journal_ack', sessionKey: 'codex:thread-1', generation: 1, watermark: 3, cursor: { epoch: 'epoch-1', seq: 2 } }));
    relaySocket().send(JSON.stringify({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'codex:thread-1', limit: 50 }));
    await until(() => messages.length === 2);
    expect(messages.map(message => message.type)).toEqual(['journal_ack', 'journal_older_request']);
    expect(messages[0]).toMatchObject({ watermark: 3, cursor: { seq: 2 } });
  });

  it('is told that no connection may write when the Relay does not acknowledge journals', async () => {
    const { available } = await connect({ acknowledge: false, journal: true });
    expect(available).toEqual([undefined]);
  });

  it('is told that no connection may write when the Relay acknowledges only level 1, which lacks what this Controller publishes', async () => {
    const { available, messages, relaySocket } = await connect({ acknowledge: 1, journal: true });
    expect(available).toEqual([undefined]);
    relaySocket().send(JSON.stringify({ uplinkVersion: 2, type: 'journal_ack', sessionKey: 'codex:thread-1', generation: 1, watermark: 1, cursor: { epoch: 'epoch-1', seq: 1 } }));
    await delay(50);
    expect(messages).toEqual([]);
  });

  it('is told that the connection ended, and offered the next one', async () => {
    const { available, relaySocket } = await connect({ acknowledge: true, journal: true });
    expect(available).toHaveLength(1);
    relaySocket().terminate();
    await until(() => available.length === 3);
    expect(available[1]).toBeUndefined();
    expect(available[2]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/transport/remote-host-uplink-journal.test.ts --testTimeout=10000`
Expected: FAIL (`journal` is not an option, so the client never asks for it).

- [ ] **Step 3: Implement.** In `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts`, import the message type:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
  type ControllerIdentity, type RemoteHostHeartbeat, type HostEnvironment, type PairingPurpose,
```
<!-- new -->
```ts
  type ControllerIdentity, type JournalRelayMessage, type RemoteHostHeartbeat, type HostEnvironment, type PairingPurpose,
```

Add the option:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
  readonly outbox?: { onAvailable(available: boolean): void; onReady(): void };
}
```
<!-- new -->
```ts
  readonly outbox?: { onAvailable(available: boolean): void; onReady(): void };
  /**
   * Publishes session journals. The client asks the Relay for the grant; `available` is called with a writer once the
   * Relay acknowledged it, with undefined when it did not and again with undefined when the connection ends, and
   * `receive` with every journal message the Relay sends while the grant holds. The owner validates what it writes.
   */
  readonly journal?: {
    available(writer: { send(json: string): void } | undefined): void;
    receive(message: JournalRelayMessage): void;
  };
}
```

Ask for it:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
    if (options.outbox) endpoint.searchParams.set('outbox', '1');
```
<!-- new -->
```ts
    if (options.outbox) endpoint.searchParams.set('outbox', '1');
    if (options.journal) endpoint.searchParams.set('journal', '2');
```

Keep the writer of this connection:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
    let operationScope: string | undefined;
    let successionContext: TrustedSuccessionContext | undefined;
```
<!-- new -->
```ts
    let operationScope: string | undefined;
    let successionContext: TrustedSuccessionContext | undefined;
    let journalWriter: { send(json: string): void } | undefined;
```

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
      rejectTeam(); rejectOutbox();
      retired = true;
```
<!-- new -->
```ts
      rejectTeam(); rejectOutbox();
      if (journalWriter) { journalWriter = undefined; options.journal?.available(undefined); }
      retired = true;
```

A repeated `registered` must agree with the first:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
          || (!!options.outbox && decoded.value.outbox === 1) !== !!sendOutbox ||
```
<!-- new -->
```ts
          || (!!options.outbox && decoded.value.outbox === 1) !== !!sendOutbox || (!!options.journal && decoded.value.journal === 2) !== !!journalWriter ||
```

Tell the owner what the Relay granted:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
          options.outbox.onAvailable(!!sendOutbox);
        }
```
<!-- new -->
```ts
          options.outbox.onAvailable(!!sendOutbox);
        }
        if (options.journal) {
          if (decoded.value.journal === 2) journalWriter = { send: json => { writer.send(json); } };
          options.journal.available(journalWriter);
        }
```

Hand the messages over:

<!-- edit: packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts -->
<!-- old -->
```ts
      if (decoded.value.type === 'outbox_response') {
```
<!-- new -->
```ts
      if (decoded.value.type.startsWith('journal_')) {
        if (!journalWriter) { retire({ reason: 'protocol_error' }); return; }
        options.journal!.receive(decoded.value as JournalRelayMessage);
        return;
      }
      if (decoded.value.type === 'outbox_response') {
```

- [ ] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-relay exec vitest run src/transport/remote-host-uplink-journal.test.ts --testTimeout=10000` then `pnpm --filter @orchardworks/agent-remote-relay run test` then `pnpm --filter @orchardworks/agent-remote-relay run typecheck` then `pnpm --filter @orchardworks/agent-remote-relay run build`
Expected: PASS for all.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-remote-relay/src
git commit -m "feat(relay): let the Host uplink client ask for the journal grant and hand journal messages to its owner" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 8: Items from the Controller's timeline, and the plan that brings a journal up to date

The first two modules of the publisher are pure: they turn the Controller's rows into journal items and entries (`journal-items.ts`), and compare a reread of the timeline with the item index the Relay holds to say what to publish (`journal-reconcile.ts`). Nothing here talks to the Relay.

**Files:**
- Modify: `packages/agent-host/package.json`
- Create: `packages/agent-host/src/journal-items.ts`
- Create: `packages/agent-host/src/journal-items.test.ts`
- Create: `packages/agent-host/src/journal-reconcile.ts`
- Create: `packages/agent-host/src/journal-reconcile.test.ts`

- [ ] **Step 1: Depend on the journal package.** The Controller needs `planReconcile`, `itemDigest` and the journal's types. The package is pure TypeScript with no native module and no `node:sqlite`, and the Controller bundle includes it like its other workspace packages. In `packages/agent-host/package.json`:

<!-- edit: packages/agent-host/package.json -->
<!-- old -->
```json
    "@orchardworks/agent-remote-hosted": "workspace:*",
```
<!-- new -->
```json
    "@orchardworks/agent-remote-hosted": "workspace:*",
    "@orchardworks/agent-remote-journal": "workspace:*",
```

Run: `pnpm install --offline` (it links the workspace package and updates `pnpm-lock.yaml`), then `pnpm --filter @orchardworks/agent-remote-journal run build`.
Expected: the install finishes without a network request, and `packages/agent-host/node_modules/@orchardworks/agent-remote-journal` exists.

- [ ] **Step 2: Write the failing test of items and sizes.** Create `packages/agent-host/src/journal-items.test.ts`:

<!-- write: packages/agent-host/src/journal-items.test.ts -->
```ts
import { itemDigest } from '@orchardworks/agent-remote-journal';
import { JOURNAL_PUBLISH_MAX_ENTRIES } from '@orchardworks/agent-remote-protocol';
import type { CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';
import { describe, expect, it } from 'vitest';

import { blocksOf, chunkOps, entryBytes, groupItems, mergedRow, MESSAGE_BUDGET_BYTES, newestItems, sizedItems, type PublishOp, type SizedItem } from './journal-items.js';

let seq = 0;
const row = (key: string | undefined, text: string, extra: Partial<CanonicalTimelineRow> = {}): CanonicalTimelineRow => ({
  epoch: 'e', seq: ++seq, providerId: 'fake', sourceKey: `source:${seq}`, occurredAt: 1_725_000_000_000 + seq, timestamp: new Date(1_725_000_000_000 + seq).toISOString(),
  turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key ?? 'none' }, resources: [], ...(key === undefined ? {} : { identity: { key } }), ...extra,
});
const digest = (item: { rows: CanonicalTimelineRow[] }) => itemDigest(mergedRow({ key: 'k', rows: item.rows, complete: true, liveOnly: false }).item);

describe('items of the Controller timeline', () => {
  it('groups rows by item key in the order the items first appear, and tells complete from open', () => {
    const items = groupItems([
      row('a', 'Hel'), row('b', 'Other'), row('a', 'lo', { identity: { key: 'a', completes: true } }),
      row('c', 'Never finished'),
    ]);
    expect(items.map(({ key, complete, liveOnly, rows }) => [key, complete, liveOnly, rows.length])).toEqual([['a', true, false, 2], ['b', false, false, 1], ['c', false, false, 1]]);
  });

  it('reopens a complete item when a later row adds content, as the journal does', () => {
    const [reopened, closed] = groupItems([
      row('a', 'Done', { identity: { key: 'a', completes: true } }), row('a', ' and more', { identity: { key: 'a' } }),
      row('b', 'Done', { identity: { key: 'b' } }), row('b', ' now', { identity: { key: 'b', completes: true } }),
    ]);
    expect([reopened?.complete, closed?.complete]).toEqual([false, true]);
  });

  it('gives a row without identity a key of its own, completes it at once and keeps it live-only', () => {
    const [item] = groupItems([row(undefined, 'Made by the Controller')]);
    expect(item).toMatchObject({ key: expect.stringMatching(/^controller:source:\d+$/), complete: true, liveOnly: true });
  });

  it('marks an item live-only when any of its rows says so', () => {
    const [item] = groupItems([row('a', 'x'), row('a', 'y', { identity: { key: 'a', liveOnly: true } })]);
    expect(item?.liveOnly).toBe(true);
  });

  it('merges the rows of an item the way the journal merges them, so live deltas and a reread have one digest', async () => {
    const live = groupItems([row('a', 'Hel'), row('a', 'lo, '), row('a', 'world', { identity: { key: 'a', completes: true } })])[0]!;
    const reread = groupItems([row('a', 'Hello, world', { identity: { key: 'a', completes: true } })])[0]!;
    expect(mergedRow(live).item).toEqual({ type: 'assistant_message', text: 'Hello, world', messageId: 'a' });
    expect(await digest(live)).toBe(await digest(reread));
  });

  it('takes the time, source and turn of the first row, and the resources of all of them', () => {
    const merged = mergedRow(groupItems([
      row('a', 'x', { resources: [{ locator: 'one.md', resourceId: 'r1', status: 'pending' }] }),
      row('a', 'y', { resources: [{ locator: 'two.md', resourceId: 'r2', status: 'pending' }] }),
    ])[0]!);
    expect(merged).toMatchObject({ itemKey: 'a', providerId: 'fake', turnId: 'turn-1', resources: [{ resourceId: 'r1' }, { resourceId: 'r2' }] });
    expect(merged.sourceKey).toMatch(/^source:\d+$/);
  });
});

describe('what the wire accepts', () => {
  it('measures an entry, and refuses one the schema or the limits do not allow', () => {
    const fine: PublishOp = { op: 'append', row: mergedRow(groupItems([row('a', 'Hello')])[0]!) };
    expect(entryBytes(fine)).toBeGreaterThan(100);
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), turnId: 't'.repeat(513) } })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), sourceKey: 's'.repeat(4097) } })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), occurredAt: -1 } })).toBeUndefined();
    expect(entryBytes({ op: 'append', row: { ...mergedRow(groupItems([row('a', 'x')])[0]!), resources: Array.from({ length: 257 }, (_, at) => ({ locator: `f${at}`, resourceId: `r${at}`, status: 'pending' as const })) } })).toBeUndefined();
    expect(entryBytes({ op: 'seal', itemKey: 'k'.repeat(4097) })).toBeUndefined();
  });

  it('sizes items for a message and names the ones it refuses', async () => {
    const items = groupItems([row('a', 'Hello', { identity: { key: 'a', completes: true } }), row('b'.repeat(4097), 'Too long a key', { identity: { key: 'b'.repeat(4097), completes: true } })]);
    const { accepted, refused } = await sizedItems(items, digest);
    expect(accepted.map(({ item }) => item.row.itemKey)).toEqual(['a']);
    expect(refused).toEqual(['b'.repeat(4097)]);
    expect(accepted[0]!.item.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives an item that is still open no digest', async () => {
    const { accepted } = await sizedItems(groupItems([row('a', 'Streaming', { identity: { key: 'a' } })]), digest);
    expect(accepted[0]!.item).not.toHaveProperty('digest');
  });

  it('cuts items into blocks that each fit one message and keep their order', () => {
    const big = (key: string, bytes: number): SizedItem => ({ item: { row: { itemKey: key, providerId: 'fake', sourceKey: key, occurredAt: 1, item: { type: 'assistant_message', text: '' } }, digest: 'd' }, bytes });
    const blocks = blocksOf([big('a', 3_000_000), big('b', 1_000_000), big('c', 3_000_000), big('d', 10_000_000), big('e', 10)]);
    expect(blocks.map(block => block.map(({ row: { itemKey } }) => itemKey))).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
  });

  it('takes the newest items that fit one message, at least one', async () => {
    const items = groupItems(Array.from({ length: 6 }, (_, at) => row(`k${at}`, 'x'.repeat(1_200_000), { identity: { key: `k${at}`, completes: true } })));
    const { block } = await newestItems(items, digest);
    expect(block.map(({ row: { itemKey } }) => itemKey)).toEqual(['k3', 'k4', 'k5']);
    expect((await newestItems(items.slice(0, 1), digest)).block).toHaveLength(1);
  });

  it('chunks operations by entry count and bytes, keeping their order', () => {
    const op = (at: number): PublishOp => ({ op: 'seal', itemKey: `k${at}` });
    const many = Array.from({ length: JOURNAL_PUBLISH_MAX_ENTRIES + 5 }, (_, at) => ({ op: op(at), bytes: 100 }));
    const chunks = chunkOps(many);
    expect(chunks.map(chunk => chunk.ops.length)).toEqual([JOURNAL_PUBLISH_MAX_ENTRIES, 5]);
    const heavy = chunkOps([{ op: op(1), bytes: MESSAGE_BUDGET_BYTES }, { op: op(2), bytes: 1 }, { op: op(3), bytes: MESSAGE_BUDGET_BYTES + 10 }]);
    expect(heavy.map(chunk => chunk.ops.map(entry => 'itemKey' in entry ? entry.itemKey : '?'))).toEqual([['k1'], ['k2'], ['k3']]);
    expect(heavy[2]!.bytes).toBe(MESSAGE_BUDGET_BYTES + 10);
    expect(chunkOps([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-items.test.ts --testTimeout=10000`
Expected: FAIL (`./journal-items.js` does not exist).

- [ ] **Step 4: Implement items and sizes.** Create `packages/agent-host/src/journal-items.ts`:

<!-- write: packages/agent-host/src/journal-items.ts -->
```ts
import type { JournalItemInput, JournalRowInput } from '@orchardworks/agent-remote-journal';
import {
  encodeRemoteHostUplinkMessage, JOURNAL_ITEMS_PER_ENTRY_MAX, JOURNAL_PUBLISH_MAX_ENTRIES, REMOTE_HOST_UPLINK_VERSION, type JournalPublishEntry,
} from '@orchardworks/agent-remote-protocol';
import { entryFromRow, mergeRowIntoEntry, rowItemKey, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

/** What one publication message may carry in bytes: half of the 8 MiB the Relay accepts, so every estimate has room. */
export const MESSAGE_BUDGET_BYTES = 4 * 1024 * 1024;

/** One item of the Controller's timeline: its rows in order, and what the provider said about it. */
export interface TimelineItem {
  key: string;
  rows: CanonicalTimelineRow[];
  /** The provider finished it, or its rows came from native history, which is finalized. */
  complete: boolean;
  /** Native history cannot rebuild it, so the journal keeps the only copy. */
  liveOnly: boolean;
}

/** An operation of a publication, before it is numbered. */
export type PublishOp = JournalPublishEntry extends infer Entry ? Entry extends { sequence: number } ? Omit<Entry, 'sequence'> : never : never;

export interface SizedOp { op: PublishOp; bytes: number }
export interface SizedItem { item: JournalItemInput; bytes: number }

/** Whether the provider has no word about a row's item: the Controller then made the key, and nothing can rebuild the item. */
export const isLiveOnlyRow = (row: CanonicalTimelineRow): boolean => row.identity === undefined || row.identity.liveOnly === true;

/** Groups rows by item, in the order the items first appear. An item is complete when its last row completes it. A row without identity is a complete, live-only item of its own. */
export function groupItems(rows: readonly CanonicalTimelineRow[]): TimelineItem[] {
  const items = new Map<string, TimelineItem>();
  for (const row of rows) {
    const key = rowItemKey(row);
    let item = items.get(key);
    if (!item) {
      item = { key, rows: [], complete: false, liveOnly: false };
      items.set(key, item);
    }
    item.rows.push(row);
    // The journal's rule: a content row for a complete item reopens it, and a row that completes closes it.
    item.complete = row.identity === undefined || row.identity.completes === true;
    if (isLiveOnlyRow(row)) item.liveOnly = true;
  }
  return [...items.values()];
}

/**
 * The row an item has in a journal: its content with its rows merged the way the journal merges them, and the time,
 * source and turn of its first row. A journal that holds the item as one row, or as the deltas it came from, shows the same item.
 */
export function mergedRow(item: TimelineItem): JournalRowInput {
  const [first, ...rest] = item.rows as [CanonicalTimelineRow, ...CanonicalTimelineRow[]];
  const entry = entryFromRow(first);
  for (const row of rest) mergeRowIntoEntry(entry, row);
  return {
    itemKey: item.key, providerId: first.providerId, sourceKey: first.sourceKey, occurredAt: first.occurredAt,
    ...(first.turnId === undefined ? {} : { turnId: first.turnId }),
    item: entry.item, ...(entry.resources.length === 0 ? {} : { resources: entry.resources }),
    ...(item.liveOnly ? { liveOnly: true } : {}),
  };
}

const PROBE = { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_publish', sessionKey: 'probe:probe', generation: 1 } as const;

/**
 * The bytes an entry takes on the wire, or undefined when the wire refuses it: a field over its limit, a row that is
 * not a valid timeline row, or a message over the Relay's size bound. One refused row would make the whole message
 * unencodable, so every row is measured before it joins a publication.
 */
export function entryBytes(op: PublishOp): number | undefined {
  const encoded = encodeRemoteHostUplinkMessage({ ...PROBE, entries: [{ sequence: 1, ...op } as JournalPublishEntry] });
  return encoded.status === 'ok' ? Buffer.byteLength(encoded.json) : undefined;
}

/** The items the wire accepts, each with its digest (none for an item still open) and size, and the keys of those it refuses. */
export async function sizedItems(items: readonly TimelineItem[], digest: (item: TimelineItem) => Promise<string>): Promise<{ accepted: SizedItem[]; refused: string[] }> {
  const accepted: SizedItem[] = [];
  const refused: string[] = [];
  for (const item of items) {
    const input: JournalItemInput = { row: mergedRow(item), ...(item.complete ? { digest: await digest(item) } : {}) };
    const bytes = entryBytes({ op: 'prepend', items: [input] });
    if (bytes === undefined) refused.push(item.key);
    else accepted.push({ item: input, bytes });
  }
  return { accepted, refused };
}

/** Consecutive blocks of items, in their order, each within the budget of one message (at least one item each). */
export function blocksOf(items: readonly SizedItem[]): JournalItemInput[][] {
  const blocks: JournalItemInput[][] = [];
  let current: JournalItemInput[] = [];
  let bytes = 0;
  for (const sized of items) {
    if (current.length > 0 && (current.length >= JOURNAL_ITEMS_PER_ENTRY_MAX || bytes + sized.bytes > MESSAGE_BUDGET_BYTES)) {
      blocks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(sized.item);
    bytes += sized.bytes;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** The newest items that fit one message, oldest first, taken from the end; at least one when there is any the wire accepts. */
export async function newestItems(items: readonly TimelineItem[], digest: (item: TimelineItem) => Promise<string>): Promise<{ block: JournalItemInput[]; keys: string[]; refused: string[] }> {
  const block: JournalItemInput[] = [];
  const keys: string[] = [];
  const refused: string[] = [];
  let bytes = 0;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const { accepted, refused: bad } = await sizedItems([items[at] as TimelineItem], digest);
    refused.push(...bad);
    const sized = accepted[0];
    if (!sized) continue;
    if (block.length > 0 && (block.length >= JOURNAL_ITEMS_PER_ENTRY_MAX || bytes + sized.bytes > MESSAGE_BUDGET_BYTES)) break;
    block.unshift(sized.item);
    keys.unshift((items[at] as TimelineItem).key);
    bytes += sized.bytes;
  }
  return { block, keys, refused };
}

/** Publications, in order, each within the entry count and the byte budget of one message. */
export function chunkOps(ops: readonly SizedOp[]): Array<{ ops: PublishOp[]; bytes: number }> {
  const chunks: Array<{ ops: PublishOp[]; bytes: number }> = [];
  let current: { ops: PublishOp[]; bytes: number } = { ops: [], bytes: 0 };
  for (const sized of ops) {
    if (current.ops.length > 0 && (current.ops.length >= JOURNAL_PUBLISH_MAX_ENTRIES || current.bytes + sized.bytes > MESSAGE_BUDGET_BYTES)) {
      chunks.push(current);
      current = { ops: [], bytes: 0 };
    }
    current.ops.push(sized.op);
    current.bytes += sized.bytes;
  }
  if (current.ops.length > 0) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 5: Run the test and see it pass.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-items.test.ts --testTimeout=10000`
Expected: PASS.

- [ ] **Step 6: Write the failing test of the plan.** Create `packages/agent-host/src/journal-reconcile.test.ts`. `index` is what the Relay's journal reports; `items` is the reread:

<!-- write: packages/agent-host/src/journal-reconcile.test.ts -->
```ts
import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import type { CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';
import { describe, expect, it } from 'vitest';

import { groupItems, mergedRow, type PublishOp, type TimelineItem } from './journal-items.js';
import { planPublication, replacementPlan, type PublicationPlan } from './journal-reconcile.js';

let seq = 0;
const row = (key: string, text: string, identity: CanonicalTimelineRow['identity'] = { key, completes: true }): CanonicalTimelineRow => ({
  epoch: 'e', seq: ++seq, providerId: 'fake', sourceKey: `source:${seq}`, occurredAt: 1_725_000_000_000 + seq, timestamp: new Date(1_725_000_000_000 + seq).toISOString(),
  turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key }, resources: [], ...(identity ? { identity } : {}),
});
const digest = (item: TimelineItem) => itemDigest(mergedRow(item).item);
const items = (...rows: CanonicalTimelineRow[]) => groupItems(rows);

async function indexOf(timeline: TimelineItem[], extra: Partial<JournalIndexEntry> = {}): Promise<JournalIndexEntry[]> {
  const entries: JournalIndexEntry[] = [];
  let next = 1;
  for (const item of timeline) {
    entries.push({ itemKey: item.key, seqStart: next, seqEnd: next, state: 'complete', digest: await digest(item), liveOnly: false, revision: next, resident: true, ...extra });
    next += 1;
  }
  return entries;
}

const ops = (plan: PublicationPlan): PublishOp[] => plan.kind === 'continue' ? [...plan.ops, ...plan.older].map(({ op }) => op) : plan.kind === 'replace' ? plan.ops.map(({ op }) => op) : [];
const summary = (plan: PublicationPlan) => ops(plan).map(op => op.op === 'append' || op.op === 'correct' ? `${op.op}:${op.row.itemKey}` : op.op === 'complete' || op.op === 'seal' ? `${op.op}:${op.itemKey}`
  : op.op === 'prepend' || op.op === 'replace' ? `${op.op}:${op.items.map(({ row: { itemKey } }) => itemKey).join(',')}` : op.op === 'outcome' ? `outcome:${op.background.id}` : op.op);

describe('bringing a journal up to date', () => {
  it('publishes nothing for an unchanged session', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await planPublication(await indexOf(timeline), timeline, digest))).toEqual([]);
  });

  it('appends an item the journal does not know, and completes it', async () => {
    const known = items(row('a', 'One'));
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await planPublication(await indexOf(known), timeline, digest))).toEqual(['append:b', 'complete:b']);
  });

  it('appends an item that is still open without completing it', async () => {
    const known = items(row('a', 'One'));
    const timeline = items(row('a', 'One'), row('b', 'Tw', { key: 'b' }));
    expect(summary(await planPublication(await indexOf(known), timeline, digest))).toEqual(['append:b']);
  });

  it('corrects an item whose content changed, naming the revision it saw, and completes it with the new digest', async () => {
    const before = items(row('a', 'One'), row('b', 'Two'));
    const timeline = items(row('a', 'One'), row('b', 'Two, extended'));
    const plan = await planPublication(await indexOf(before), timeline, digest);
    expect(summary(plan)).toEqual(['correct:b']);
    expect(ops(plan)[0]).toMatchObject({ expectedRevision: 2, digest: await digest(timeline[1]!) });
  });

  it('corrects an item the journal holds open without completing an item that is still open', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two', { key: 'b' }));
    const index = await indexOf(timeline);
    index[1] = { ...index[1]!, state: 'open', digest: undefined };
    const plan = await planPublication(index, timeline, digest);
    expect(summary(plan)).toEqual(['correct:b']);
    expect(ops(plan)[0]).not.toHaveProperty('digest');
  });

  it('prepends older history the journal has not seen, newest block first', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const known = full.slice(2);
    const plan = await planPublication(await indexOf(known), full, digest);
    expect(summary(plan)).toEqual(['prepend:a,b']);
  });

  it('seals an open item that native history no longer holds, and leaves live-only items alone', async () => {
    const reread = items(row('a', 'One'));
    const journal = items(row('a', 'One'), row('b', 'Streamed once', { key: 'b' }), row('i', 'Question', { key: 'i', completes: true, liveOnly: true }));
    const index = await indexOf(journal);
    index[1] = { ...index[1]!, state: 'open', digest: undefined };
    index[2] = { ...index[2]!, liveOnly: true };
    expect(summary(await planPublication(index, reread, digest))).toEqual(['seal:b']);
  });

  it('replaces only when native history was rewritten, with the newest items', async () => {
    const journal = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const missing = items(row('a', 'One'), row('c', 'Three'));
    const plan = await planPublication(await indexOf(journal), missing, digest);
    expect(plan).toMatchObject({ kind: 'replace', reason: 'missing' });
    expect(summary(plan)).toEqual(['replace:a,c']);
    expect(await planPublication(await indexOf(journal), items(row('c', 'Three'), row('a', 'One')), digest)).toMatchObject({ kind: 'replace', reason: 'reordered' });
    expect(await planPublication(await indexOf(journal), items(row('a', 'One'), row('x', 'New'), row('b', 'Two'), row('c', 'Three')), digest)).toMatchObject({ kind: 'replace', reason: 'inserted' });
  });

  it('leaves journal items older than the reread alone, because they are outside its window', async () => {
    const journal = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await planPublication(await indexOf(journal), items(row('b', 'Two'), row('c', 'Three')), digest))).toEqual(['append:c', 'complete:c']);
  });

  it('replaces an empty journal in one entry, and publishes nothing for an empty session', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    const plan = await planPublication([], timeline, digest);
    expect(plan).toMatchObject({ kind: 'replace', reason: 'initial' });
    expect(summary(plan)).toEqual(['replace:a,b']);
    expect(summary(await planPublication([], [], digest))).toEqual([]);
  });

  it('asks for older history when none of the reread is in the journal', async () => {
    const journal = items(row('x', 'Older than the reread'));
    expect(await planPublication(await indexOf(journal), items(row('a', 'One')), digest)).toEqual({ kind: 'gap' });
  });

  it('compares only the newest items when the window is narrowed, and leaves the older journal items alone', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const plan = await planPublication(await indexOf(full), full, digest, { window: 2 });
    expect(summary(plan)).toEqual([]);
  });

  it('replaces with the newest items of the window when told to, which a quota refusal does', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'));
    const plan = await planPublication(await indexOf(full), full, digest, { forceReplace: true, window: 2 });
    expect(plan).toMatchObject({ kind: 'replace', reason: 'quota' });
    expect(summary(plan)).toEqual(['replace:b,c']);
  });

  it('keeps an item the wire refuses out of the plan and names it', async () => {
    const long = 'k'.repeat(4097);
    const timeline = items(row('a', 'One'), row(long, 'Too long'));
    const plan = await planPublication(await indexOf(items(row('a', 'One'))), timeline, digest);
    expect(plan).toMatchObject({ kind: 'continue', refused: [long] });
    expect(summary(plan)).toEqual([]);
  });

  it('publishes older history apart from the other operations, so a head can go between them', async () => {
    const full = items(row('a', 'One'), row('b', 'Two'), row('c', 'Three'), row('d', 'Four'));
    const known = items(row('b', 'Two'), row('c', 'Three Changed'));
    const plan = await planPublication(await indexOf(known), full, digest);
    expect(plan).toMatchObject({ kind: 'continue' });
    if (plan.kind !== 'continue') throw new Error('Expected a continuing plan.');
    expect(plan.ops.map(({ op }) => op.op)).toEqual(['correct', 'append', 'complete']);
    expect(plan.older.map(({ op }) => op.op)).toEqual(['prepend']);
  });

  it('puts an item that is still open in a replacement without a digest', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Streaming', { key: 'b' }));
    const plan = await planPublication([], timeline, digest);
    if (plan.kind !== 'replace') throw new Error('Expected a replacement.');
    const op = plan.ops[0]!.op;
    expect(op.op === 'replace' && op.items.map(item => [item.row.itemKey, item.digest === undefined])).toEqual([['a', false], ['b', true]]);
  });

  it('says again the outcome of every background in the window, with the strongest status', async () => {
    const withBackground = (key: string, status: 'pending' | 'visible') => row(key, key, { key, completes: true });
    const first = withBackground('a', 'pending');
    first.item = { type: 'assistant_message', text: 'a', messageId: 'a', background: { id: 'review-1', kind: 'review', status: 'pending' } };
    const second = withBackground('b', 'visible');
    second.item = { type: 'assistant_message', text: 'b', messageId: 'b', background: { id: 'review-1', kind: 'review', status: 'visible' } };
    const timeline = items(first, second, row('c', 'No background'));
    const continued = await planPublication(await indexOf(timeline), timeline, digest);
    expect(summary(continued)).toEqual(['outcome:review-1']);
    const op = ops(continued)[0]!;
    expect(op.op === 'outcome' && op.background.status).toBe('visible');
    expect(summary(await planPublication([], timeline, digest))).toEqual(['replace:a,b,c', 'outcome:review-1']);
  });

  it('builds the replacement a gap that could not be closed calls for', async () => {
    const timeline = items(row('a', 'One'), row('b', 'Two'));
    expect(summary(await replacementPlan(timeline, digest, 'gap'))).toEqual(['replace:a,b']);
  });
});
```

- [ ] **Step 7: Run it and see it fail.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-reconcile.test.ts --testTimeout=10000`
Expected: FAIL (`./journal-reconcile.js` does not exist).

- [ ] **Step 8: Implement the plan.** Create `packages/agent-host/src/journal-reconcile.ts`:

<!-- write: packages/agent-host/src/journal-reconcile.ts -->
```ts
import { planReconcile, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import { mergeBackgroundActivity, type BackgroundActivity } from '@orchardworks/agent-remote-protocol';

import { blocksOf, entryBytes, mergedRow, newestItems, sizedItems, type PublishOp, type SizedOp, type TimelineItem } from './journal-items.js';

/** The digest an item that is still open has in a comparison: it equals no real digest, so a known open item is always corrected. */
const OPEN_DIGEST = 'open';

export type ReplaceReason = 'missing' | 'reordered' | 'inserted' | 'initial' | 'gap' | 'quota';

export type PublicationPlan =
  /**
   * The epoch continues. `ops` are corrections, new items, seals and background outcomes, in the order to publish them;
   * `older` is older history, newest block first, which is published after the head so a long history never delays it.
   */
  | { kind: 'continue'; ops: SizedOp[]; older: SizedOp[]; refused: string[] }
  /** The newest items as a new epoch, with the outcomes of their backgrounds. Older items follow as older history once the journal is opened again. */
  | { kind: 'replace'; reason: ReplaceReason; ops: SizedOp[]; refused: string[] }
  /** None of the reread is in the journal: older history must be read before a decision. */
  | { kind: 'gap' };

export interface PlanOptions {
  /** Compare only the newest `window` items of the reread. A quota refusal narrows it. */
  window?: number;
  /** Replace without comparing, as a quota refusal asks. */
  forceReplace?: boolean;
}

/**
 * One outcome entry for each background of the items, with the strongest status their rows carry. A journal built from a
 * reread has the backgrounds of its rows but not the outcomes the Controller learned about later, so each reconcile
 * says them again; applying an outcome twice changes nothing.
 */
export function outcomeOps(items: readonly TimelineItem[]): SizedOp[] {
  const found = new Map<string, { providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number }>();
  for (const item of items) {
    if (!item.rows.some(row => row.item.background)) continue;
    const row = mergedRow(item);
    const background = row.item.background;
    if (!background) continue;
    const previous = found.get(background.id);
    found.set(background.id, {
      providerId: row.providerId, ...(row.turnId === undefined ? {} : { turnId: row.turnId }), occurredAt: row.occurredAt,
      background: previous ? mergeBackgroundActivity(previous.background, background) : background,
    });
  }
  return [...found.values()].flatMap(outcome => {
    const op: PublishOp = { op: 'outcome', ...outcome };
    const bytes = entryBytes(op);
    return bytes === undefined ? [] : [{ op, bytes }];
  });
}

/** A replacement from the newest items that fit one message. An empty reread has nothing to replace with. */
export async function replacementPlan(timeline: readonly TimelineItem[], digest: (item: TimelineItem) => Promise<string>, reason: ReplaceReason): Promise<PublicationPlan> {
  const { block, keys, refused } = await newestItems(timeline, digest);
  const op: PublishOp = { op: 'replace', items: block };
  const bytes = entryBytes(op);
  if (bytes === undefined) return { kind: 'replace', reason, ops: [], refused };
  const included = new Set(keys);
  return { kind: 'replace', reason, ops: [{ op, bytes }, ...outcomeOps(timeline.filter(item => included.has(item.key)))], refused };
}

/**
 * Compares the Controller's timeline, read again, with the item index the Relay holds and says what to publish. The
 * epoch continues unless native history was genuinely rewritten: unknown items are appended, a known item that is open or
 * whose digest differs is corrected, leading items the journal never saw are older history, and an open item that history
 * no longer holds is sealed. `index` is in journal order; `timeline` is oldest first. Items the wire refuses must be left
 * out of `timeline` by the caller, so that one cannot make every reconcile look like a rewrite.
 */
export async function planPublication(
  index: readonly JournalIndexEntry[], timeline: readonly TimelineItem[], digest: (item: TimelineItem) => Promise<string>, options: PlanOptions = {},
): Promise<PublicationPlan> {
  const items = options.window === undefined ? [...timeline] : timeline.slice(-options.window);
  if (options.forceReplace) return replacementPlan(items, digest, 'quota');
  if (index.length === 0) {
    return items.length === 0 ? { kind: 'continue', ops: [], older: [], refused: [] } : replacementPlan(items, digest, 'initial');
  }
  const candidates = [];
  for (const item of items) candidates.push({ itemKey: item.key, digest: item.complete ? await digest(item) : OPEN_DIGEST });
  const plan = planReconcile(index, candidates);
  if (plan.kind === 'gap') return { kind: 'gap' };
  if (plan.kind === 'replace') return replacementPlan(items, digest, plan.reason);

  const byKey = new Map(items.map(item => [item.key, item]));
  const revisions = new Map(index.map(entry => [entry.itemKey, entry.revision]));
  const ops: SizedOp[] = [];
  const older: SizedOp[] = [];
  const refused: string[] = [];
  const add = (op: PublishOp, key: string): void => {
    const bytes = entryBytes(op);
    if (bytes === undefined) refused.push(key);
    else ops.push({ op, bytes });
  };

  // Older history lands below the oldest item, so the block next to it goes first.
  const prepended = await sizedItems(plan.prepend.map(key => byKey.get(key) as TimelineItem), digest);
  refused.push(...prepended.refused);
  const sizeOf = new Map(prepended.accepted.map(sized => [sized.item.row.itemKey, sized.bytes]));
  for (const block of blocksOf(prepended.accepted).reverse()) {
    older.push({ op: { op: 'prepend', items: block }, bytes: block.reduce((sum, { row }) => sum + (sizeOf.get(row.itemKey) ?? 0), 0) });
  }
  for (const key of plan.correct) {
    const item = byKey.get(key) as TimelineItem;
    add({ op: 'correct', row: mergedRow(item), ...(item.complete ? { digest: await digest(item) } : {}), expectedRevision: revisions.get(key) as number }, key);
  }
  for (const key of plan.append) {
    const item = byKey.get(key) as TimelineItem;
    const before = ops.length;
    add({ op: 'append', row: mergedRow(item) }, key);
    if (item.complete && ops.length > before) add({ op: 'complete', itemKey: key, digest: await digest(item) }, key);
  }
  for (const key of plan.abandon) add({ op: 'seal', itemKey: key }, key);
  ops.push(...outcomeOps(items));
  return { kind: 'continue', ops, older, refused };
}
```

- [ ] **Step 9: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-items.test.ts src/journal-reconcile.test.ts --testTimeout=10000`
Expected: PASS.

- [ ] **Step 10: Commit.**

```bash
git add packages/agent-host/package.json pnpm-lock.yaml packages/agent-host/src/journal-items.ts packages/agent-host/src/journal-items.test.ts packages/agent-host/src/journal-reconcile.ts packages/agent-host/src/journal-reconcile.test.ts
git commit -m "feat(host): turn the Controller's timeline into journal items, and plan what a reopened journal needs" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 9: The publisher: one publication per session, and the connection they share

`journal-publication.ts` is the state machine of one session. `journal-publisher.ts` owns what the sessions share on one uplink connection.

How one session publishes, which the code below follows:

1. **Open.** The publication follows the agent manager (a tap that is not a viewer), so the timeline it reads and the events after it join without a gap. It sends `journal_open`, takes the first page of the item index and pulls the rest with `journal_index_request` while `indexAfter` is present. Events of the manager wait.
2. **Reconcile.** It reads the timeline again as items and calls `planPublication` against the index (Task 8). A `gap` means none of the reread is in the journal: it reads older native history through the manager, at most `gapReadsMax` pages, and replaces when it still finds nothing. It publishes the plan's operations in messages that fit the wire, and ends with the head. A replacement is followed by opening again, which adds the older items as older history.
3. **Live.** It publishes what the manager emits. Rows of the same item that follow each other merge; a completion carries the digest of the whole item; an item that is still open stays open. Messages go out one per session at a time: the next waits for the Relay's acknowledgement, because the Relay acknowledges only what its store holds. Messages of all sessions share a budget of bytes and messages in flight, so the uplink writer, which closes the connection when its queue fills, never overflows.
4. **Recover.** A refusal that names an item (and only that kind) skips the item and renumbers what follows it from the refused sequence, because a refused entry never consumes its sequence. Any other refusal, a `sequence_gap` among them, a timeout or a lost connection opens the session again and reconciles from the manager's timeline, which is the Controller's source of truth. A `quota_exceeded` refusal replaces with narrower windows; when the narrowest is refused the session stops with a diagnostic. An `incomplete` refusal replaces again with the same window, then sends the head. An open refused with `index_too_large` is repeated once with `reset: true`, whose first publication is a replacement that fits; any other refused open ends the session's publishing until the next connection.

Heads: the head is the manager's Snapshot, taken when a batch is drained, so it never claims more than the rows before it. A head whose pending interactions changed is published at once instead of after the batch window.

**Files:**
- Create: `packages/agent-host/src/journal-publication.ts`
- Create: `packages/agent-host/src/journal-publisher.ts`
- Create: `packages/agent-host/src/test-utils/journal-scripted-session.ts`
- Create: `packages/agent-host/src/test-utils/journal-relay-loopback.ts`
- Create: `packages/agent-host/src/journal-publisher.test.ts`
- Create: `packages/agent-host/src/journal-publisher.relay.test.ts`

- [ ] **Step 1: Write the test helpers.** The scripted session is a provider session whose history and live observations a test controls, with older history pages. Create `packages/agent-host/src/test-utils/journal-scripted-session.ts`:

<!-- write: packages/agent-host/src/test-utils/journal-scripted-session.ts -->
```ts
import type { AgentCapabilities, AgentResourceReadResult, AgentRuntimeInfo, AgentSession, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { AgentManager } from '@orchardworks/agent-remote-relay';

const capabilities: AgentCapabilities = {
  history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: true, planApproval: true, toolApproval: true },
};

export interface OlderPage { observations: ProviderObservation[]; nextCursor?: string }

/** A provider session a test drives: queued items, then live items pushed later, and older pages read on request. */
export class ScriptedSession implements AgentSession {
  readonly capabilities: AgentCapabilities;
  readonly sent: string[] = [];
  private readonly queue: ProviderStreamItem[];
  private waiter: ((item: ProviderStreamItem | undefined) => void) | undefined;
  private disposed = false;
  readonly readTimelineHistory?: AgentSession['readTimelineHistory'];
  readonly readResource?: (locator: string) => Promise<AgentResourceReadResult>;

  /** `resources` are the files the session can read, by locator; with any, the session says it can read resources. */
  constructor(readonly providerId: string, readonly nativeSessionId: string, initial: ProviderStreamItem[], older?: OlderPage[], resources?: Record<string, Uint8Array>) {
    this.capabilities = { ...capabilities, ...(resources ? { readResource: true } : {}) };
    if (resources) this.readResource = async locator => resources[locator] ? { status: 'available', bytes: resources[locator]!, mediaType: 'image/png' } : { status: 'unavailable', reason: 'No such file.' };
    this.queue = [...initial];
    if (older) {
      const pages = [...older];
      this.readTimelineHistory = async () => pages.shift() ?? { observations: [] };
    }
  }

  async *observe(): AsyncIterable<ProviderStreamItem> {
    while (true) {
      const item = this.queue.shift() ?? await new Promise<ProviderStreamItem | undefined>(resolve => { if (this.disposed) resolve(undefined); else this.waiter = resolve; });
      if (!item) return;
      yield item;
    }
  }

  push(item: ProviderStreamItem): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter(item); } else this.queue.push(item);
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle', persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } };
  }
  async sendMessage(text: string): Promise<void> { this.sent.push(text); }
  async respondToInteraction(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
  }
}

let sequence = 0;

/** A timeline observation of one item. `completes` ends the item; history rows always complete their item. */
export function item(delivery: 'history' | 'live', key: string, text: string, options: { completes?: boolean; liveOnly?: boolean; type?: 'assistant_message' | 'user_message'; sourceKey?: string; turnId?: string } = {}): ProviderObservation {
  sequence += 1;
  const completes = options.completes ?? delivery === 'history';
  return {
    type: 'observation', sourceKey: options.sourceKey ?? `${delivery}:${key}:${sequence}`, occurredAt: 1_725_000_000_000 + sequence, delivery,
    event: { type: 'timeline', provider: 'fake', turnId: options.turnId ?? 'turn-1', item: { type: options.type ?? 'assistant_message', text, messageId: key } },
    itemIdentity: { key, ...(completes ? { completes: true as const } : {}), ...(options.liveOnly ? { liveOnly: true as const } : {}) },
  };
}

export const boundary = (olderCursor?: string): ProviderStreamItem => ({ type: 'history_boundary', ...(olderCursor === undefined ? {} : { olderCursor }) });

/** An agent manager over a scripted session, ready after its history boundary. It checks the identity contract, as the manager of a journal-capable provider does. */
export async function attachScripted(session: ScriptedSession, agentId = 'agent-1', options: { resourceIdKey?: string } = {}): Promise<AgentManager> {
  const manager = await AgentManager.attach({ agentId, provider: { providerId: session.providerId, displayName: 'Fake' }, epoch: `epoch-${agentId}`, session, journalContract: true, ...(options.resourceIdKey === undefined ? {} : { resourceIdKey: options.resourceIdKey }) });
  await manager.ready;
  return manager;
}

export const settle = (ms = 30) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Polls until the check passes, so a failure names what never happened. */
export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
```

The loopback joins the publisher to the Relay's real journal logic: `createHostJournals` over a `MemoryJournalStore`, and the real per-connection adapter. Both directions are asynchronous, as a socket is. Create `packages/agent-host/src/test-utils/journal-relay-loopback.ts`:

<!-- write: packages/agent-host/src/test-utils/journal-relay-loopback.ts -->
```ts
import { createHostJournals, type JournalPublished } from '@orchardworks/agent-remote-hosted';
import { createJournalConnection, type JournalConnection } from '@orchardworks/agent-remote-hosted/journal-uplink';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import type { JournalPublisher } from '../journal-publisher.js';

export const HOST_ID = 'host-1';

/** The Relay's journal service and its per-connection adapter, wired to a publisher through asynchronous hand-offs. */
export function relayLoopback() {
  const store = new MemoryJournalStore();
  const journals = createHostJournals({ store, now: () => 1_000 });
  const fromPublisher: Array<Record<string, any>> = [];
  const fromRelay: JournalRelayMessage[] = [];
  const published: Array<{ sessionKey: string; result: JournalPublished }> = [];
  let publisher: JournalPublisher | undefined;
  let online = true;
  const connection: JournalConnection = createJournalConnection({
    hostId: HOST_ID, journals, current: () => online,
    scheduler: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) },
    send: (message: RemoteHostUplinkMessage) => {
      const relayMessage = message as JournalRelayMessage;
      fromRelay.push(relayMessage);
      queueMicrotask(() => publisher?.receive(relayMessage));
    },
    published: (sessionKey, result) => { published.push({ sessionKey, result }); },
  });
  const writer = {
    send(json: string): void {
      const message = JSON.parse(json);
      fromPublisher.push(message);
      queueMicrotask(() => { void connection.receive(message).catch(() => undefined); });
    },
  };
  return {
    store, journals, connection, writer, fromPublisher, fromRelay, published,
    /** The publisher the Relay's messages go to. */
    connect(next: JournalPublisher): void { publisher = next; next.available(writer); },
    /** Ends the connection: the Relay forgets which sessions it opened, and the publisher is told. */
    disconnect(): void { online = false; connection.close(); publisher?.available(undefined); },
    /** The journal the Relay holds for a session. */
    async journal(sessionKey: string): Promise<SessionJournal | undefined> {
      const state = await store.load(`${HOST_ID}:${sessionKey}`);
      return state ? new SessionJournal(state) : undefined;
    },
  };
}
```

- [ ] **Step 2: Write the failing tests against a scripted Relay.** The scripted Relay answers like the real one and lets a test refuse, delay or drop. Create `packages/agent-host/src/journal-publisher.test.ts`:

<!-- write: packages/agent-host/src/journal-publisher.test.ts -->
```ts
import type { JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage } from '@orchardworks/agent-remote-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJournalPublisher, type JournalPublisher, type JournalSource } from './journal-publisher.js';
import { attachScripted, boundary, item, ScriptedSession, settle, until } from './test-utils/journal-scripted-session.js';

type Wire = Record<string, any>;
const realSetTimeout = setTimeout;
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

const entry = (itemKey: string, at: number, extra: Partial<JournalIndexEntry> = {}): JournalIndexEntry =>
  ({ itemKey, seqStart: at, seqEnd: at, state: 'complete', digest: 'd', liveOnly: false, revision: at, resident: true, ...extra });

/** A Relay that answers the publisher by script and keeps the item index of what it was sent. Every message the publisher writes is recorded. */
function scriptedRelay(options: { index?: JournalIndexEntry[]; pages?: JournalIndexEntry[][]; watermark?: number; staleFirstPage?: boolean; holdOpened?: boolean; refuseOpen?(opens: number, reset: boolean): boolean; onPublish?(message: Wire, answer: Answer): void } = {}) {
  const written: Wire[] = [];
  const writtenAt: number[] = [];
  const refusedAt: number[] = [];
  let publisher!: JournalPublisher;
  let generation = 0;
  let applied = options.watermark ?? 0;
  let model: JournalIndexEntry[] = [...(options.index ?? [])];
  let revision = 100;
  const heldOpens: Array<() => void> = [];
  const send = (message: JournalRelayMessage) => queueMicrotask(() => publisher.receive(message));
  interface Answer { ack(): void; refuse(reason: string, itemKey?: string, sequence?: number): void; ignore(): void }
  const known = (items: Wire[], first: number): JournalIndexEntry[] => items.map((value, at) => ({
    itemKey: value.row.itemKey, seqStart: first + at, seqEnd: first + at, state: 'complete' as const, digest: value.digest, liveOnly: value.row.liveOnly === true, revision: ++revision, resident: true,
  }));
  const apply = (entries: Wire[]): void => {
    for (const value of entries) {
      const at = model.findIndex(item => item.itemKey === (value.itemKey ?? value.row?.itemKey));
      if (value.op === 'replace') model = known(value.items, 1);
      else if (value.op === 'prepend') model = [...known(value.items, (model[0]?.seqStart ?? 1) - value.items.length), ...model];
      else if (value.op === 'append' && at < 0) model.push({ itemKey: value.row.itemKey, seqStart: (model.at(-1)?.seqEnd ?? 0) + 1, seqEnd: (model.at(-1)?.seqEnd ?? 0) + 1, state: 'open', liveOnly: value.row.liveOnly === true, revision: ++revision, resident: true });
      else if (value.op === 'complete' && at >= 0) model[at] = { ...model[at]!, state: 'complete', digest: value.digest, revision: ++revision };
      else if (value.op === 'correct' && at >= 0) model[at] = { ...model[at]!, state: value.digest ? 'complete' : 'open', digest: value.digest, revision: ++revision };
      else if (value.op === 'seal' && at >= 0) model[at] = { ...model[at]!, state: 'complete', liveOnly: true, digest: undefined, revision: ++revision };
    }
  };
  const writer = { send(json: string) {
    const message: Wire = JSON.parse(json);
    written.push(message);
    writtenAt.push(Date.now());
    if (message.type === 'journal_open') {
      if (options.refuseOpen?.(written.filter(item => item.type === 'journal_open').length, message.reset === true)) {
        send({ uplinkVersion: 2, type: 'journal_open_refused', requestId: message.requestId, sessionKey: message.sessionKey, reason: 'index_too_large' });
        return;
      }
      generation += 1;
      const paged = (options.pages?.length ?? 0) > 0;
      if (message.reset) model = [];
      const first = message.reset ? [] : paged ? (options.index ?? []) : structuredClone(model);
      const reply = () => send({ uplinkVersion: 2, type: 'journal_opened', requestId: message.requestId, sessionKey: message.sessionKey, generation, watermark: applied, epoch: 'epoch-1', index: first,
        ...(paged ? { indexAfter: first.at(-1)?.seqStart ?? 0 } : {}) } as JournalRelayMessage);
      if (options.holdOpened) heldOpens.push(reply); else reply();
    } else if (message.type === 'journal_index_request') {
      const requests = written.filter(item => item.type === 'journal_index_request').length;
      if (options.staleFirstPage && requests === 1) {
        send({ uplinkVersion: 2, type: 'journal_open_refused', requestId: message.requestId, sessionKey: message.sessionKey, reason: 'stale_epoch' });
        return;
      }
      const page = (options.pages ?? [])[options.staleFirstPage ? requests - 2 : requests - 1] ?? [];
      send({ uplinkVersion: 2, type: 'journal_index_page', requestId: message.requestId, sessionKey: message.sessionKey, index: page,
        ...((options.staleFirstPage ? requests - 1 : requests) < (options.pages ?? []).length ? { indexAfter: page.at(-1)?.seqStart ?? 0 } : {}) } as JournalRelayMessage);
    } else if (message.type === 'journal_publish') {
      const last = message.entries.at(-1).sequence as number;
      // As the journal does: a publication starts exactly after the watermark, and a refused entry consumes no sequence.
      if (message.entries[0].sequence !== applied + 1) {
        refusedAt.push(Date.now());
        send({ uplinkVersion: 2, type: 'journal_refused', sessionKey: message.sessionKey, generation: message.generation, sequence: message.entries[0].sequence, reason: 'sequence_gap' });
        return;
      }
      const answer: Answer = {
        ack: () => { apply(message.entries); applied = last; send({ uplinkVersion: 2, type: 'journal_ack', sessionKey: message.sessionKey, generation: message.generation, watermark: last, cursor: { epoch: 'epoch-1', seq: last } }); },
        refuse: (reason, itemKey, sequence = message.entries[0].sequence) => { refusedAt.push(Date.now()); send({ uplinkVersion: 2, type: 'journal_refused', sessionKey: message.sessionKey, generation: message.generation, sequence, reason, ...(itemKey ? { itemKey } : {}) } as JournalRelayMessage); },
        ignore: () => undefined,
      };
      const refuse = answer.refuse;
      answer.refuse = (reason, itemKey, sequence = message.entries[0].sequence) => {
        // The entries before the refused one are stored; the refused one and those after it are not, and `applied` stops before it.
        const before = message.entries.filter((entry: Wire) => entry.sequence < sequence);
        if (itemKey !== undefined && before.length > 0) { apply(before); applied = sequence - 1; }
        refuse(reason, itemKey, sequence);
      };
      if (options.onPublish) options.onPublish(message, answer); else answer.ack();
    }
  } };
  return {
    written, send, connect(next: JournalPublisher) { publisher = next; next.available(writer); },
    types: () => written.map(message => message.type),
    ops: () => written.filter(message => message.type === 'journal_publish').flatMap(message => message.entries.map((entry: Wire) => entry.op)),
    opens: () => written.filter(message => message.type === 'journal_open').length,
    opensAt: () => written.flatMap((message, at) => message.type === 'journal_open' ? [writtenAt[at]!] : []),
    refusedAt: () => refusedAt,
    releaseOpens: () => { for (const reply of heldOpens.splice(0)) reply(); },
    model: () => model,
  };
}

const publisherFor = (relay: ReturnType<typeof scriptedRelay>, limits: Record<string, unknown> = {}, diagnostics: Wire[] = []) => {
  const publisher = createJournalPublisher({ providers: () => ['fake'], limits: { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 400, ...limits }, diagnostic: event => diagnostics.push(event) });
  closers.push(() => publisher.close());
  relay.connect(publisher);
  return publisher;
};

async function attachSession(publisher: JournalPublisher, history: ReturnType<typeof item>[], older?: Array<{ observations: ReturnType<typeof item>[]; nextCursor?: string }>, ids = { agentId: 'agent-1', nativeSessionId: 'thread-1' }) {
  const session = new ScriptedSession('fake', ids.nativeSessionId, [...history, boundary(older ? 'older-1' : undefined)], older);
  const manager = await attachScripted(session, ids.agentId);
  closers.push(() => { void manager.close(); });
  publisher.attach({ agentId: ids.agentId, providerId: 'fake', nativeSessionId: ids.nativeSessionId, source: manager });
  return { session, manager };
}

describe('publishing a session', () => {
  it('opens the journal, publishes the history as one replacement of an empty journal, and ends with the head', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.types()[0]).toBe('journal_open');
    expect(relay.written[0]).toMatchObject({ sessionKey: 'fake:thread-1', publisherId: expect.any(String) });
    const publish = relay.written.find(message => message.type === 'journal_publish')!;
    expect(publish.generation).toBe(1);
    expect(publish.entries.map((entry: Wire) => entry.op)).toEqual(['replace', 'head']);
    expect(publish.entries[0].items.map((entry: Wire) => entry.row.itemKey)).toEqual(['m1', 'm2']);
    expect(publish.entries[1].head.snapshot.id).toBe('agent-1');
  });

  it('does nothing for a journal that already holds the session, apart from the head', async () => {
    const relay = scriptedRelay({ index: [] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, []);
    await until(() => relay.ops().includes('head'), 'the head');
    expect(relay.ops()).toEqual(['head']);
  });

  it('numbers its entries from the Relay\'s watermark and waits for each acknowledgement before the next message', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ watermark: 7, onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay);
    const { session } = await attachSession(publisher, []);
    await until(() => pending.length === 1, 'the first publication');
    expect(relay.written.find(message => message.type === 'journal_publish')!.entries.map((entry: Wire) => entry.sequence)).toEqual([8]);
    session.push(item('live', 'a', 'Streaming', { completes: false }));
    await settle(40);
    expect(relay.written.filter(message => message.type === 'journal_publish')).toHaveLength(1);
    pending.shift()!();
    await until(() => pending.length === 1, 'the next publication after the acknowledgement');
    expect(relay.written.filter(message => message.type === 'journal_publish').at(-1)!.entries.map((entry: Wire) => [entry.sequence, entry.op])).toEqual([[9, 'append']]);
  });

  it('pulls the rest of a paged index with the epoch it was opened in, one page at a time', async () => {
    const relay = scriptedRelay({ index: [entry('a', 1, { liveOnly: true }), entry('b', 2, { liveOnly: true })], pages: [[entry('c', 3, { liveOnly: true })], [entry('d', 4, { liveOnly: true })]] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, []);
    await until(() => relay.ops().includes('head'), 'the head');
    const requests = relay.written.filter(message => message.type === 'journal_index_request');
    expect(requests.map(message => [message.generation, message.epoch, message.after])).toEqual([[1, 'epoch-1', 2], [1, 'epoch-1', 3]]);
  });

  it('opens again when a page of the index is refused as belonging to an older epoch', async () => {
    const relay = scriptedRelay({ index: [entry('a', 1, { liveOnly: true })], pages: [[entry('b', 2, { liveOnly: true })]], staleFirstPage: true });
    const publisher = publisherFor(relay);
    await attachSession(publisher, []);
    await until(() => relay.ops().includes('head'), 'the head after a second open');
    expect(relay.opens()).toBe(2);
  });

  it('stops publishing a session whose journal the Relay refuses to open, and says why', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = createJournalPublisher({ providers: () => ['fake'], limits: { responseTimeoutMs: 400 }, diagnostic: event => diagnostics.push(event) });
    closers.push(() => publisher.close());
    const writer = { send(json: string) { const message = JSON.parse(json); relay.written.push(message); if (message.type === 'journal_open') relay.send({ uplinkVersion: 2, type: 'journal_open_refused', requestId: message.requestId, sessionKey: message.sessionKey, reason: 'index_too_large' }); } };
    publisher.available(writer);
    relay.connect(publisher);
    publisher.available(writer);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => diagnostics.some(entry => entry.event === 'journal_open_refused'), 'the diagnostic');
    expect(diagnostics.find(entry => entry.event === 'journal_open_refused')).toMatchObject({ providerId: 'fake', reason: 'index_too_large' });
    await settle(60);
    const opens = relay.written.filter(message => message.type === 'journal_open');
    expect(opens.map(message => message.reset)).toEqual([undefined, true]);
    expect(diagnostics.filter(entry => entry.event === 'journal_open_refused')).toHaveLength(2);
    expect(relay.written.filter(message => message.type === 'journal_unserve')).toEqual([]);
  });

  it('gets out of an index that is too large by opening without it and replacing first, then continues normally', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ refuseOpen: (opens, reset) => opens === 1 && !reset });
    const publisher = publisherFor(relay, {}, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two')]);
    await until(() => relay.opens() === 3 && relay.ops().includes('head'), 'the open after the replacement');
    const opens = relay.written.filter(message => message.type === 'journal_open');
    expect(opens.map(message => message.reset)).toEqual([undefined, true, undefined]);
    const published = relay.written.filter(message => message.type === 'journal_publish');
    expect(published[0].entries.map((entry: Wire) => entry.op)).toEqual(['replace', 'head']);
    expect(relay.written.filter(message => message.type === 'journal_unserve')).toEqual([]);
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the way out');
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
  });

  it('does not publish a session of a provider that does not declare journal support', async () => {
    const relay = scriptedRelay();
    const publisher = createJournalPublisher({ providers: () => ['other'], limits: { batchWindowMs: 5 } });
    closers.push(() => publisher.close());
    relay.connect(publisher);
    const session = new ScriptedSession('fake', 'thread-1', [boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    expect(publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager })).toBe(false);
    await settle(30);
    expect(relay.written).toEqual([]);
  });
});

describe('live rows', () => {
  it('merges consecutive deltas of one item into a row, completes it with the digest of the whole item, and keeps a still-open item open', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 25 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const before = relay.written.length;
    session.push(item('live', 'a', 'Wor', { completes: false }));
    session.push(item('live', 'a', 'ld', { completes: false }));
    session.push(item('live', 'a', '!', { completes: true }));
    session.push(item('live', 'b', 'Still ', { completes: false }));
    await until(() => relay.written.slice(before).some(message => message.type === 'journal_publish'), 'the live publication');
    const entries = relay.written.slice(before).filter(message => message.type === 'journal_publish').flatMap(message => message.entries) as Wire[];
    expect(entries.map(entry => entry.op)).toEqual(['append', 'complete', 'append']);
    expect(entries[0].row).toMatchObject({ itemKey: 'a', item: { text: 'World!' } });
    expect(entries[1]).toMatchObject({ itemKey: 'a', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(entries[2]).toMatchObject({ row: { itemKey: 'b', item: { text: 'Still ' } } });
  });

  it('publishes a head that carries a new pending interaction at once, not after the batch window', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5000 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const before = relay.written.length;
    session.push({ type: 'observation', sourceKey: 'ask-1', occurredAt: 1, delivery: 'live', event: { type: 'interaction_requested', provider: 'fake', request: { kind: 'question', requestId: 'question-1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single', options: [{ value: 'a', label: 'A' }], allowCustomText: false, allowDismiss: false }] } } });
    await until(() => relay.written.slice(before).some(message => message.type === 'journal_publish'), 'an urgent head', 1500);
    const head = relay.written.slice(before).flatMap(message => message.entries ?? []).find((value: Wire) => value.op === 'head') as Wire;
    expect(head.head.snapshot.pendingInteractions.map((request: Wire) => request.requestId)).toEqual(['question-1']);
  });

  it('publishes a background outcome in order with the rows, and leaves the other runtime events to the head', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 25 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const before = relay.written.length;
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    session.push(item('live', 'a', 'Done', { completes: true }));
    session.push({ type: 'observation', sourceKey: 'bg-1', occurredAt: 6, delivery: 'live', event: { type: 'background_activity_updated', provider: 'fake', turnId: 'turn-9', background: { id: 'review-1', kind: 'review', status: 'visible' } } });
    await until(() => relay.ops().filter(op => op === 'outcome').length === 1, 'the outcome');
    const ops = relay.written.slice(before).filter(message => message.type === 'journal_publish').flatMap(message => message.entries.map((value: Wire) => value.op));
    expect(ops.filter(op => op !== 'head').slice(0, 3)).toEqual(['append', 'complete', 'outcome']);
    expect(ops).not.toContain('event');
    const head = relay.written.slice(before).flatMap(message => message.entries ?? []).filter((value: Wire) => value.op === 'head').at(-1) as Wire;
    expect(head.head.snapshot.activeTurn).toMatchObject({ turnId: 'turn-9' });
  });

  it('drops a row the wire refuses, tells the diagnostics, and keeps publishing the rest', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    session.push(item('live', 'bad', 'x', { turnId: 't'.repeat(600) }));
    session.push(item('live', 'good', 'Fine', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'the rest');
    expect(diagnostics).toContainEqual({ event: 'journal_row_rejected', providerId: 'fake' });
    const appended = relay.written.flatMap(message => message.entries ?? []).filter((value: Wire) => value.op === 'append').map((value: Wire) => value.row.itemKey);
    expect(appended).toEqual(['good']);
  });
});

describe('recovering', () => {
  it('opens again and reconciles from the manager after the Relay refuses a publication', async () => {
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (!refused && message.entries.some((entry: Wire) => entry.op === 'append')) { refused = true; answer.refuse('stale_revision', 'a'); return; }
      answer.ack();
    } });
    const publisher = publisherFor(relay);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    await settle(30);
    const opens = relay.opens();
    session.push(item('live', 'a', 'Hi', { completes: true }));
    await until(() => relay.opens() === opens + 1, 'the open after the refusal');
    await settle(40);
    expect(relay.opens()).toBe(opens + 1);
  });

  it('opens again when the Relay does not acknowledge in time', async () => {
    let silent = true;
    const relay = scriptedRelay({ onPublish: (_message, answer) => { if (silent) { silent = false; answer.ignore(); } else answer.ack(); } });
    const publisher = publisherFor(relay, { responseTimeoutMs: 60 });
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.types().filter(type => type === 'journal_open').length >= 2, 'a second open', 2000);
  });

  it('replaces with narrower windows after a quota refusal, and stops with a diagnostic when the narrowest is refused', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (message.entries.some((entry: Wire) => entry.op === 'replace')) answer.refuse('quota_exceeded'); else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [3, 2, 1] }, diagnostics);
    await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to stop', 3000);
    const windows = relay.written.filter(message => message.type === 'journal_publish').map(message => message.entries[0].items.length);
    expect(windows).toEqual([5, 3, 2, 1]);
    expect(diagnostics.find(entry => entry.event === 'journal_session_stopped')).toMatchObject({ providerId: 'fake', reason: 'quota_exceeded' });
    await settle(60);
    expect(relay.written.filter(message => message.type === 'journal_publish')).toHaveLength(4);
    const unserve = relay.written.filter(message => message.type === 'journal_unserve');
    expect(unserve).toEqual([{ uplinkVersion: 2, type: 'journal_unserve', sessionKey: 'fake:thread-1', generation: 4 }]);
  });

  it('answers an incomplete journal with a replacement of the same window, then the head, without narrowing', async () => {
    const diagnostics: Wire[] = [];
    let refusals = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (refusals === 0 && message.entries.some((entry: Wire) => entry.op === 'head')) { refusals += 1; answer.refuse('incomplete', undefined, message.entries.at(-1).sequence); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [3, 2, 1] }, diagnostics);
    const { session } = await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => relay.model().length === 5 && relay.opens() === 3 && relay.ops().filter(op => op === 'head').length >= 2, 'the replacement, its head and the open that follows');
    const replaces = relay.written.filter(message => message.type === 'journal_publish').flatMap(message => message.entries).filter((entry: Wire) => entry.op === 'replace');
    expect(replaces.map((entry: Wire) => entry.items.length)).toEqual([5, 5]);
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_quota_window');
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the head');
  });

  it('stops, and takes the session out of serving, when the Relay keeps calling the journal incomplete', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay({ onPublish: (message, answer) => answer.refuse('incomplete', undefined, message.entries.at(-1).sequence) });
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to stop', 3000);
    expect(diagnostics.find(entry => entry.event === 'journal_session_stopped')).toMatchObject({ providerId: 'fake', reason: 'incomplete' });
    expect(relay.written.filter(message => message.type === 'journal_unserve')).toHaveLength(1);
  });

  it('does not loop when the replacement a quota asked for is accepted: it reopens once, finds the window known, and goes live', async () => {
    const diagnostics: Wire[] = [];
    let refusals = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (refusals === 0 && message.entries.some((entry: Wire) => entry.op === 'replace')) { refusals += 1; answer.refuse('quota_exceeded'); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { quotaWindows: [3, 2, 1] }, diagnostics);
    const { session } = await attachSession(publisher, Array.from({ length: 5 }, (_, at) => item('history', `m${at}`, `Item ${at}`)));
    await until(() => relay.model().length === 3 && relay.ops().includes('head'), 'the window to be accepted');
    session.push(item('live', 'later', 'Still publishing', { completes: true }));
    await until(() => relay.ops().includes('complete'), 'a live item after the window');
    await settle(60);
    const replaces = relay.written.filter(message => message.type === 'journal_publish').flatMap(message => message.entries).filter((entry: Wire) => entry.op === 'replace');
    expect(replaces.map((entry: Wire) => entry.items.length)).toEqual([5, 3]);
    expect(relay.opens()).toBe(3);
    expect(diagnostics.map(entry => entry.event)).not.toContain('journal_session_stopped');
    expect(diagnostics.find(entry => entry.event === 'journal_quota_window')).toMatchObject({ reason: '3' });
  });

  it('stops publishing, unserves the session and records the breach when the provider emits an observation without identity', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, {}, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    session.push({ ...item('live', 'm2', 'No identity', { completes: true }), itemIdentity: undefined });
    await until(() => relay.written.some(message => message.type === 'journal_unserve'), 'the unserve');
    expect(relay.written.find(message => message.type === 'journal_unserve')).toMatchObject({ sessionKey: 'fake:thread-1', generation: 1 });
    expect(diagnostics).toContainEqual({ event: 'journal_session_stopped', providerId: 'fake', reason: 'identity_missing' });
    const published = relay.written.filter(message => message.type === 'journal_publish').length;
    session.push(item('live', 'm3', 'Later', { completes: true }));
    await settle(60);
    expect(relay.written.filter(message => message.type === 'journal_publish')).toHaveLength(published);
    expect(relay.opens()).toBe(1);
  });

  it('opens again when the Relay answers sequence_gap, which no per-item refusal explains', async () => {
    const diagnostics: Wire[] = [];
    let gaps = 0;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      if (gaps === 0 && message.entries.some((entry: Wire) => entry.op === 'append')) { gaps += 1; answer.refuse('sequence_gap'); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 25 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const opens = relay.opens();
    session.push(item('live', 'm2', 'Next', { completes: true }));
    await until(() => relay.opens() === opens + 1 && relay.model().some(entry => entry.itemKey === 'm2'), 'the journal to be opened again and to hold the item');
    expect(diagnostics).toContainEqual({ event: 'journal_publication_refused', providerId: 'fake', reason: 'sequence_gap' });
  });

  it('stops a session whose provider uses the key prefix reserved for the Controller', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, {}, diagnostics);
    await attachSession(publisher, [item('history', 'controller:m1', 'Hello')]);
    await until(() => diagnostics.some(entry => entry.event === 'journal_session_stopped'), 'the session to stop');
    expect(diagnostics).toContainEqual({ event: 'journal_session_stopped', providerId: 'fake', reason: 'identity_missing' });
  });

  it('leaves out an item the Relay refuses for its own sake, sends the rest again numbered from the refused entry, and does not open again', async () => {
    const diagnostics: Wire[] = [];
    let refused = false;
    const relay = scriptedRelay({ onPublish: (message, answer) => {
      const bad = message.entries.find((entry: Wire) => entry.op === 'append' && entry.row.itemKey === 'bad');
      if (!refused && bad) { refused = true; answer.refuse('body_missing', 'bad', bad.sequence); } else answer.ack();
    } });
    const publisher = publisherFor(relay, { batchWindowMs: 25 }, diagnostics);
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    await settle(40);
    const opens = relay.opens();
    session.push(item('live', 'bad', 'Never stored', { completes: true }));
    session.push(item('live', 'good', 'Stored', { completes: true }));
    await until(() => relay.model().some(entry => entry.itemKey === 'good' && entry.state === 'complete'), 'the item after the refused one');
    const publishes = relay.written.filter(message => message.type === 'journal_publish').slice(-2);
    expect(publishes.map(message => message.entries.map((entry: Wire) => [entry.sequence, entry.op, entry.row?.itemKey ?? entry.itemKey]))).toEqual([
      [[4, 'append', 'bad'], [5, 'complete', 'bad'], [6, 'append', 'good'], [7, 'complete', 'good']],
      [[4, 'append', 'good'], [5, 'complete', 'good']],
    ]);
    expect(relay.opens()).toBe(opens);
    expect(relay.model().map(entry => entry.itemKey)).not.toContain('bad');
    expect(diagnostics).toContainEqual({ event: 'journal_publication_refused', providerId: 'fake', reason: 'body_missing:item' });
  });

  /** Moves the fake clock in small steps, with real time between them for the digests, which the platform computes and no timer drives. */
  const realWait = () => new Promise<void>(resolve => realSetTimeout(resolve, 20));
  const run = async (ms: number) => { for (let spent = 0; spent < ms; spent += 10) { await realWait(); await vi.advanceTimersByTimeAsync(10); } await realWait(); };

  const failsOnce = (failed = new Set<string>()) => (message: Wire, answer: { ack(): void; refuse(reason: string, itemKey?: string, sequence?: number): void }) => {
    const live = message.entries.find((value: Wire) => value.op === 'append' && ['a', 'b'].includes(value.row.itemKey) && !failed.has(value.row.itemKey));
    if (live) { failed.add(live.row.itemKey); answer.refuse('stale_revision', live.row.itemKey, live.sequence); } else answer.ack();
  };

  /** How long the publisher waited to open again after each of its two failures. */
  async function waitsAfterTwoFailures(secondPushAfterMs: number, sustainedMs: number): Promise<[number, number]> {
    const relay = scriptedRelay({ onPublish: failsOnce() });
    const publisher = publisherFor(relay, { batchWindowMs: 1, backoffBaseMs: 100, backoffMaxMs: 10_000, sustainedMs, responseTimeoutMs: 60_000 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await run(100);
    session.push(item('live', 'a', 'One', { completes: true }));
    await run(secondPushAfterMs);
    session.push(item('live', 'b', 'Two', { completes: true }));
    await run(600);
    const opens = relay.opensAt();
    const refused = relay.refusedAt();
    expect(refused).toHaveLength(2);
    expect(opens.length).toBeGreaterThanOrEqual(4);
    return [opens[2]! - refused[0]!, opens[3]! - refused[1]!];
  }

  it('starts the backoff over only after the session published for a sustained time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const [first, second] = await waitsAfterTwoFailures(1500, 500);
      expect(first).toBeGreaterThanOrEqual(100);
      expect(first).toBeLessThan(150);
      expect(second).toBeGreaterThanOrEqual(100);
      expect(second).toBeLessThan(150);
    } finally { vi.useRealTimers(); }
  });

  it('doubles the backoff when failures follow each other closely', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const [first, second] = await waitsAfterTwoFailures(200, 5000);
      expect(first).toBeGreaterThanOrEqual(100);
      expect(first).toBeLessThan(150);
      expect(second).toBeGreaterThanOrEqual(200);
      expect(second).toBeLessThan(250);
    } finally { vi.useRealTimers(); }
  });

  it('keeps reading a head change that arrives while the session reconciles, and publishes it once the session is live', async () => {
    const relay = scriptedRelay({ holdOpened: true, index: [entry('zz', 1, { liveOnly: true })] });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === 1, 'the open');
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    await settle(30);
    relay.releaseOpens();
    await until(() => relay.ops().filter(op => op === 'head').length >= 2, 'a head after going live');
    expect(relay.opens()).toBe(1);
    const heads = relay.written.flatMap(message => message.entries ?? []).filter((value: Wire) => value.op === 'head') as Wire[];
    expect(heads.at(-1)!.head.snapshot.activeTurn).toMatchObject({ turnId: 'turn-9' });
  });

  it('does not make a session wait for the others to finish publishing before it opens', async () => {
    const pending: Array<() => void> = [];
    const relay = scriptedRelay({ onPublish: (_message, answer) => { pending.push(answer.ack); } });
    const publisher = publisherFor(relay, { concurrentOpens: 1 });
    await attachSession(publisher, [item('history', 'a1', 'First')], undefined, { agentId: 'agent-1', nativeSessionId: 'thread-1' });
    await until(() => pending.length === 1, 'the first session to wait for its acknowledgement');
    await attachSession(publisher, [item('history', 'b1', 'Second')], undefined, { agentId: 'agent-2', nativeSessionId: 'thread-2' });
    await until(() => relay.opens() === 2, 'the second session to open while the first waits');
    expect(pending).toHaveLength(2);
  });

  it('closes a gap without publishing twice the rows that arrive while it reads older history', async () => {
    const relay = scriptedRelay({ index: [entry('m1', 1)] });
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm3', 'Three'), boundary('older-1')], [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let injected = false;
    const source: JournalSource = {
      subscribeJournal: tap => manager.subscribeJournal(tap), timelineRows: () => manager.timelineRows(), itemRows: key => manager.itemRows(key),
      attentionItemKey: () => manager.attentionItemKey(), snapshot: () => manager.snapshot(), hasOlderHistory: () => manager.hasOlderHistory(),
      async loadOlderHistory() {
        const loaded = await manager.loadOlderHistory();
        if (!injected) { injected = true; session.push(item('live', 'x', 'Live during the gap', { completes: true })); await settle(20); }
        return loaded;
      },
    };
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    await until(() => relay.model().some(entry => entry.itemKey === 'x' && entry.state === 'complete'), 'the live item');
    await settle(40);
    const appended = relay.written.flatMap(message => message.entries ?? []).filter((value: Wire) => value.op === 'append' && value.row.itemKey === 'x');
    expect(appended).toHaveLength(1);
    expect(appended[0].row.item.text).toBe('Live during the gap');
  });

  it('starts over when the connection returns, from the manager\'s timeline and the Relay\'s watermark', async () => {
    const relay = scriptedRelay({ index: [] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    publisher.available(undefined);
    const opens = relay.types().filter(type => type === 'journal_open').length;
    await settle(30);
    expect(relay.types().filter(type => type === 'journal_open')).toHaveLength(opens);
    relay.connect(publisher);
    await until(() => relay.types().filter(type => type === 'journal_open').length === opens + 1, 'the open after the connection returned');
  });
});

describe('giving up on a session, and following another source of it', () => {
  const unserves = (relay: ReturnType<typeof scriptedRelay>) => relay.written.filter(message => message.type === 'journal_unserve');

  it('stops, tells the Relay to stop serving the journal and says why when the Snapshot cannot be published', async () => {
    const diagnostics: Wire[] = [];
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 }, diagnostics);
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm1', 'Hello'), boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    let broken = false;
    const source: JournalSource = {
      subscribeJournal: tap => manager.subscribeJournal(tap), timelineRows: () => manager.timelineRows(), itemRows: key => manager.itemRows(key),
      attentionItemKey: () => manager.attentionItemKey(), loadOlderHistory: () => manager.loadOlderHistory(), hasOlderHistory: () => manager.hasOlderHistory(),
      snapshot: () => { const snapshot = manager.snapshot(); if (broken) snapshot.payload.id = ''; return snapshot; },
    };
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    await until(() => relay.ops().includes('head'), 'the first head');
    broken = true;
    session.push({ type: 'observation', sourceKey: 'turn-1', occurredAt: 5, delivery: 'live', event: { type: 'turn_started', provider: 'fake', turnId: 'turn-9' } });
    await until(() => unserves(relay).length === 1, 'the unserve');
    expect(diagnostics).toContainEqual({ event: 'journal_session_stopped', providerId: 'fake', reason: 'head_rejected' });
    expect(unserves(relay)[0]).toMatchObject({ generation: expect.any(Number) });
  });

  it('follows a manager that replaces the one it followed, and ignores the old one', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const first = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const opens = relay.opens();
    const second = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.opens() === opens + 1, 'the open of the new source');
    await until(() => relay.types().at(-1) === 'journal_publish', 'the head of the new source');
    first.session.push(item('live', 'old', 'From the manager that closed', { completes: true }));
    second.session.push(item('live', 'new', 'From the woken manager', { completes: true }));
    await until(() => relay.model().some(entry => entry.itemKey === 'new' && entry.state === 'complete'), 'the new source\'s item');
    expect(relay.model().map(entry => entry.itemKey)).not.toContain('old');
  });

  it('keeps following the same manager when it is attached again', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    const { manager } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const opens = relay.opens();
    expect(publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager })).toBe(true);
    await settle(40);
    expect(relay.opens()).toBe(opens);
  });

  it('does not follow a manager that is already closed, and tells it nothing', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay);
    const session = new ScriptedSession('fake', 'thread-1', [boundary()]);
    const manager = await attachScripted(session);
    await manager.close();
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
    await settle(50);
    expect(relay.ops()).toEqual([]);
    const live = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'a live manager of the same session');
    void live;
  });

  it('refuses at once a fill or an older-history request for a session it does not follow, or cannot answer yet', async () => {
    const relay = scriptedRelay({ holdOpened: true });
    const publisher = publisherFor(relay);
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:unknown', itemKeys: ['m1'] });
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:unknown', limit: 10 });
    await until(() => relay.written.filter(message => message.type === 'journal_request_refused').length === 2, 'the refusals');
    expect(relay.written.filter(message => message.type === 'journal_request_refused')).toEqual([
      { uplinkVersion: 2, type: 'journal_request_refused', requestId: 'fill-1', sessionKey: 'fake:unknown', reason: 'not_followed' },
      { uplinkVersion: 2, type: 'journal_request_refused', requestId: 'older-1', sessionKey: 'fake:unknown', reason: 'not_followed' },
    ]);
    void publisher;
  });
});

describe('older history and fills the Relay asks for', () => {
  it('publishes the manager\'s older items as a prepend, and reads further native history when it has none left', async () => {
    const relay = scriptedRelay({ index: [entry('m3', 1), entry('m4', 2)] });
    const publisher = publisherFor(relay);
    const { manager } = await attachSession(publisher, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], [
      { observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')], nextCursor: 'older-2' },
      { observations: [item('history', 'm0', 'Zero')], nextCursor: 'older-3' },
    ]);
    await until(() => relay.ops().includes('head'), 'the first head');
    const before = relay.written.length;
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', limit: 3 });
    await until(() => relay.written.slice(before).some(message => message.type === 'journal_older_done'), 'the answer');
    const written = relay.written.slice(before);
    const prepend = written.find(message => message.type === 'journal_publish')!.entries[0];
    expect(prepend.op).toBe('prepend');
    expect(prepend.items.map((value: Wire) => value.row.itemKey)).toEqual(['m0', 'm1', 'm2']);
    expect(written.find(message => message.type === 'journal_older_done')).toMatchObject({ requestId: 'older-1', olderAvailable: true });
    expect(manager.hasOlderHistory()).toBe(true);
  });

  it('says that no older history is left once native history is read to its start', async () => {
    const relay = scriptedRelay({ index: [entry('m2', 1)] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm2', 'Two')], [{ observations: [item('history', 'm1', 'One')] }]);
    await until(() => relay.ops().includes('head'), 'the first head');
    relay.send({ uplinkVersion: 2, type: 'journal_older_request', requestId: 'older-1', sessionKey: 'fake:thread-1', limit: 10 });
    await until(() => relay.written.some(message => message.type === 'journal_older_done'), 'the answer');
    expect(relay.written.find(message => message.type === 'journal_older_done')).toMatchObject({ olderAvailable: false });
  });

  it('answers a fill request with the bodies it still has, complete and with their digests', async () => {
    const relay = scriptedRelay({ index: [entry('m1', 1)] });
    const publisher = publisherFor(relay);
    await attachSession(publisher, [item('history', 'm1', 'One'), item('history', 'm2', 'Two')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    relay.send({ uplinkVersion: 2, type: 'journal_fill_request', requestId: 'fill-1', sessionKey: 'fake:thread-1', itemKeys: ['m1', 'missing'] });
    await until(() => relay.written.some(message => message.type === 'journal_fill'), 'the fill');
    const fill = relay.written.find(message => message.type === 'journal_fill')!;
    expect(fill).toMatchObject({ requestId: 'fill-1', sessionKey: 'fake:thread-1' });
    expect(fill.items.map((value: Wire) => [value.row.itemKey, value.row.item.text, typeof value.digest])).toEqual([['m1', 'One', 'string']]);
  });
});

describe('releasing a session', () => {
  it('publishes what is queued before it stops following', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5000 });
    const { session } = await attachSession(publisher, [item('history', 'm1', 'Hello')]);
    await until(() => relay.ops().includes('head'), 'the first head');
    session.push(item('live', 'a', 'Last words', { completes: true }));
    await settle(30);
    await publisher.release('agent-1');
    expect(relay.ops()).toContain('complete');
    const opens = relay.opens();
    session.push(item('live', 'b', 'After release', { completes: true }));
    await settle(40);
    expect(relay.ops().filter(op => op === 'append')).toHaveLength(1);
    expect(relay.opens()).toBe(opens);
  });
});
```

- [ ] **Step 3: Write the failing tests against the Relay's real journal logic.** Create `packages/agent-host/src/journal-publisher.relay.test.ts`. They prove the Controller's side and the Relay's side agree:

<!-- write: packages/agent-host/src/journal-publisher.relay.test.ts -->
```ts
import { itemDigest, SessionJournal } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { mergedRow, groupItems } from './journal-items.js';
import { createJournalPublisher, type JournalPublisher } from './journal-publisher.js';
import { relayLoopback } from './test-utils/journal-relay-loopback.js';
import { attachScripted, boundary, item, ScriptedSession, settle, until } from './test-utils/journal-scripted-session.js';

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const SESSION = 'fake:thread-1';
const limits = { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 1000 };

function start(relay: ReturnType<typeof relayLoopback>, publisherId?: string): JournalPublisher {
  const publisher = createJournalPublisher({ providers: () => ['fake'], limits, ...(publisherId ? { publisherId } : {}) });
  closers.push(() => publisher.close());
  relay.connect(publisher);
  return publisher;
}

async function follow(publisher: JournalPublisher, history: ReturnType<typeof item>[], older?: Array<{ observations: ReturnType<typeof item>[]; nextCursor?: string }>) {
  const session = new ScriptedSession('fake', 'thread-1', [...history, boundary(older ? 'older-1' : undefined)], older);
  const manager = await attachScripted(session);
  closers.push(() => { void manager.close(); });
  publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
  return { session, manager };
}

const texts = async (relay: ReturnType<typeof relayLoopback>) => {
  const journal = await relay.journal(SESSION);
  const page = journal?.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 500 }, { olderBeyondJournal: false });
  return page?.kind === 'page' ? page.page.payload.entries.map(entry => 'text' in entry.item ? entry.item.text : '') : undefined;
};

describe('the publisher against the Relay\'s journal service', () => {
  it('builds the journal of a session from its history, with digests, a head and its epoch', async () => {
    const relay = relayLoopback();
    const publisher = start(relay);
    await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    const journal = (await relay.journal(SESSION))!;
    expect(await texts(relay)).toEqual(['Hello', 'World']);
    expect(journal.index().map(entry => [entry.itemKey, entry.state, typeof entry.digest])).toEqual([['m1', 'complete', 'string'], ['m2', 'complete', 'string']]);
    expect(journal.head?.snapshot.id).toBe('agent-1');
  });

  it('keeps the epoch and every row across a Controller restart, and publishes nothing for an unchanged session (T6)', async () => {
    const relay = relayLoopback();
    const first = start(relay, 'controller-before');
    const run = await follow(first, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    run.session.push(item('live', 'a', 'Wor', { completes: false }));
    run.session.push(item('live', 'a', 'ld', { completes: true }));
    await until(async () => (await texts(relay))?.length === 3, 'the live item');
    const before = await relay.journal(SESSION);
    first.close();
    relay.disconnect();
    await run.manager.close();

    const restarted = relayLoopback();
    await restarted.store.apply(before!.takeChanges() ?? { meta: before!.state().meta, upsert: before!.state().items, removed: [], replaced: true, bytes: 0 });
    const second = start(restarted, 'controller-after');
    const reopened = await follow(second, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), item('history', 'a', 'World')]);
    await until(async () => ((await restarted.journal(SESSION))?.publisher?.publisherId) === 'controller-after' && (await restarted.journal(SESSION))?.head !== undefined, 'the reconcile');
    await settle(50);
    const after = (await restarted.journal(SESSION))!;
    expect(after.epoch).toBe(before!.epoch);
    expect(after.index().map(entry => [entry.itemKey, entry.seqStart])).toEqual(before!.index().map(entry => [entry.itemKey, entry.seqStart]));
    expect(restarted.published.flatMap(({ result }) => result.events.filter(event => event.kind === 'row' || event.kind === 'replaced'))).toEqual([]);
    expect(await texts(restarted)).toEqual(['Hello', 'World', 'World']);
    await reopened.manager.close();
  });

  it('corrects an item whose native content changed without starting a new epoch', async () => {
    const relay = relayLoopback();
    const first = start(relay);
    const run = await follow(first, [item('history', 'm1', 'Hello'), item('history', 'm2', 'Wor')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    const epoch = (await relay.journal(SESSION))!.epoch;
    first.close();
    relay.disconnect();
    await run.manager.close();
    const next = relayLoopback();
    const old = (await relay.journal(SESSION))!;
    await next.store.apply({ meta: old.state().meta, upsert: old.state().items, removed: [], replaced: true, bytes: 0 });
    const second = start(next, 'controller-2');
    await follow(second, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World, complete')]);
    await until(async () => (await texts(next))?.[1] === 'World, complete', 'the correction');
    expect((await next.journal(SESSION))!.epoch).toBe(epoch);
  });

  it('starts a new epoch only when native history was rewritten, carrying its live-only items over', async () => {
    const relay = relayLoopback();
    const first = start(relay);
    const run = await follow(first, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), item('history', 'm3', 'Again')]);
    run.session.push(item('live', 'question', 'Which one?', { completes: true, liveOnly: true }));
    await until(async () => (await texts(relay))?.length === 4, 'the live-only item');
    const epoch = (await relay.journal(SESSION))!.epoch;
    first.close();
    relay.disconnect();
    await run.manager.close();
    const next = relayLoopback();
    const old = (await relay.journal(SESSION))!;
    await next.store.apply({ meta: old.state().meta, upsert: old.state().items, removed: [], replaced: true, bytes: 0 });
    const second = start(next, 'controller-2');
    await follow(second, [item('history', 'm1', 'Hello'), item('history', 'm3', 'Again')]);
    await until(async () => (await next.journal(SESSION))!.epoch !== epoch, 'the replacement');
    await until(async () => (await texts(next))?.length === 3, 'the new epoch');
    expect(await texts(next)).toEqual(['Hello', 'Again', 'Which one?']);
  });

  it('answers the Relay\'s request for older history with a prepend, and for evicted bodies with a fill', async () => {
    const relay = relayLoopback();
    const publisher = start(relay);
    await follow(publisher, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')], [{ observations: [item('history', 'm1', 'One'), item('history', 'm2', 'Two')] }]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    expect(await relay.connection.requestOlder(SESSION, 10)).toEqual({ olderAvailable: false });
    expect(await texts(relay)).toEqual(['One', 'Two', 'Three', 'Four']);
    const journal = (await relay.journal(SESSION))!;
    expect(journal.index().map(entry => entry.seqStart)).toEqual([-1, 0, 1, 2]);
    const digest = journal.index()[0]!.digest;
    expect(digest).toBe(await itemDigest(mergedRow(groupItems([{ epoch: 'e', seq: 1, providerId: 'fake', sourceKey: 's', occurredAt: 1, timestamp: new Date(1).toISOString(), turnId: 'turn-1', item: { type: 'assistant_message', text: 'One', messageId: 'm1' }, resources: [], identity: { key: 'm1', completes: true } }])[0]!).item));
    expect(await relay.connection.requestFill(SESSION, ['m3', 'm4'])).toMatchObject({ filled: ['m3', 'm4'] });
  });

  it('publishes the head before older history, which follows as a prepend', async () => {
    const relay = relayLoopback();
    const first = start(relay, 'controller-before');
    const run = await follow(first, [item('history', 'm3', 'Three'), item('history', 'm4', 'Four')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(40);
    const before = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await run.manager.close();
    const next = relayLoopback();
    await next.store.apply({ meta: before.state().meta, upsert: before.state().items, removed: [], replaced: true, bytes: 0 });
    const second = start(next, 'controller-after');
    await follow(second, [item('history', 'm1', 'One'), item('history', 'm2', 'Two'), item('history', 'm3', 'Three'), item('history', 'm4', 'Four')]);
    await until(async () => (await texts(next))?.length === 4, 'the older items');
    const sequence = next.fromPublisher.filter(message => message.type === 'journal_publish').map(message => message.entries.map((entry: { op: string }) => entry.op));
    expect(sequence.slice(0, 2)).toEqual([['head'], ['prepend']]);
    expect(await texts(next)).toEqual(['One', 'Two', 'Three', 'Four']);
    expect((await next.journal(SESSION))!.epoch).toBe(before.epoch);
  });

  it('keeps the id of an image across a Controller restart, so the journal\'s row still names a resource that can be read', async () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
    const withImage = () => item('history', 'm1', 'See ![shot](shot.png)');
    const resourceOf = async (relay: ReturnType<typeof relayLoopback>) => (await relay.journal(SESSION))?.state().items[0]?.body?.resources[0];
    const relay = relayLoopback();
    const first = start(relay, 'controller-before');
    const session = new ScriptedSession('fake', 'thread-1', [withImage(), boundary()], undefined, { 'shot.png': png });
    const manager = await attachScripted(session, 'agent-1', { resourceIdKey: 'controller-secret' });
    first.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: manager });
    await until(async () => (await resourceOf(relay))?.status === 'available', 'the image to settle in the journal');
    const settled = (await resourceOf(relay))!;
    expect(settled.resourceId).toMatch(/^rid_/);
    const before = (await relay.journal(SESSION))!;
    first.close();
    relay.disconnect();
    await manager.close();

    const next = relayLoopback();
    await next.store.apply({ meta: before.state().meta, upsert: before.state().items, removed: [], replaced: true, bytes: 0 });
    const second = start(next, 'controller-after');
    const reopened = new ScriptedSession('fake', 'thread-1', [withImage(), boundary()], undefined, { 'shot.png': png });
    const again = await attachScripted(reopened, 'agent-1', { resourceIdKey: 'controller-secret' });
    second.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source: again });
    await until(async () => ((await next.journal(SESSION))?.publisher?.publisherId) === 'controller-after' && (await next.journal(SESSION))?.head !== undefined, 'the reconcile');
    await settle(100);
    expect(await resourceOf(next)).toEqual(settled);
    expect(again.timelineRows()[0]!.resources[0]).toEqual(settled);
    expect(again.readResource('r', settled.resourceId)).toBeDefined();
    expect((await again.readResource('r', settled.resourceId)).payload.state).toMatchObject({ status: 'available', mediaType: 'image/png' });
    expect(next.published.flatMap(({ result }) => result.events.filter(event => event.kind === 'row' || event.kind === 'replaced'))).toEqual([]);
    await again.close();
  });

  it('serves the attention cursor in the journal\'s epoch and sequence, as the item the Controller\'s cursor points at', async () => {
    const relay = relayLoopback();
    const publisher = start(relay);
    const { session } = await follow(publisher, [item('history', 'm1', 'Hello'), item('history', 'm2', 'World')]);
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    session.push({ type: 'observation', sourceKey: 'bg-1', occurredAt: 6, delivery: 'live', event: { type: 'background_activity_updated', provider: 'fake', background: { id: 'review-1', kind: 'review', status: 'visible' } } });
    await until(async () => (await relay.journal(SESSION))?.head?.snapshot.attention?.background !== undefined, 'a head with attention');
    const journal = (await relay.journal(SESSION))!;
    expect(journal.head?.snapshot.attention).toEqual({ cursor: { epoch: journal.epoch, seq: 2 }, background: { id: 'review-1', kind: 'review', status: 'visible' } });
  });
});
```

- [ ] **Step 4: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-publisher.test.ts src/journal-publisher.relay.test.ts --testTimeout=15000`
Expected: FAIL (`./journal-publisher.js` does not exist).

- [ ] **Step 5: Implement the publication of one session.** Create `packages/agent-host/src/journal-publication.ts`:

<!-- write: packages/agent-host/src/journal-publication.ts -->
```ts
import { randomUUID } from 'node:crypto';

import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import {
  JOURNAL_FILL_MAX_ITEMS, REMOTE_HOST_UPLINK_VERSION,
  type AgentSnapshot, type AgentSnapshotPayload, type BackgroundActivity, type CompleteItemInput, type JournalPublishEntry, type JournalRelayMessage,
  type RemoteHostUplinkMessage, type ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentJournalSubscription, AgentJournalTap, AgentManagerEvent } from '@orchardworks/agent-remote-relay';
import { rowItemKey, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

import {
  blocksOf, chunkOps, entryBytes, groupItems, isLiveOnlyRow, mergedRow, MESSAGE_BUDGET_BYTES, sizedItems, type PublishOp, type SizedOp, type TimelineItem,
} from './journal-items.js';
import { planPublication, replacementPlan, type PublicationPlan } from './journal-reconcile.js';

/** What a publication needs from the agent manager of its session. */
export interface JournalSource {
  subscribeJournal(tap: AgentJournalTap): AgentJournalSubscription;
  timelineRows(): CanonicalTimelineRow[];
  itemRows(key: string): CanonicalTimelineRow[];
  attentionItemKey(): string | undefined;
  snapshot(): AgentSnapshot;
  loadOlderHistory(): Promise<{ added: number; more: boolean }>;
  hasOlderHistory(): boolean;
}

/** What the Controller records about its publishing. It carries no content. */
export interface JournalPublisherDiagnostic {
  event: 'journal_open_refused' | 'journal_publication_refused' | 'journal_row_rejected' | 'journal_message_unencodable' | 'journal_session_restarted'
    | 'journal_replacement_published' | 'journal_quota_window' | 'journal_session_stopped' | 'journal_session_unserved';
  providerId: string;
  reason?: string;
}

export interface PublisherLimits {
  /** How long rows are collected before a publication. */
  batchWindowMs: number;
  /** How long the Relay has to answer a request before the session opens its journal again. */
  responseTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long a session must publish without restarting before its backoff starts over. */
  sustainedMs: number;
  /** The most events of the manager held while a session reconciles; past it the session reconciles again. */
  heldEventsMax: number;
  /** The most pages of older native history read to find where the journal and the timeline meet. */
  gapReadsMax: number;
  /** The newest items kept by each narrower replacement after a quota refusal, widest first. */
  quotaWindows: readonly number[];
  /** Messages and bytes in flight across every session of the connection. */
  inFlightMessages: number;
  inFlightBytes: number;
  concurrentOpens: number;
}

export const DEFAULT_PUBLISHER_LIMITS: PublisherLimits = {
  batchWindowMs: 50, responseTimeoutMs: 30_000, backoffBaseMs: 250, backoffMaxMs: 30_000, sustainedMs: 60_000, heldEventsMax: 10_000, gapReadsMax: 8,
  quotaWindows: [2000, 200, 20], inFlightMessages: 64, inFlightBytes: 16 * 1024 * 1024, concurrentOpens: 4,
};

export interface PublicationContext {
  publisherId: string;
  limits: PublisherLimits;
  now(): number;
  /** Writes one message to the Relay: `offline` when no connection holds the grant, `unencodable` when the wire refuses it. */
  send(message: RemoteHostUplinkMessage): 'sent' | 'offline' | 'unencodable';
  /** Waits for room to have one more message in flight; the returned function gives the room back. */
  reserve(bytes: number): Promise<() => void>;
  openSlot(): Promise<() => void>;
  diagnostic(entry: JournalPublisherDiagnostic): void;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

export interface SessionPublicationOptions {
  agentId: string;
  providerId: string;
  sessionKey: string;
  source: JournalSource;
  context: PublicationContext;
  /** The publication ended for good: the session closed or was stopped. */
  onFinished(): void;
}

type QueuedOp =
  | { kind: 'append'; key: string; rows: CanonicalTimelineRow[] }
  | { kind: 'complete'; key: string }
  | { kind: 'rebind'; key: string; previous: ResourceBinding; replacement: ResourceBinding }
  | { kind: 'outcome'; providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number };

interface Waiter { match(message: JournalRelayMessage): boolean; resolve(message: JournalRelayMessage): void; reject(error: Error): void; timer: unknown }

/** The Relay refused a publication at `sequence`. */
class Refused extends Error { constructor(readonly reason: string, readonly itemKey?: string, readonly sequence?: number) { super(`The Relay refused a journal publication: ${reason}.`); } }
/** The Relay could not open the journal. */
class OpenRefused extends Error { constructor(readonly reason: string) { super(`The Relay refused to open the journal: ${reason}.`); } }
/** The work was overtaken: the session opened again, stopped, or lost its connection. */
class Cancelled extends Error {}
class TimedOut extends Error {}
/** The journal moved under the publication; it opens again at once. */
class Reopen extends Error { constructor(readonly reason: string) { super(reason); } }
/** The head cannot be put on the wire, so the journal could never show the session's state. */
class HeadRejected extends Error {}

const MAX_INDEX_PAGES = 200;
const MAX_REPLACEMENTS_IN_A_ROW = 3;
const OLDER_READS_PER_REQUEST = 3;
/** The Relay has at most 32 requests open on a connection; these wait for the session to be live. */
const MAX_PENDING_REQUESTS = 32;
/** Refusals about one item: the item is left out and the rest of the publication is sent again, instead of opening the journal again. */
const ITEM_REFUSALS: ReadonlySet<string> = new Set(['unknown_item', 'body_missing', 'type_changed', 'duplicate_item', 'invalid']);
const pendingKey = (payload: AgentSnapshotPayload): string => payload.pendingInteractions.map(request => request.requestId).sort().join('\n');
const opItemKey = (op: PublishOp): string | undefined => op.op === 'append' || op.op === 'correct' ? op.row.itemKey
  : op.op === 'complete' || op.op === 'seal' || op.op === 'rebind' || op.op === 'alias' ? op.itemKey : undefined;

/**
 * Publishes one session to its journal on the Relay: opens it, reconciles it with the Controller's timeline, and then
 * publishes what the session emits, one acknowledged message at a time. Everything that can go wrong ends in opening the
 * journal again, because the agent manager's timeline is what the Controller knows to be true; what cannot be mended ends
 * in telling the Relay to stop serving the journal, which would otherwise show a session that no longer moves.
 */
export class SessionPublication {
  private phase: 'suspended' | 'opening' | 'live' | 'refused' | 'stopped' = 'suspended';
  private cycle = 0;
  private subscription: AgentJournalSubscription | undefined;
  private generation = 0;
  private sequence = 0;
  private journalKeys = new Set<string>();
  private waiter: Waiter | undefined;
  private held: AgentManagerEvent[] = [];
  /** A head change arrived while the session reconciled; the head is read when the session goes live, not kept. */
  private heldHeadDirty = false;
  private queue: QueuedOp[] = [];
  private headDirty = false;
  private urgent = false;
  private headPending = '';
  private flushTimer: unknown;
  private retryTimer: unknown;
  private flushing = false;
  private lane: Promise<void> = Promise.resolve();
  private restarts = 0;
  private liveSince: number | undefined;
  private quotaStep = 0;
  private forceReplace = false;
  /** The Relay refused to open a journal whose index is too large: opens ask for no index until a replacement is stored. */
  private resetOpen = false;
  private replaceStreak = 0;
  private incompleteStreak = 0;
  private rebuilding = false;
  /** Items the wire refused; they stay out for as long as the session is followed. */
  private readonly skipped = new Set<string>();
  /** Items a publication refused; they stay out until the journal is opened again, which reads them again. */
  private refusedItems = new Set<string>();
  /** Whether the wire accepts an item as it stands, by its last row, so reconciling measures an item once. */
  private readonly checked = new Map<string, { lastSeq: number }>();
  private readonly digests = new Map<string, { lastSeq: number; digest: string }>();
  private digestEpoch = '';
  private requests: Array<Extract<JournalRelayMessage, { type: 'journal_fill_request' | 'journal_older_request' }>> = [];
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: SessionPublicationOptions) {}

  private get context(): PublicationContext { return this.options.context; }
  private get limits(): PublisherLimits { return this.options.context.limits; }
  private get source(): JournalSource { return this.options.source; }

  /** The agent manager this publication follows. */
  get followed(): JournalSource { return this.options.source; }

  /** Whether a request of the Relay can be answered now or soon: the journal is being opened or is live. */
  get requestable(): boolean { return this.phase === 'opening' || this.phase === 'live'; }

  /** A connection holds the grant, or the session was just attached: open the journal. A connection that replaces another opens it again, because the Relay forgot what the earlier one opened. */
  resume(): void {
    this.restart(0, undefined, false);
  }

  /** The connection ended. The session opens its journal again when a connection returns. */
  suspend(): void {
    if (this.phase === 'stopped') return;
    this.cycle += 1;
    this.teardown();
    this.requests.length = 0;
    this.phase = 'suspended';
    this.signalIdle();
  }

  stop(): void {
    if (this.phase === 'stopped') return;
    this.cycle += 1;
    this.teardown();
    this.phase = 'stopped';
    this.signalIdle();
    this.options.onFinished();
  }

  /** Publishes what is queued, giving up after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.phase !== 'live') return;
    this.urgent = true;
    this.scheduleFlush();
    await new Promise<void>(resolve => {
      const timer = this.context.schedule(resolve, timeoutMs);
      const check = (): void => {
        if (this.isIdle()) { this.context.cancel(timer); resolve(); } else this.idleWaiters.push(check);
      };
      check();
    });
  }

  private isIdle(): boolean {
    return this.phase !== 'live' || (this.queue.length === 0 && !this.headDirty && !this.flushing);
  }

  private signalIdle(): void {
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  /** A message of the Relay about this session. */
  receive(message: JournalRelayMessage): void {
    if (message.type === 'journal_refused') {
      if (message.generation !== this.generation || this.phase === 'stopped') return;
      const refusal = new Refused(message.reason, message.itemKey, message.sequence);
      if (!this.rejectWaiter(refusal)) this.recover(this.cycle, refusal);
      return;
    }
    if (message.type === 'journal_fill_request' || message.type === 'journal_older_request') {
      if (this.phase === 'stopped') return;
      if (this.requests.length >= MAX_PENDING_REQUESTS) this.requests.shift();
      this.requests.push(message);
      this.serveRequests();
      return;
    }
    const waiter = this.waiter;
    if (waiter?.match(message)) {
      this.waiter = undefined;
      this.context.cancel(waiter.timer);
      waiter.resolve(message);
    }
  }

  // Cycles: open, reconcile, go live.

  private restart(delayMs: number, reason: string | undefined, counted: boolean): void {
    if (this.phase === 'stopped') return;
    const token = ++this.cycle;
    this.teardown();
    this.phase = 'opening';
    this.liveSince = undefined;
    if (counted) this.restarts += 1;
    if (reason !== undefined) this.context.diagnostic({ event: 'journal_session_restarted', providerId: this.options.providerId, reason });
    this.retryTimer = this.context.schedule(() => { this.retryTimer = undefined; this.enqueue(() => this.run(token)); }, delayMs);
  }

  /** The wait before opening again after a failure; it grows with failures that came close together and starts over after a sustained run. */
  private backoffDelay(): number {
    if (this.liveSince !== undefined && this.context.now() - this.liveSince >= this.limits.sustainedMs) this.restarts = 0;
    return Math.min(this.limits.backoffMaxMs, this.limits.backoffBaseMs * 2 ** this.restarts);
  }

  private teardown(): void {
    this.subscription?.release();
    this.subscription = undefined;
    this.rejectWaiter(new Cancelled());
    if (this.flushTimer !== undefined) this.context.cancel(this.flushTimer);
    if (this.retryTimer !== undefined) this.context.cancel(this.retryTimer);
    this.flushTimer = undefined;
    this.retryTimer = undefined;
    this.queue.length = 0;
    this.held.length = 0;
    this.heldHeadDirty = false;
    this.headDirty = false;
    this.urgent = false;
    this.rebuilding = false;
    this.refusedItems = new Set();
  }

  private enqueue(task: () => Promise<void>): void {
    this.lane = this.lane.then(task).catch(() => undefined);
  }

  private async run(token: number): Promise<void> {
    if (token !== this.cycle) return;
    const release = await this.context.openSlot();
    let freed = false;
    const free = (): void => { if (!freed) { freed = true; release(); } };
    try {
      if (token !== this.cycle) return;
      await this.reconcile(token, free);
    } catch (error) {
      this.recover(token, error);
    } finally {
      free();
    }
  }

  private check(token: number): void {
    if (token !== this.cycle) throw new Cancelled();
  }

  /** `freeSlot` gives back the place among the sessions that open at once, as soon as the item index has been read. */
  private async reconcile(token: number, freeSlot: () => void): Promise<void> {
    const subscription = this.source.subscribeJournal({ event: event => this.onEvent(token, event), closed: () => this.onClosed(token), identityMissing: () => this.onIdentityMissing(token) });
    this.subscription = subscription;
    const opened = await this.open(token);
    freeSlot();
    this.check(token);
    // Rows above this one reach the session as events; a reread that reaches them would publish them twice.
    const lastSeq = subscription.rows[subscription.rows.length - 1]?.seq ?? 0;
    let rows = subscription.rows;
    let plan = await this.plan(opened.index, rows);
    for (let reads = 0; plan.kind === 'gap' && reads < this.limits.gapReadsMax; reads += 1) {
      const loaded = await this.source.loadOlderHistory();
      this.check(token);
      if (loaded.added === 0) break;
      rows = this.source.timelineRows().filter(row => row.seq <= lastSeq);
      plan = await this.plan(opened.index, rows);
    }
    if (plan.kind === 'gap') plan = await replacementPlan(await this.items(rows), item => this.digest(item), 'gap');
    this.check(token);
    if (plan.kind !== 'gap') for (const key of plan.refused) this.skip(key);
    if (plan.kind === 'replace' && plan.reason !== 'initial') this.context.diagnostic({ event: 'journal_replacement_published', providerId: this.options.providerId, reason: plan.reason });
    // The head goes before older history, which can be long and never delays what the session shows now.
    const head = this.headOp();
    for (const chunk of chunkOps([...(plan.kind === 'gap' ? [] : plan.ops), head])) await this.publish(token, chunk);
    if (plan.kind === 'continue') for (const chunk of chunkOps(plan.older)) await this.publish(token, chunk);
    this.check(token);
    if (plan.kind === 'replace') {
      this.resetOpen = false;
      // A replacement a quota asked for is not a rewrite: the window it kept is what fits, and the next open finds it known.
      if (plan.reason === 'quota') this.forceReplace = false;
      else {
        this.replaceStreak += 1;
        if (this.replaceStreak > MAX_REPLACEMENTS_IN_A_ROW) { this.giveUp('replace_loop'); return; }
      }
      this.restart(0, undefined, false);
      return;
    }
    this.replaceStreak = 0;
    this.incompleteStreak = 0;
    this.phase = 'live';
    this.liveSince = this.context.now();
    for (const event of this.held.splice(0)) {
      if (token !== this.cycle) return;
      this.apply(event);
    }
    if (this.heldHeadDirty) {
      this.heldHeadDirty = false;
      this.headDirty = true;
      if (pendingKey(this.source.snapshot().payload) !== this.headPending) this.urgent = true;
    }
    this.scheduleFlush();
    this.serveRequests();
  }

  /** Opens the journal and reads its whole item index, a page at a time. */
  private async open(token: number): Promise<{ index: JournalIndexEntry[] }> {
    const requestId = randomUUID();
    const reply = await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_open', requestId, sessionKey: this.options.sessionKey, publisherId: this.context.publisherId, ...(this.resetOpen ? { reset: true as const } : {}) },
      message => (message.type === 'journal_opened' || message.type === 'journal_open_refused') && message.requestId === requestId);
    if (reply.type !== 'journal_opened') throw new OpenRefused(reply.type === 'journal_open_refused' ? reply.reason : 'unexpected');
    this.generation = reply.generation;
    this.sequence = reply.watermark;
    const index = [...reply.index];
    let after = reply.indexAfter;
    for (let pages = 0; after !== undefined; pages += 1) {
      if (pages >= MAX_INDEX_PAGES) throw new Refused('index_pages');
      const id = randomUUID();
      const answer = await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_index_request', requestId: id, sessionKey: this.options.sessionKey, generation: this.generation, epoch: reply.epoch, after },
        message => (message.type === 'journal_index_page' || message.type === 'journal_open_refused') && message.requestId === id);
      if (answer.type === 'journal_open_refused') {
        if (answer.reason === 'stale_epoch') throw new Reopen('stale_epoch');
        throw new OpenRefused(answer.reason);
      }
      if (answer.type !== 'journal_index_page') throw new Refused('unexpected');
      index.push(...answer.index);
      after = answer.indexAfter;
    }
    this.journalKeys = new Set(index.map(entry => entry.itemKey));
    return { index };
  }

  /**
   * The items of a reread that the wire accepts. An item it refuses is left out and recorded once, so that it cannot make
   * every reconcile look like a rewrite: left in, it would be an item the journal never has.
   */
  private async items(rows: readonly CanonicalTimelineRow[]): Promise<TimelineItem[]> {
    const kept: TimelineItem[] = [];
    for (const item of groupItems(rows)) {
      if (this.skipped.has(item.key) || this.refusedItems.has(item.key)) continue;
      const lastSeq = (item.rows[item.rows.length - 1] as CanonicalTimelineRow).seq;
      if (this.checked.get(item.key)?.lastSeq !== lastSeq) {
        const bytes = entryBytes({ op: 'prepend', items: [{ row: mergedRow(item), ...(item.complete ? { digest: await this.digest(item) } : {}) }] });
        if (bytes === undefined) { this.skip(item.key); continue; }
        this.checked.set(item.key, { lastSeq });
      }
      kept.push(item);
    }
    return kept;
  }

  private async plan(index: readonly JournalIndexEntry[], rows: readonly CanonicalTimelineRow[]): Promise<PublicationPlan> {
    const window = this.quotaStep > 0 ? this.limits.quotaWindows[this.quotaStep - 1] : undefined;
    return planPublication(index, await this.items(rows), item => this.digest(item), {
      ...(window === undefined ? {} : { window }), ...(this.forceReplace ? { forceReplace: true } : {}),
    });
  }

  private skip(key: string): void {
    if (this.skipped.has(key)) return;
    this.skipped.add(key);
    this.context.diagnostic({ event: 'journal_row_rejected', providerId: this.options.providerId });
  }

  private isSkipped(key: string): boolean {
    return this.skipped.has(key) || this.refusedItems.has(key);
  }

  /** The digest of an item's whole content, as the journal compares it; kept while the item's rows do not change. */
  private async digest(item: TimelineItem): Promise<string> {
    const last = item.rows[item.rows.length - 1] as CanonicalTimelineRow;
    if (last.epoch !== this.digestEpoch) {
      this.digests.clear();
      this.checked.clear();
      this.digestEpoch = last.epoch;
    }
    const cached = this.digests.get(item.key);
    if (cached?.lastSeq === last.seq) return cached.digest;
    const digest = await itemDigest(mergedRow(item).item);
    this.digests.set(item.key, { lastSeq: last.seq, digest });
    return digest;
  }

  // Messages and answers.

  private expect(token: number, match: (message: JournalRelayMessage) => boolean): Promise<JournalRelayMessage> {
    return new Promise((resolve, reject) => {
      if (token !== this.cycle) { reject(new Cancelled()); return; }
      const timer = this.context.schedule(() => { this.waiter = undefined; reject(new TimedOut('The Relay did not answer in time.')); }, this.limits.responseTimeoutMs);
      this.waiter = { match, resolve, reject, timer };
    });
  }

  private rejectWaiter(error: Error): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = undefined;
    this.context.cancel(waiter.timer);
    waiter.reject(error);
    return true;
  }

  private async ask(token: number, message: RemoteHostUplinkMessage, match: (message: JournalRelayMessage) => boolean): Promise<JournalRelayMessage> {
    const reply = this.expect(token, match);
    const sent = this.context.send(message);
    if (sent !== 'sent') this.rejectWaiter(sent === 'offline' ? new Cancelled() : new Refused('unencodable'));
    return reply;
  }

  /**
   * Numbers the entries after the last publication, sends them and waits until the Relay's store holds them. When the Relay
   * refuses an entry because of its item, the entries before it are stored: the item is left out and the entries after
   * it are sent again, numbered from the refused one, instead of opening the journal again.
   */
  private async publish(token: number, chunk: { ops: PublishOp[]; bytes: number }): Promise<void> {
    let ops = chunk.ops;
    while (ops.length > 0) {
      const release = await this.context.reserve(chunk.bytes);
      try {
        this.check(token);
        const first = this.sequence + 1;
        const entries = ops.map((op, at) => ({ sequence: first + at, ...op }) as JournalPublishEntry);
        const last = first + ops.length - 1;
        const generation = this.generation;
        try {
          await this.ask(token, { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_publish', sessionKey: this.options.sessionKey, generation, entries },
            message => message.type === 'journal_ack' && message.generation === generation && message.watermark >= last);
          this.sequence = last;
          this.remember(ops);
          return;
        } catch (error) {
          const applied = error instanceof Refused && error.sequence !== undefined ? error.sequence - first : -1;
          if (!(error instanceof Refused) || error.itemKey === undefined || !ITEM_REFUSALS.has(error.reason) || applied < 0 || applied >= ops.length) throw error;
          this.remember(ops.slice(0, applied));
          this.sequence = error.sequence as number - 1;
          this.refusedItems.add(error.itemKey);
          this.context.diagnostic({ event: 'journal_publication_refused', providerId: this.options.providerId, reason: `${error.reason}:item` });
          ops = ops.slice(applied + 1).filter(op => opItemKey(op) !== error.itemKey);
        }
      } finally {
        release();
      }
    }
  }

  /** Notes the items a stored publication added, for older-history requests. */
  private remember(ops: readonly PublishOp[]): void {
    for (const op of ops) {
      if (op.op === 'append') this.journalKeys.add(op.row.itemKey);
      else if (op.op === 'prepend') for (const { row } of op.items) this.journalKeys.add(row.itemKey);
    }
  }

  // Recovery.

  private recover(token: number, error: unknown): void {
    if (token !== this.cycle || error instanceof Cancelled) return;
    const providerId = this.options.providerId;
    if (error instanceof Reopen) { this.restart(0, error.reason, false); return; }
    if (error instanceof OpenRefused) {
      this.context.diagnostic({ event: 'journal_open_refused', providerId, reason: error.reason });
      if (error.reason === 'index_too_large' && !this.resetOpen) {
        // The way out of an index too large to list: open without it, and make a replacement that fits the first publication.
        this.resetOpen = true;
        this.forceReplace = true;
        this.restart(0, undefined, false);
        return;
      }
      // The Relay already took the session out of serving when it refused the open.
      this.cycle += 1;
      this.teardown();
      this.phase = 'refused';
      return;
    }
    if (error instanceof HeadRejected) { this.giveUp('head_rejected'); return; }
    if (error instanceof Refused && error.reason === 'quota_exceeded') {
      this.quotaStep += 1;
      if (this.quotaStep > this.limits.quotaWindows.length) { this.giveUp('quota_exceeded'); return; }
      this.forceReplace = true;
      this.context.diagnostic({ event: 'journal_quota_window', providerId, reason: String(this.limits.quotaWindows[this.quotaStep - 1]) });
      this.restart(0, undefined, false);
      return;
    }
    if (error instanceof Refused && error.reason === 'incomplete') {
      // The journal is missing rows (a quota refused part of an earlier publication, or it was reset): it takes a replacement, then its head.
      // Unlike a quota refusal this does not narrow the window; a Relay that keeps saying so ends the session.
      this.incompleteStreak += 1;
      if (this.incompleteStreak > MAX_REPLACEMENTS_IN_A_ROW) { this.giveUp('incomplete'); return; }
      this.forceReplace = true;
      this.context.diagnostic({ event: 'journal_publication_refused', providerId, reason: 'incomplete' });
      this.restart(0, undefined, false);
      return;
    }
    const reason = error instanceof Refused ? error.reason : error instanceof TimedOut ? 'timeout' : 'failure';
    if (error instanceof Refused) this.context.diagnostic({ event: 'journal_publication_refused', providerId, reason: error.reason });
    this.restart(this.backoffDelay(), error instanceof Refused ? undefined : reason, true);
  }

  /** Tells the Relay to stop serving this session's journal, which this Controller can no longer keep current. */
  private sendUnserve(reason: string): void {
    if (this.generation < 1) return;
    this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_unserve', sessionKey: this.options.sessionKey, generation: this.generation });
    this.context.diagnostic({ event: 'journal_session_unserved', providerId: this.options.providerId, reason });
  }

  /** The session cannot be published any more: the Relay stops serving its journal, and the session is no longer followed. */
  private giveUp(reason: string): void {
    this.context.diagnostic({ event: 'journal_session_stopped', providerId: this.options.providerId, reason });
    this.sendUnserve(reason);
    this.stop();
  }

  // Live publishing.

  private onEvent(token: number, event: AgentManagerEvent): void {
    if (token !== this.cycle) return;
    if (this.phase === 'opening') {
      if (event.type === 'agent_state') { this.heldHeadDirty = true; return; }
      if (this.held.length >= this.limits.heldEventsMax) { this.restart(0, 'held_events', true); return; }
      this.held.push(event);
      return;
    }
    if (this.phase === 'live') this.apply(event);
  }

  private onClosed(token: number): void {
    if (token === this.cycle) this.stop();
  }

  /** The provider broke the identity contract: the journal would hold keys no reread can match, so it is not kept at all. */
  private onIdentityMissing(token: number): void {
    if (token === this.cycle) this.giveUp('identity_missing');
  }

  private apply(event: AgentManagerEvent): void {
    switch (event.type) {
      case 'agent_state':
        this.headDirty = true;
        if (pendingKey(event.snapshot.payload) !== this.headPending) this.urgent = true;
        break;
      case 'agent_stream': {
        const inner = event.event;
        if (inner.type === 'timeline') {
          if (event.row && !this.rebuilding) this.pushRow(event.row);
        } else if (inner.type === 'background_activity_updated') {
          this.queue.push({ kind: 'outcome', providerId: inner.provider, ...(inner.turnId === undefined ? {} : { turnId: inner.turnId }), background: inner.background, occurredAt: Date.parse(event.timestamp) });
        }
        // The other events of the session wire change the Snapshot, and the head carries it.
        break;
      }
      case 'timeline_resource_binding_replaced':
        if (!this.rebuilding) this.queue.push({ kind: 'rebind', key: event.itemKey, previous: event.previous, replacement: event.replacement });
        break;
      case 'timeline_replacement':
        this.rebuilding = true;
        this.queue.length = 0;
        break;
      case 'timeline_rebuilt':
        this.restart(0, undefined, false);
        return;
      default:
        return;
    }
    this.scheduleFlush();
  }

  private pushRow(row: CanonicalTimelineRow): void {
    const key = rowItemKey(row);
    const last = this.queue[this.queue.length - 1];
    if (last?.kind === 'append' && last.key === key) last.rows.push(row);
    else this.queue.push({ kind: 'append', key, rows: [row] });
    if (row.identity === undefined || row.identity.completes === true) this.queue.push({ kind: 'complete', key });
  }

  private scheduleFlush(): void {
    if (this.phase !== 'live' || (this.queue.length === 0 && !this.headDirty)) return;
    if (this.flushTimer !== undefined) {
      if (!this.urgent) return;
      this.context.cancel(this.flushTimer);
    }
    const token = this.cycle;
    this.flushTimer = this.context.schedule(() => { this.flushTimer = undefined; this.enqueue(() => this.flush(token)); }, this.urgent ? 0 : this.limits.batchWindowMs);
  }

  private async flush(token: number): Promise<void> {
    this.flushing = true;
    try {
      while (token === this.cycle && this.phase === 'live' && (this.queue.length > 0 || this.headDirty)) {
        const queued = this.queue.splice(0);
        const head = this.headDirty ? this.headOp() : undefined;
        this.headDirty = false;
        this.urgent = false;
        const ops = await this.materialize(queued);
        if (head) ops.push(head);
        for (const chunk of chunkOps(ops)) await this.publish(token, chunk);
      }
    } catch (error) {
      this.recover(token, error);
    } finally {
      this.flushing = false;
      this.signalIdle();
    }
  }

  /** The Snapshot as the head, taken now, with the item its attention cursor points at. A head the wire refuses ends the session's publishing. */
  private headOp(): SizedOp {
    const snapshot = this.source.snapshot().payload;
    const attentionItemKey = this.source.attentionItemKey();
    const op: PublishOp = { op: 'head', head: { snapshot, observedAt: this.context.now(), ...(attentionItemKey === undefined ? {} : { attentionItemKey }) } };
    const bytes = entryBytes(op);
    if (bytes === undefined) {
      this.context.diagnostic({ event: 'journal_row_rejected', providerId: this.options.providerId, reason: 'head' });
      throw new HeadRejected('The Snapshot cannot be published.');
    }
    this.headPending = pendingKey(snapshot);
    return { op, bytes };
  }

  /** Turns queued changes into entries, measuring every one against the wire first. */
  private async materialize(queued: readonly QueuedOp[]): Promise<SizedOp[]> {
    const out: SizedOp[] = [];
    const add = (op: PublishOp, key?: string): void => {
      const bytes = entryBytes(op);
      if (bytes !== undefined) out.push({ op, bytes });
      else if (key !== undefined) this.skip(key);
    };
    for (const change of queued) {
      switch (change.kind) {
        case 'append':
          if (!this.isSkipped(change.key)) add({ op: 'append', row: mergedRow({ key: change.key, rows: change.rows, complete: false, liveOnly: change.rows.some(isLiveOnlyRow) }) }, change.key);
          break;
        case 'complete': {
          if (this.isSkipped(change.key)) break;
          const item = groupItems(this.source.itemRows(change.key))[0];
          if (item) add({ op: 'complete', itemKey: change.key, digest: await this.digest(item) }, change.key);
          break;
        }
        case 'rebind':
          if (!this.isSkipped(change.key)) add({ op: 'rebind', itemKey: change.key, previous: change.previous, replacement: change.replacement });
          break;
        case 'outcome':
          add({ op: 'outcome', providerId: change.providerId, ...(change.turnId === undefined ? {} : { turnId: change.turnId }), background: change.background, occurredAt: change.occurredAt });
          break;
      }
    }
    return out;
  }

  // Requests of the Relay.

  private serveRequests(): void {
    if (this.phase !== 'live') return;
    const token = this.cycle;
    for (const request of this.requests.splice(0)) {
      this.enqueue(async () => {
        try {
          if (request.type === 'journal_older_request') await this.answerOlder(token, request);
          else await this.answerFill(request);
        } catch (error) {
          this.recover(token, error);
        }
      });
    }
  }

  /** Publishes the items older than the journal's oldest, reading further native history when the timeline has none. */
  private async answerOlder(token: number, request: Extract<JournalRelayMessage, { type: 'journal_older_request' }>): Promise<void> {
    if (token !== this.cycle) return;
    const older = async (): Promise<TimelineItem[]> => {
      const items = await this.items(this.source.timelineRows());
      const first = items.findIndex(item => this.journalKeys.has(item.key));
      return first <= 0 ? [] : items.slice(0, first).filter(item => !this.journalKeys.has(item.key) && item.complete);
    };
    let candidates = await older();
    for (let reads = 0; candidates.length < request.limit && reads < OLDER_READS_PER_REQUEST && this.source.hasOlderHistory(); reads += 1) {
      const loaded = await this.source.loadOlderHistory().catch(() => ({ added: 0, more: false }));
      if (token !== this.cycle) return;
      candidates = await older();
      if (loaded.added === 0) break;
    }
    const take = candidates.slice(-request.limit);
    const { accepted, refused } = await sizedItems(take, item => this.digest(item));
    for (const key of refused) this.skip(key);
    const ops: SizedOp[] = [];
    for (const block of blocksOf(accepted).reverse()) {
      const op: PublishOp = { op: 'prepend', items: block };
      ops.push({ op, bytes: entryBytes(op) ?? MESSAGE_BUDGET_BYTES });
    }
    for (const chunk of chunkOps(ops)) await this.publish(token, chunk);
    if (token !== this.cycle) return;
    this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_older_done', requestId: request.requestId, sessionKey: this.options.sessionKey,
      olderAvailable: candidates.length > take.length || this.source.hasOlderHistory() });
  }

  /** Answers a fill with the bodies of the items it can find, in the order asked, as many as fit one message; the answer takes room in flight like a publication. */
  private async answerFill(request: Extract<JournalRelayMessage, { type: 'journal_fill_request' }>): Promise<void> {
    const wanted = new Set(request.itemKeys.slice(0, JOURNAL_FILL_MAX_ITEMS));
    const found = async (): Promise<TimelineItem[]> => (await this.items(this.source.timelineRows())).filter(item => wanted.has(item.key) && item.complete);
    let items = await found();
    for (let reads = 0; items.length < wanted.size && reads < OLDER_READS_PER_REQUEST && this.source.hasOlderHistory(); reads += 1) {
      const loaded = await this.source.loadOlderHistory().catch(() => ({ added: 0, more: false }));
      items = await found();
      if (loaded.added === 0) break;
    }
    const { accepted } = await sizedItems(items, item => this.digest(item));
    const fitting: CompleteItemInput[] = [];
    let bytes = 0;
    for (const sized of accepted) {
      if (sized.item.digest === undefined) continue;
      if (fitting.length > 0 && bytes + sized.bytes > MESSAGE_BUDGET_BYTES) break;
      fitting.push({ row: sized.item.row, digest: sized.item.digest });
      bytes += sized.bytes;
    }
    const release = await this.context.reserve(bytes);
    try {
      this.context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_fill', requestId: request.requestId, sessionKey: this.options.sessionKey, items: fitting });
    } finally {
      release();
    }
  }
}
```

- [ ] **Step 6: Implement the connection.** Create `packages/agent-host/src/journal-publisher.ts`:

<!-- write: packages/agent-host/src/journal-publisher.ts -->
```ts
import { randomUUID } from 'node:crypto';

import { encodeRemoteHostUplinkMessage, REMOTE_HOST_UPLINK_VERSION, type JournalRelayMessage } from '@orchardworks/agent-remote-protocol';

import {
  DEFAULT_PUBLISHER_LIMITS, SessionPublication, type JournalPublisherDiagnostic, type JournalSource, type PublicationContext, type PublisherLimits,
} from './journal-publication.js';

export type { JournalPublisherDiagnostic, JournalSource, PublisherLimits } from './journal-publication.js';

/** The connection's way to write journal messages, held while the Relay's grant holds. */
export interface JournalWriter { send(json: string): void }

export interface JournalPublisherOptions {
  /** The providers whose adapters declare journal support. Sessions of any other provider are not published. */
  providers(): Iterable<string>;
  /** Names this Controller process to the Relay. A restart is a different publisher, and a reconnect is the same one. */
  publisherId?: string;
  limits?: Partial<PublisherLimits>;
  now?(): number;
  diagnostic?(entry: JournalPublisherDiagnostic): void;
}

export interface PublishedSession {
  agentId: string;
  providerId: string;
  nativeSessionId: string;
  source: JournalSource;
}

export interface JournalPublisher {
  /** Whether any provider can publish, which decides whether this Controller asks the Relay for journals. */
  capable(): boolean;
  /** The connection holds the Relay's grant (a writer) or does not: sessions open their journals, or wait. */
  available(writer: JournalWriter | undefined): void;
  /** A journal message of the Relay. */
  receive(message: JournalRelayMessage): void;
  /** Starts publishing a session; false for a provider that does not declare journal support. */
  attach(session: PublishedSession): boolean;
  /** Publishes what the session still holds, then stops following it. */
  release(agentId: string): Promise<void>;
  /** Waits until every session has published what it holds, for at most `timeoutMs` each. */
  drain(timeoutMs: number): Promise<void>;
  close(): void;
}

/** A pool of room: how many messages and bytes may be in flight, handed out in the order they were asked for. */
function createRoom(maxMessages: number, maxBytes: number) {
  let messages = 0;
  let bytes = 0;
  const waiting: Array<{ needed: number; grant(): void }> = [];
  const pump = (): void => {
    while (waiting.length > 0) {
      const next = waiting[0]!;
      if (messages >= maxMessages || (messages > 0 && bytes + next.needed > maxBytes)) return;
      waiting.shift();
      messages += 1;
      bytes += next.needed;
      next.grant();
    }
  };
  return {
    reserve(needed: number): Promise<() => void> {
      return new Promise(resolve => {
        waiting.push({ needed, grant: () => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            messages -= 1;
            bytes -= needed;
            pump();
          });
        } });
        pump();
      });
    },
  };
}

export function createJournalPublisher(options: JournalPublisherOptions): JournalPublisher {
  const limits: PublisherLimits = { ...DEFAULT_PUBLISHER_LIMITS, ...options.limits };
  const publisherId = options.publisherId ?? randomUUID();
  const room = createRoom(limits.inFlightMessages, limits.inFlightBytes);
  const opens = createRoom(limits.concurrentOpens, Number.POSITIVE_INFINITY);
  const sessions = new Map<string, SessionPublication>();
  const byKey = new Map<string, SessionPublication>();
  let writer: JournalWriter | undefined;
  let closed = false;

  const context: PublicationContext = {
    publisherId, limits, now: options.now ?? Date.now,
    send(message) {
      const connection = writer;
      if (!connection) return 'offline';
      const encoded = encodeRemoteHostUplinkMessage(message);
      if (encoded.status !== 'ok') {
        context.diagnostic({ event: 'journal_message_unencodable', providerId: 'unknown' });
        return 'unencodable';
      }
      connection.send(encoded.json);
      return 'sent';
    },
    reserve: bytes => room.reserve(bytes),
    openSlot: () => opens.reserve(0),
    diagnostic(entry) {
      try { options.diagnostic?.(entry); } catch { /* A diagnostic sink cannot stop publishing. */ }
    },
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    cancel(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  };

  return {
    capable() {
      for (const _ of options.providers()) return true;
      return false;
    },

    available(next) {
      writer = next;
      for (const session of sessions.values()) {
        if (next) session.resume();
        else session.suspend();
      }
    },

    receive(message) {
      const publication = byKey.get(message.sessionKey);
      if ((message.type === 'journal_fill_request' || message.type === 'journal_older_request') && !publication?.requestable) {
        // The Relay waits for an answer to a request; a session this Controller does not follow gets its refusal at once.
        context.send({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_request_refused', requestId: message.requestId, sessionKey: message.sessionKey,
          reason: publication ? 'not_ready' : 'not_followed' });
        return;
      }
      publication?.receive(message);
    },

    attach(session) {
      if (closed || ![...options.providers()].includes(session.providerId)) return false;
      const sessionKey = `${session.providerId}:${session.nativeSessionId}`;
      // A manager woken after a handoff or a release of the native CLI is a new source for the same session: follow it, not the one that closed.
      for (const earlier of [sessions.get(session.agentId), byKey.get(sessionKey)]) {
        if (earlier?.followed === session.source) return true;
        earlier?.stop();
      }
      const publication: SessionPublication = new SessionPublication({
        agentId: session.agentId, providerId: session.providerId, sessionKey, source: session.source, context,
        onFinished: () => {
          if (sessions.get(session.agentId) === publication) sessions.delete(session.agentId);
          if (byKey.get(sessionKey) === publication) byKey.delete(sessionKey);
        },
      });
      sessions.set(session.agentId, publication);
      byKey.set(sessionKey, publication);
      if (writer) publication.resume();
      return true;
    },

    async release(agentId) {
      const publication = sessions.get(agentId);
      if (!publication) return;
      await publication.drain(5000);
      publication.stop();
    },

    async drain(timeoutMs) {
      await Promise.all([...sessions.values()].map(session => session.drain(timeoutMs)));
    },

    close() {
      closed = true;
      for (const session of [...sessions.values()]) session.stop();
    },
  };
}
```

- [ ] **Step 7: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-publisher.test.ts src/journal-publisher.relay.test.ts --testTimeout=15000` then `pnpm --filter @orchardworks/agent-remote-controller run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add packages/agent-host/src/journal-publication.ts packages/agent-host/src/journal-publisher.ts packages/agent-host/src/journal-publisher.test.ts packages/agent-host/src/journal-publisher.relay.test.ts packages/agent-host/src/test-utils/journal-scripted-session.ts packages/agent-host/src/test-utils/journal-relay-loopback.ts
git commit -m "feat(host): publish a session to its journal: open, reconcile, live batches, recovery, older history and fills" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 10: The Controller publishes its sessions, and advertises diagnostic delivery 4

The runtime owns one publisher. A session of a journal-capable provider is attached when the Host projects it, and released before an idle session is closed. The uplink asks for the grant only when some provider is capable, so a Controller whose providers declare nothing sends exactly what it sends today.

**Files:**
- Modify: `packages/agent-host/src/host.ts`
- Modify: `packages/agent-host/src/cli.ts`
- Modify: `packages/agent-host/src/host.test.ts`
- Modify: `packages/agent-host/src/relay-diagnostics.test.ts`
- Modify: `packages/agent-remote-protocol/README.md`
- Create: `packages/agent-host/src/host-journal.test.ts`

- [ ] **Step 1: Write the failing tests.** The Controller runs its real uplink against the real hosted Relay and its journal service over a WebSocket. Create `packages/agent-host/src/host-journal.test.ts`:

<!-- write: packages/agent-host/src/host-journal.test.ts -->
```ts
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { AgentProviderAdapter } from '@orchardworks/agent-provider-sdk';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { createHostBroker, type RelaySocket } from '../../agent-remote-hosted/src/index.js';
import { createAgentHost, type AgentHostDirectory } from './host.js';
import type { JournalPublisherDiagnostic } from './journal-publisher.js';
import { boundary, item, ScriptedSession, until } from './test-utils/journal-scripted-session.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const SESSION = 'fake:thread-1';
const history = () => [item('history', 'm1', 'Hello'), item('history', 'm2', 'World'), boundary()];

async function start(options: { capable: boolean; idleGraceMs?: number; diagnostics?: unknown[] }) {
  const store = new MemoryJournalStore();
  const broker = createHostBroker({ origin: 'http://relay.test', rpcTimeoutMs: 1000, journals: store });
  const pairing = await broker.handleRequest(new Request('http://relay.test/v1/remote/pairings', { method: 'POST', body: '{}' }));
  const { key } = await pairing!.json();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests: IncomingMessage[] = [];
  server.on('connection', async (socket, request) => {
    requests.push(request);
    const prepared = await broker.prepareUpgrade(new Request(`http://relay.test${request.url}`, { headers: { authorization: `Bearer ${key}` } }));
    if (!prepared || prepared instanceof Response) { socket.close(); return; }
    prepared.accept({
      get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; },
      send: data => socket.send(data), close: (code, reason) => socket.close(code, reason),
      onMessage(listener) { const receive = (data: import('ws').RawData, binary: boolean) => { void listener(data.toString(), binary); }; socket.on('message', receive); return () => { socket.off('message', receive); }; },
      onClose(listener) { socket.on('close', listener); return () => { socket.off('close', listener); }; },
      onError(listener) { socket.on('error', listener); return () => { socket.off('error', listener); }; },
    } satisfies RelaySocket);
  });
  const sessions: ScriptedSession[] = [];
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'fake', displayName: 'Fake' },
    ...(options.capable ? { journal: { itemIdentity: 1 as const } } : {}),
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId: 'fake', list: async () => [], workspaces: async () => [], create: async () => 'thread-1',
    canReleaseSession: () => true,
    async open(nativeSessionId) { const session = new ScriptedSession('fake', nativeSessionId, history()); sessions.push(session); return session; },
    async close() { await Promise.all(sessions.map(session => session.dispose())); },
  };
  const lifecycle: string[] = [];
  const host = createAgentHost({
    registrations: [{ adapter, directory }], installationId: 'journal-installation', name: 'Host',
    uplink: { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/remote-host`, remoteKey: key },
    ...(options.idleGraceMs ? { idleGraceMs: options.idleGraceMs, idleReconcileMs: 10_000 } : {}),
    onSessionLifecycleDiagnostic: diagnostic => { lifecycle.push(diagnostic.event); },
    ...(options.diagnostics ? { onJournalDiagnostic: (diagnostic: JournalPublisherDiagnostic) => { options.diagnostics!.push(diagnostic); } } : {}),
  });
  closers.push(async () => {
    await host.close();
    broker.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const { hostId } = await host.ready;
  const attach = async () => {
    const response = await broker.handleRequest(new Request(`http://relay.test/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify({ providerId: 'fake', nativeSessionId: 'thread-1' }) }));
    expect(response?.status).toBe(200);
  };
  const journal = async (): Promise<SessionJournal | undefined> => {
    const state = await store.load(`${hostId}:${SESSION}`);
    return state ? new SessionJournal(state) : undefined;
  };
  return { host, store, attach, journal, sessions, requests, lifecycle };
}

describe('the Controller publishing its sessions over the real uplink', () => {
  it('asks the Relay for journals and publishes an attached session, history and live rows, to its journal', async () => {
    const run = await start({ capable: true });
    await run.attach();
    expect(new URL(run.requests[0]!.url!, 'http://relay').searchParams.get('journal')).toBe('2');
    await until(async () => (await run.journal())?.head !== undefined, 'the head');
    let journal = (await run.journal())!;
    expect(journal.index().map(entry => [entry.itemKey, entry.state])).toEqual([['m1', 'complete'], ['m2', 'complete']]);
    run.sessions[0]!.push(item('live', 'a', 'Wor', { completes: false }));
    run.sessions[0]!.push(item('live', 'a', 'ld', { completes: true }));
    await until(async () => (await run.journal())?.index().find(entry => entry.itemKey === 'a')?.state === 'complete', 'the live item');
    journal = (await run.journal())!;
    const page = journal.page({ requestId: 'r', agentId: 'agent', direction: 'tail', limit: 10 }, { olderBeyondJournal: false });
    expect(page.kind === 'page' && page.page.payload.entries.map(entry => 'text' in entry.item ? entry.item.text : '')).toEqual(['Hello', 'World', 'World']);
  });

  it('keeps the epoch and every row when an idle session is released and woken again (T6)', async () => {
    const run = await start({ capable: true, idleGraceMs: 60 });
    await run.attach();
    await until(async () => (await run.journal())?.head !== undefined, 'the head');
    const before = (await run.journal())!;
    await until(() => run.lifecycle.includes('session_idle_released'), 'the idle release', 6000);
    await run.attach();
    await until(() => run.sessions.length === 2, 'the second opening');
    await until(async () => ((await run.journal())?.publisher?.generation ?? 0) > (before.publisher?.generation ?? 0), 'the journal to be opened again');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    const after = (await run.journal())!;
    expect(after.epoch).toBe(before.epoch);
    expect(after.index().map(entry => [entry.itemKey, entry.seqStart, entry.revision])).toEqual(before.index().map(entry => [entry.itemKey, entry.seqStart, entry.revision]));
    expect(after.cursor).toEqual(before.cursor);
  });

  it('does not ask for journals, and publishes nothing, when no provider declares support', async () => {
    const run = await start({ capable: false });
    await run.attach();
    expect(new URL(run.requests[0]!.url!, 'http://relay').searchParams.get('journal')).toBeNull();
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    expect(await run.journal()).toBeUndefined();
  });

  it('records what it cannot publish as diagnostics, without content', async () => {
    const diagnostics: JournalPublisherDiagnostic[] = [];
    const run = await start({ capable: true, diagnostics });
    await run.attach();
    await until(async () => (await run.journal())?.head !== undefined, 'the head');
    run.sessions[0]!.push(item('live', 'bad', 'secret text', { turnId: 't'.repeat(600) }));
    await until(() => diagnostics.length > 0, 'the diagnostic');
    expect(diagnostics).toEqual([{ event: 'journal_row_rejected', providerId: 'fake' }]);
  });
});
```

Add to `packages/agent-host/src/relay-diagnostics.test.ts` a test that the shared module decodes the journal events a Controller advertising version 4 receives:

<!-- edit: packages/agent-host/src/relay-diagnostics.test.ts -->
<!-- old -->
```ts
it('rotates complete records within both file size and archive count bounds', async () => {
```
<!-- new -->
```ts
it.each(['journal_message_unencodable', 'journal_store_failed', 'journal_fanout_failed', 'journal_quota_exceeded', 'journal_live_only_dropped'] as const)('appends the journal diagnostic %s that Controllers of delivery version 4 receive', async event => {
  const path = await location(); const sink = createRelayDiagnosticSink({ path });
  await sink.append([{ ...entry, event }]);
  expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual({ ...entry, event });
});

it('rotates complete records within both file size and archive count bounds', async () => {
```

Update the three expectations of delivery version 3 in `packages/agent-host/src/host.test.ts`:

<!-- edit: packages/agent-host/src/host.test.ts -->
<!-- old -->
```ts
    expect(JSON.parse(result.body)).toEqual({ diagnosticDelivery: 3, health: { warnings: [{ code: 'uplink_unstable' }] } });
```
<!-- new -->
```ts
    expect(JSON.parse(result.body)).toEqual({ diagnosticDelivery: 4, health: { warnings: [{ code: 'uplink_unstable' }] } });
```

<!-- edit: packages/agent-host/src/host.test.ts -->
<!-- old -->
```ts
    if (installed) expect(JSON.parse(response.body)).toEqual({ diagnosticDelivery: 3 });
```
<!-- new -->
```ts
    if (installed) expect(JSON.parse(response.body)).toEqual({ diagnosticDelivery: 4 });
```

<!-- edit: packages/agent-host/src/host.test.ts -->
<!-- old -->
```ts
    expect(JSON.parse(response.body).diagnosticDelivery).toBe(installed ? 3 : undefined);
```
<!-- new -->
```ts
    expect(JSON.parse(response.body).diagnosticDelivery).toBe(installed ? 4 : undefined);
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/host-journal.test.ts src/relay-diagnostics.test.ts src/host.test.ts --testTimeout=15000`
Expected: FAIL (`onJournalDiagnostic` and the uplink option do not exist; delivery version is still 3).

- [ ] **Step 3: Implement.** In `packages/agent-host/src/host.ts`, import the publisher, the capability test and the message type:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
import { SessionOutbox } from './session-outbox.js';
```
<!-- new -->
```ts
import { SessionOutbox } from './session-outbox.js';
import { createJournalPublisher, type JournalPublisher, type JournalPublisherDiagnostic } from './journal-publisher.js';
import { supportsJournal } from '@orchardworks/agent-provider-sdk';
import type { JournalRelayMessage } from '@orchardworks/agent-remote-protocol';
```

The runtime takes a place to record what the publisher cannot do, and exposes the publisher:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
  shutdownTimeoutMs?: number;
  cancelTimeoutMs?: number;
  executionPolicy?: HostExecutionPolicy;
```
<!-- new -->
```ts
  /** Told what the journal publisher could not publish. The entries carry no conversation content. */
  onJournalDiagnostic?: (diagnostic: JournalPublisherDiagnostic) => void;
  shutdownTimeoutMs?: number;
  cancelTimeoutMs?: number;
  executionPolicy?: HostExecutionPolicy;
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
  /** Session states the Relay shares with the owner's pages. */
  readonly sessionStates: SessionStatePublisher;
```
<!-- new -->
```ts
  /** Session states the Relay shares with the owner's pages. */
  readonly sessionStates: SessionStatePublisher;
  /** Publishes the sessions of providers that declare journal support to their journals on the Relay. */
  readonly journals: JournalPublisher;
```

Create the publisher where the registrations are known:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
  const relayAdapters = options.registrations.map(({ adapter }) => ({
```
<!-- new -->
```ts
  /** Only providers whose adapters declare journal support are published; every other provider keeps today's forwarding. */
  const journals = createJournalPublisher({
    providers: () => [...registrations.values()]
      .filter(registration => supportsJournal(registration.adapter) && options.providerEnabled?.(registration.directory.providerId) !== false)
      .map(registration => registration.adapter.descriptor.providerId),
    ...(options.onJournalDiagnostic ? { diagnostic: options.onJournalDiagnostic } : {}),
  });
  const relayAdapters = options.registrations.map(({ adapter }) => ({
```

Follow a session while the Host holds it, and publish what it still has before an idle release closes it:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
        watch(binding);
        if (existing) lifecycle('session_idle_restored', binding);
```
<!-- new -->
```ts
        watch(binding);
        journals.attach({ agentId: proposedAgentId, providerId, nativeSessionId, source: relay.requireAgent(proposedAgentId) });
        if (existing) lifecycle('session_idle_restored', binding);
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
      await relay.closeAgent(binding.agentId);
      await registration(binding.providerId).directory.sessionReleased?.(binding.nativeSessionId);
```
<!-- new -->
```ts
      await journals.release(binding.agentId);
      await relay.closeAgent(binding.agentId);
      await registration(binding.providerId).directory.sessionReleased?.(binding.nativeSessionId);
```

Return the publisher, and publish what is queued before the runtime closes:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
  return { relay, sessionStates, sessionCatalog, callSession,
```
<!-- new -->
```ts
  return { relay, sessionStates, journals, sessionCatalog, callSession,
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
      await bounded(outbox?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
```
<!-- new -->
```ts
      await bounded(journals.drain(1000), shutdownTimeoutMs).catch(() => undefined);
      journals.close();
      await bounded(outbox?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
```

The uplink hands the publisher the grant and the messages, and forgets the writer when a connection is replaced:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
    uplinkUrl = config.url;
    runtime.setRelayConnected(false);
    const current = ++generation;
```
<!-- new -->
```ts
    uplinkUrl = config.url;
    runtime.setRelayConnected(false);
    runtime.journals.available(undefined);
    const current = ++generation;
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
      sessionStates: runtime.sessionStates,
      providers: describeProviders(),
```
<!-- new -->
```ts
      // A Controller with no journal-capable provider does not ask for the grant, and a Relay without it never offers one.
      ...(runtime.journals.capable() ? { journal: {
        available: (writer: { send(json: string): void } | undefined) => { if (generation === current && !closed) runtime.journals.available(writer); },
        receive: (message: JournalRelayMessage) => { if (generation === current && !closed) runtime.journals.receive(message); } } } : {}),
      sessionStates: runtime.sessionStates,
      providers: describeProviders(),
```

Advertise diagnostic delivery 4, which adds the journal diagnostics:

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
            return { status: 200, body: JSON.stringify({ ...(await updater?.status()), ...(options.onRelayDiagnostics ? { diagnosticDelivery: 3 } : {}),
```
<!-- new -->
```ts
            return { status: 200, body: JSON.stringify({ ...(await updater?.status()), ...(options.onRelayDiagnostics ? { diagnosticDelivery: 4 } : {}),
```

<!-- edit: packages/agent-host/src/host.ts -->
<!-- old -->
```ts
          ...(request.method === 'GET' && options.onRelayDiagnostics ? { diagnosticDelivery: 3 } : {}) }) }; }
```
<!-- new -->
```ts
          ...(request.method === 'GET' && options.onRelayDiagnostics ? { diagnosticDelivery: 4 } : {}) }) }; }
```

In `packages/agent-host/src/cli.ts`, write the publisher's diagnostics to the Controller log:

<!-- edit: packages/agent-host/src/cli.ts -->
<!-- old -->
```ts
    onSessionLifecycleDiagnostic: diagnostic => { writeDiagnostic(JSON.stringify({ ...diagnostic, timestamp: new Date().toISOString(), pid: process.pid }), diagnosticSecrets); },
```
<!-- new -->
```ts
    onSessionLifecycleDiagnostic: diagnostic => { writeDiagnostic(JSON.stringify({ ...diagnostic, timestamp: new Date().toISOString(), pid: process.pid }), diagnosticSecrets); },
    onJournalDiagnostic: diagnostic => { writeDiagnostic(JSON.stringify({ ...diagnostic, timestamp: new Date().toISOString(), pid: process.pid }), diagnosticSecrets); },
```

Document version 4 next to the other delivery versions in `packages/agent-remote-protocol/README.md`:

<!-- edit: packages/agent-remote-protocol/README.md -->
<!-- old -->
```md
- Version 3 additionally accepts `wasClean`, `runtimeInstanceId`, `workerVersionId`,
  and `startReason` (`runtime_start` or `core_recovery`, on `relay_started` only).
```
<!-- new -->
```md
- Version 3 additionally accepts `wasClean`, `runtimeInstanceId`, `workerVersionId`,
  and `startReason` (`runtime_start` or `core_recovery`, on `relay_started` only).
- Version 4 additionally accepts the journal events (`journal_message_unencodable`,
  `journal_store_failed`, `journal_fanout_failed` and the quota events that follow them).
  A Controller advertises 4 once it decodes them through the shared hosted module.
```

- [ ] **Step 4: Run the tests and see them pass, then the package.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/host-journal.test.ts src/relay-diagnostics.test.ts src/host.test.ts --testTimeout=15000` then `pnpm --filter @orchardworks/agent-remote-controller run typecheck` then `pnpm --filter @orchardworks/agent-remote-controller run test`
Expected: PASS for all.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-host/src packages/agent-remote-protocol/README.md
git commit -m "feat(host): publish the sessions of journal-capable providers, release them safely and advertise diagnostic delivery 4" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 11: The continuity fixture every provider adapter must pass

Provider adapters (P1-C2) prove that live and reread observations of one native session agree, with this helper. It runs the Controller's own code: it feeds the observations to a real agent manager, so the rows are the rows the manager keeps, including the interaction items it builds from `interaction_resolved`; groups them into items; and asks `planPublication` what a reopened journal would need. This task proves the helper with a fake provider, including the ways an adapter fails it.

**Files:**
- Create: `packages/agent-host/src/test-utils/journal-continuity.ts`
- Create: `packages/agent-host/src/journal-continuity.test.ts`
- Modify: `packages/agent-host/src/journal-publisher.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `packages/agent-host/src/journal-continuity.test.ts`. The fake provider is the scripted session's observations; each test is one way an adapter can behave:

<!-- write: packages/agent-host/src/journal-continuity.test.ts -->
```ts
import { describe, expect, it } from 'vitest';

import { continuityPlan, expectContinuity, itemsOf } from './test-utils/journal-continuity.js';
import { item } from './test-utils/journal-scripted-session.js';

/** What a session emitted while it ran: history at open, then live deltas of one reply and a user message. */
const liveRun = () => [
  item('history', 'user:1', 'Fix the bug', { type: 'user_message' }),
  item('history', 'assistant:1', 'On it.'),
  item('live', 'assistant:2', 'The cause ', { completes: false }),
  item('live', 'assistant:2', 'is a race.', { completes: true }),
  item('live', 'question:1', 'Which file?', { completes: true, liveOnly: true }),
];

/** What the adapter returns after the session was reopened: finalized records, whole. */
const reread = () => [
  item('history', 'user:1', 'Fix the bug', { type: 'user_message' }),
  item('history', 'assistant:1', 'On it.'),
  item('history', 'assistant:2', 'The cause is a race.'),
];

describe('the continuity fixture', () => {
  it('accepts an adapter whose live deltas and reread records share keys and content, and adds nothing to the journal', async () => {
    await expectContinuity({ live: liveRun(), reread: reread() });
    const plan = await continuityPlan({ live: liveRun(), reread: reread() });
    expect(plan).toMatchObject({ kind: 'continue', ops: [] });
  });

  it('accepts an unchanged session that has a background item, although every reconcile restates its outcome', async () => {
    const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
    const withBackground = <T extends ReturnType<typeof item>>(observation: T): T => ({ ...observation, event: { ...observation.event, item: { ...observation.event.item, background } } }) as T;
    const live = [...liveRun(), withBackground(item('live', 'assistant:3', 'Review started', { completes: true }))];
    const again = [...reread(), withBackground(item('history', 'assistant:3', 'Review started'))];
    await expectContinuity({ live, reread: again });
    const plan = await continuityPlan({ live, reread: again });
    expect(plan.kind === 'continue' && plan.ops.map(({ op }) => op.op)).toEqual(['outcome']);
  });

  it('groups observations into the items a journal would hold, in order', async () => {
    const items = await itemsOf(liveRun());
    expect(items.map(({ key, complete, liveOnly }) => [key, complete, liveOnly])).toEqual([
      ['user:1', true, false], ['assistant:1', true, false], ['assistant:2', true, false], ['question:1', true, true],
    ]);
  });

  it('accepts a reread that covers only the newest items, as a provider that reads the latest page does', async () => {
    await expectContinuity({ live: liveRun(), reread: reread().slice(1) });
  });

  it('fails an adapter whose live keys are not the keys of its records', async () => {
    const live = [item('history', 'record:1', 'Hello'), item('live', 'stream:1', 'Hi', { completes: true })];
    const sameItemAfterReopen = [item('history', 'record:1', 'Hello'), item('history', 'record:2', 'Hi')];
    await expect(expectContinuity({ live, reread: sameItemAfterReopen })).rejects.toThrow(/append|prepend|correct|replace/);
  });

  it('fails an adapter whose reread content differs from what it streamed', async () => {
    const changed = [...reread().slice(0, 2), item('history', 'assistant:2', 'The cause is a deadlock.')];
    await expect(expectContinuity({ live: liveRun(), reread: changed })).rejects.toThrow(/correct/);
    expect(await continuityPlan({ live: liveRun(), reread: changed })).toMatchObject({ kind: 'continue', ops: [{ op: { op: 'correct' } }] });
  });

  it('fails an adapter whose reread does not complete its items', async () => {
    const open = [...reread().slice(0, 2), item('history', 'assistant:2', 'The cause is a race.', { completes: false })];
    await expect(expectContinuity({ live: liveRun(), reread: open })).rejects.toThrow(/complete/);
  });

  it('fails an adapter whose observations lack an item identity', async () => {
    const bare = { ...item('history', 'x', 'No identity'), itemIdentity: undefined };
    await expect(expectContinuity({ live: [bare], reread: [bare] })).rejects.toThrow(/identity/);
  });

  it('covers the interaction items the agent manager builds: an adapter that gives them an identity passes, one that does not fails', async () => {
    const question = { kind: 'question' as const, requestId: 'q1', questions: [{ questionId: 'q', header: 'Pick', prompt: 'Which?', required: true, selection: 'single' as const, options: [{ value: 'a', label: 'A' }], allowCustomText: false, allowDismiss: false }] };
    const asked = { type: 'observation' as const, sourceKey: 'ask', occurredAt: 1, delivery: 'live' as const, event: { type: 'interaction_requested' as const, provider: 'fake', request: question } };
    const answered = (identity?: { key: string; completes?: true; liveOnly?: true }) => ({ type: 'observation' as const, sourceKey: 'answer', occurredAt: 2, delivery: 'live' as const,
      event: { type: 'interaction_resolved' as const, provider: 'fake', requestId: 'q1', response: { kind: 'question' as const, answers: [] } }, ...(identity ? { itemIdentity: identity } : {}) });
    const live = (identity?: { key: string; completes?: true; liveOnly?: true }) => [...liveRun(), asked, answered(identity)];
    const items = await itemsOf(live({ key: 'interaction:q1', completes: true, liveOnly: true }));
    expect(items.at(-1)).toMatchObject({ key: 'interaction:q1', complete: true, liveOnly: true });
    await expectContinuity({ live: live({ key: 'interaction:q1', completes: true, liveOnly: true }), reread: reread() });
    await expect(itemsOf(live())).rejects.toThrow(/answer.*identity|identity.*answer/);
  });

  it('tells a genuine rewrite from an extension: a removed item means a replacement', async () => {
    const rewritten = [reread()[0]!, reread()[2]!];
    expect(await continuityPlan({ live: liveRun(), reread: rewritten })).toMatchObject({ kind: 'replace', reason: 'missing' });
  });
});
```

Add two tests of the publisher to `packages/agent-host/src/journal-publisher.test.ts`, which drive the manager's events through a source they can reach into. In the imports of that file, add the source and tap types:

<!-- edit: packages/agent-host/src/journal-publisher.test.ts -->
<!-- old -->
```ts
import { createJournalPublisher, type JournalPublisher, type JournalSource } from './journal-publisher.js';
```
<!-- new -->
```ts
import type { AgentJournalTap } from '@orchardworks/agent-remote-relay';

import { createJournalPublisher, type JournalPublisher, type JournalSource } from './journal-publisher.js';
```

<!-- edit: packages/agent-host/src/journal-publisher.test.ts -->
<!-- old -->
```ts
describe('recovering', () => {
```
<!-- new -->
```ts
describe('events the manager emits besides rows', () => {
  async function reachable(publisher: JournalPublisher) {
    const session = new ScriptedSession('fake', 'thread-1', [item('history', 'm1', 'Hello'), boundary()]);
    const manager = await attachScripted(session);
    closers.push(() => { void manager.close(); });
    const taps: AgentJournalTap[] = [];
    const source: JournalSource = {
      subscribeJournal: tap => { taps.push(tap); return manager.subscribeJournal(tap); },
      timelineRows: () => manager.timelineRows(), itemRows: key => manager.itemRows(key), attentionItemKey: () => manager.attentionItemKey(),
      snapshot: () => manager.snapshot(), loadOlderHistory: () => manager.loadOlderHistory(), hasOlderHistory: () => manager.hasOlderHistory(),
    };
    publisher.attach({ agentId: 'agent-1', providerId: 'fake', nativeSessionId: 'thread-1', source });
    return { tap: () => taps.at(-1)!, taps };
  }

  it('publishes a replaced resource binding as an amendment of the item it belongs to', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { tap } = await reachable(publisher);
    await until(() => relay.ops().includes('head'), 'the first head');
    const previous = { locator: 'out.png', resourceId: 'r1', status: 'pending' as const };
    const replacement = { locator: 'out.png', resourceId: 'r2', status: 'available' as const };
    tap().event({ type: 'timeline_resource_binding_replaced', agentId: 'agent-1', epoch: 'e', seq: 1, itemKey: 'm1', previous, replacement });
    await until(() => relay.ops().includes('rebind'), 'the amendment');
    expect(relay.written.flatMap(message => message.entries ?? []).find((entry: Wire) => entry.op === 'rebind')).toMatchObject({ itemKey: 'm1', previous, replacement });
  });

  it('reconciles again after the provider replaces its timeline, and publishes nothing of the rows in between', async () => {
    const relay = scriptedRelay();
    const publisher = publisherFor(relay, { batchWindowMs: 5 });
    const { tap } = await reachable(publisher);
    await until(() => relay.ops().includes('head'), 'the first head');
    const opens = relay.opens();
    tap().event({ type: 'timeline_replacement', agentId: 'agent-1', epoch: 'e2' });
    tap().event({ type: 'agent_stream', agentId: 'agent-1', delivery: 'history', timestamp: new Date(1).toISOString(), event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text: 'Mid-rebuild', messageId: 'x' } },
      row: { epoch: 'e2', seq: 1, providerId: 'fake', sourceKey: 'rebuild:1', occurredAt: 1, timestamp: new Date(1).toISOString(), item: { type: 'assistant_message', text: 'Mid-rebuild', messageId: 'x' }, resources: [], identity: { key: 'x', completes: true } } });
    tap().event({ type: 'timeline_rebuilt', agentId: 'agent-1', cursor: { epoch: 'e2', seq: 1 } });
    await until(() => relay.opens() === opens + 1, 'the reopening');
    await settle(40);
    expect(relay.ops().filter(op => op === 'append')).toEqual([]);
  });
});

describe('recovering', () => {
```

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-continuity.test.ts src/journal-publisher.test.ts --testTimeout=15000`
Expected: FAIL (`./test-utils/journal-continuity.js` does not exist).

- [ ] **Step 3: Implement the helper.** Create `packages/agent-host/src/test-utils/journal-continuity.ts`:

<!-- write: packages/agent-host/src/test-utils/journal-continuity.ts -->
```ts
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { itemDigest, type JournalIndexEntry } from '@orchardworks/agent-remote-journal';
import { expect } from 'vitest';

import { groupItems, mergedRow, type TimelineItem } from '../journal-items.js';
import { planPublication, type PublicationPlan } from '../journal-reconcile.js';
import { attachScripted, boundary, item, ScriptedSession, until } from './journal-scripted-session.js';

/** What one native session produced: everything it emitted while it ran, and what the adapter returns after it is reopened. */
export interface ContinuityRun {
  /** History at open, then live observations, in order; each says which it is in `delivery`. */
  live: readonly ProviderObservation[];
  /** The history observations of the same native session opened again. A provider that reads only the latest page returns only the newest items. */
  reread: readonly ProviderObservation[];
}

const SENTINEL = 'continuity:sentinel';

/**
 * The items a journal would hold for these observations: they go through a real agent manager, history before its boundary
 * and live observations after it, so the rows are the ones the Controller keeps, including the interaction items the
 * manager builds from `interaction_resolved`. Every row must carry an item identity.
 */
export async function itemsOf(observations: readonly ProviderObservation[]): Promise<TimelineItem[]> {
  const session = new ScriptedSession('continuity', 'continuity', [...observations.filter(observation => observation.delivery === 'history'), boundary()]);
  const manager = await attachScripted(session, 'continuity');
  try {
    for (const observation of observations.filter(observation => observation.delivery === 'live')) session.push(observation);
    // Live observations are applied in order after this call returns; the last one says when they all were.
    session.push(item('live', SENTINEL, ''));
    await until(() => manager.timelineRows().some(row => row.identity?.key === SENTINEL), 'the observations to reach the timeline');
    const rows = manager.timelineRows().filter(row => row.identity?.key !== SENTINEL);
    const bare = rows.filter(row => row.identity === undefined);
    if (bare.length > 0) {
      throw new Error(`${bare.length} timeline row(s) carry no item identity, for example the one from ${bare[0]!.sourceKey}; a journal-capable adapter gives every observation that becomes a row one, including the interaction_resolved observations the manager turns into interaction items.`);
    }
    return groupItems(rows);
  } finally {
    await manager.close();
  }
}

const digest = (timelineItem: TimelineItem): Promise<string> => itemDigest(mergedRow(timelineItem).item);

/** The index a journal would hold after publishing the live run: every item, complete ones with their digest. */
async function journalOf(items: readonly TimelineItem[]): Promise<JournalIndexEntry[]> {
  const index: JournalIndexEntry[] = [];
  for (const [at, timelineItem] of items.entries()) {
    index.push({
      itemKey: timelineItem.key, seqStart: at + 1, seqEnd: at + 1, state: timelineItem.complete ? 'complete' : 'open', ...(timelineItem.complete ? { digest: await digest(timelineItem) } : {}),
      liveOnly: timelineItem.liveOnly, revision: at + 1, resident: true,
    });
  }
  return index;
}

/** What the Controller would publish to the journal of the live run, when the session is reopened and read again. */
export async function continuityPlan(run: ContinuityRun): Promise<PublicationPlan> {
  const live = await itemsOf(run.live);
  const reread = await itemsOf(run.reread.map(observation => ({ ...observation, delivery: 'history' as const })));
  const open = reread.filter(entry => !entry.complete).map(entry => entry.key);
  if (open.length > 0) throw new Error(`History must complete every item it returns; these are not complete: ${open.join(', ')}.`);
  return planPublication(await journalOf(live), reread, digest);
}

/** Describes a plan that is not empty, naming the operations it would publish. */
const describePlan = (plan: PublicationPlan): string => plan.kind === 'gap' ? 'a gap'
  : `${plan.kind}${plan.kind === 'replace' ? ` (${plan.reason})` : ''}: ${[...plan.ops, ...(plan.kind === 'continue' ? plan.older : [])].map(({ op }) => op.op).join(', ') || 'nothing'}`;

/**
 * Proves continuity: the items of the reread have the keys and the content of the items the live run built, so
 * reconciling publishes no row, and the epoch continues. Fails with the operations it would have published.
 * Every reconcile restates the outcome of each background it holds, which changes nothing in a journal that has it, so
 * outcome entries do not count against continuity.
 */
export async function expectContinuity(run: ContinuityRun): Promise<void> {
  const plan = await continuityPlan(run);
  const publishes = plan.kind !== 'continue' || plan.ops.some(({ op }) => op.op !== 'outcome') || plan.older.length > 0 || plan.refused.length > 0;
  expect(publishes, `Reconciling would publish ${describePlan(plan)}.`).toBe(false);
}
```

- [ ] **Step 4: Run the tests and see them pass.**

Run: `pnpm --filter @orchardworks/agent-remote-controller exec vitest run src/journal-continuity.test.ts src/journal-publisher.test.ts --testTimeout=15000` then `pnpm --filter @orchardworks/agent-remote-controller run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/agent-host/src/test-utils/journal-continuity.ts packages/agent-host/src/journal-continuity.test.ts packages/agent-host/src/journal-publisher.test.ts
git commit -m "test(host): the continuity fixture that proves a provider adapter's item identities, proven with a fake provider" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 12: Documents, compatibility, the affected suites and the local instance

**Files:**
- Modify: `docs/blueprint/agent-remote-observation.md`
- Modify: `docs/current/agent-remote/protocol.md`
- Modify: `docs/current/agent-remote/provider-onboarding.md`
- Generated: `packages/agent-remote-lab/compatibility.json`

- [ ] **Step 1: Document the provider contract.** In `docs/blueprint/agent-remote-observation.md`, after the paragraph on the history boundary in the Provider Contract section:

<!-- edit: docs/blueprint/agent-remote-observation.md -->
<!-- old -->
```md
The adapter begins native live observation before history hydration, emits historical observations, emits one boundary, and then drains buffered and subsequent live observations. The Relay rejects history after the boundary and does not declare the session ready before receiving it.
```
<!-- new -->
```md
The adapter begins native live observation before history hydration, emits historical observations, emits one boundary, and then drains buffered and subsequent live observations. The Relay rejects history after the boundary and does not declare the session ready before receiving it.

An adapter may declare `journal: { itemIdentity: 1 }`. It then gives every timeline observation an `itemIdentity`: the native key of the finalized item the observation belongs to, whether the observation finishes the item (`completes`), and whether native history cannot rebuild it (`liveOnly`). The key of an item is the same when its deltas are observed live and when its record is read again after a reopen, and the merged content of its live rows equals the content of the record, so a digest of the content, which the Controller computes, is the same for both. History observations complete their item, except for a record the native runtime is still writing. An adapter declares the capability only after continuity fixtures prove this with `expectContinuity` (`packages/agent-host/src/test-utils/journal-continuity.ts`). The Controller publishes only the sessions of providers that declare it; every other provider keeps forwarding.
```

- [ ] **Step 2: Document the journal messages the Controller sends.** In `docs/current/agent-remote/protocol.md`, before the section on generic resource input:

<!-- edit: docs/current/agent-remote/protocol.md -->
<!-- old -->
```md
## Generic resource input
```
<!-- new -->
```md
## Session journals over the Host uplink

A Controller with at least one journal-capable provider asks for `journal=2` when it connects and uses the journal messages only after the Relay acknowledges `registered.journal: 2`; a Relay that grants only 1 gets no journal publishing from it, because level 2 adds `rebind`, `outcome`, optional digests, `attentionItemKey`, `journal_unserve` and `journal_request_refused`. Its publisher (`packages/agent-host/src/journal-publisher.ts`) follows each session of a capable provider while the Host holds it:

- **Open.** `journal_open` claims a generation, fencing every older connection. The Controller reads the whole item index (`journal_opened`, then `journal_index_request` for each `indexAfter`, one page at a time) and compares it with a reread of its timeline. Every open does this, before a live row is published: first attach, a Controller restart, a wake after an idle release, a provider refresh, and every recovery. A journal whose index is over the Relay's bound (100,000 items) refuses the open with `index_too_large` and is taken out of serving; the Controller then opens with `reset: true`, which claims the journal with an empty index and accepts nothing but a replacement that fits (and then the head) until one is stored.
- **Reconcile.** The epoch continues unless native history was rewritten. Unknown items are appended and completed, a known item that is open or whose digest differs is corrected (`correct` names the revision it saw), items older than the journal are prepended, and an open item that history no longer holds is sealed. Live-only items are never counted as missing. A rewrite is a `replace` of the newest items that fit one message; the older ones follow as a prepend after the journal is opened again.
- **Live.** Rows are batched for 50 ms and consecutive rows of one item merge. `complete` carries the digest of the whole item. An item that is still open stays open: a correction without a digest keeps it so. One publication per session is in flight until the Relay acknowledges it, and all sessions share a budget of 64 messages and 16 MiB in flight.
- **Amendments.** `rebind` replaces a resource binding in place and `outcome` applies a background outcome in place; both are stored, and the Relay sends them to journal-served clients as `timeline_resource_binding_replaced` and as an `agent_stream` frame without an epoch. Each reconcile says the outcome of every background in its window again. The other runtime events of the session wire (`thread_started`, `turn_*`, `usage_updated`, `runtime_updated`) change the Snapshot, which the head carries, so they are not published. Resource ids are keyed hashes of agent, locator and content, stable across restarts, so a row's binding still names a readable resource.
- **Head.** The head is the Snapshot, taken when a batch is drained. `attentionItemKey` names the item the Controller's attention cursor points at, and the journal serves that item's cursor in its own epoch and sequence. A head whose pending interactions changed is published at once, and the Relay forwards a Controller's interaction frame to a journal-served browser only after the head it last sent agrees with the frame.
- **Requests of the Relay.** `journal_fill_request` is answered with `journal_fill` from the Controller's timeline, reading older native history when the items are not in it. `journal_older_request` is answered with a prepend and then `journal_older_done`. A request for a session the Controller does not follow, or has not opened yet, is answered at once with `journal_request_refused`.
- **Failures.** A refusal, a missing acknowledgement (30 seconds) or a lost connection opens the session again, with a backoff that starts over after a minute of publishing. A refusal about one item (`unknown_item`, `body_missing`, `type_changed`, `duplicate_item`, `invalid`) leaves that item out and sends the rest again, renumbered from the refused sequence (a refused entry never consumes its sequence), without opening; a refusal that names no item, and a `sequence_gap` of its own, open again. A provider observation without `itemIdentity` stops the session (`journal_session_stopped`, reason `identity_missing`) and unserves it. `quota_exceeded` replaces with the newest 2,000, 200 and then 20 items. `incomplete` (a head sent while the journal is missing rows) replaces again with the same window and then sends the head. A row or item the wire refuses is dropped with a `journal_row_rejected` diagnostic and does not stop the session. A session that cannot be kept current (its head cannot be published, the Relay keeps calling the journal incomplete, the narrowest quota window is refused, three replacements in a row) is stopped and `journal_unserve` tells the Relay to clear the head, so browsers read the session through the Controller again. A refused open needs no unserve: the Relay takes the session out of serving itself, and the Controller stops publishing it until the next connection.

A Controller that advertises diagnostic delivery 4 receives the Relay's journal diagnostics. A Relay without the journal grant, or a Controller without a capable provider, leaves the session on forwarding.

## Generic resource input
```

- [ ] **Step 3: Document how a provider joins.** At the end of the capability record guidance in `docs/current/agent-remote/provider-onboarding.md`, add the journal step to the verification record:

<!-- edit: docs/current/agent-remote/provider-onboarding.md -->
<!-- old -->
```md
## Verification and release record
```
<!-- new -->
```md
## Journal support

A provider joins Relay journals only through its adapter: it declares `journal: { itemIdentity: 1 }` once every timeline observation carries an `itemIdentity` and continuity fixtures pass (see the Provider Contract in `docs/blueprint/agent-remote-observation.md`). The fixture records a live session and the same session opened again, and `expectContinuity` must find the same item keys and the same merged-content digests, add nothing to the journal, and call for a replacement only when native history really changed. Until then the provider's sessions stay on forwarding, which is always safe.

## Verification and release record
```

- [ ] **Step 4: Update the compatibility digest.** Run: `pnpm compatibility:update` then `pnpm compatibility:check`
Expected: `Compatibility updated: sha256:...` then `Compatibility verified: sha256:...`.

- [ ] **Step 5: Run the affected suites with deadlines.** Run each with an outer deadline of 300000 ms (the Bash tool `timeout`); each command sets its own per-test deadline. Packages that others import from `dist` are rebuilt first.

```bash
pnpm --filter @orchardworks/agent-provider-sdk run build
pnpm --filter @orchardworks/agent-remote-protocol run build
pnpm --filter @orchardworks/agent-remote-journal run build
pnpm --filter @orchardworks/agent-remote-relay run build
pnpm --filter @orchardworks/agent-remote-hosted run build
pnpm --filter @orchardworks/agent-provider-sdk run test
pnpm --filter @orchardworks/agent-remote-protocol run test
pnpm --filter @orchardworks/agent-remote-journal run test
pnpm --filter @orchardworks/agent-remote-relay run test
pnpm --filter @orchardworks/agent-remote-hosted run test
pnpm --filter @orchardworks/agent-remote-controller run typecheck
pnpm --filter @orchardworks/agent-remote-controller run test
```
Expected: every command passes. The Controller's suite excludes the `*.local.test.ts` files, which need native CLIs.

Then the suites of the packages that use the Relay's agent manager and uplink client, with Node 22 for the browser ones:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-web run test
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm --filter @orchardworks/agent-remote-lab run test
```
Expected: PASS. Nothing here changes what a browser receives from a crude session; the amendments reach journal-served browsers, which only tests and a fake Controller serve until a provider declares support.

- [ ] **Step 6: Check the local instance.** Follow `.agents/skills/prepare-arc-local/SKILL.md` to start this checkout's instance with `pnpm local up`, using free ports, and to attach its Controller. No provider declares journal support yet, so this step shows no regression:
  1. Open a session of each installed provider in the local site, send a message, and watch it stream and finish.
  2. Release it (wait out the idle grace of a Codex or OpenCode session, or restart the local Controller) and open it again.
  3. Check that the Controller connected without `journal=2` (the local Relay's diagnostics, or the Controller log, show no journal message) and that the session behaves exactly as before.
  4. Check that `GET /remote/controller-update` on the local Controller reports `diagnosticDelivery: 4`.

  The check that a restart shows no reset (T6) belongs to the first plan that lets a provider declare the capability (P1-C2, Task 6).

- [ ] **Step 7: Commit.**

```bash
git add docs/blueprint/agent-remote-observation.md docs/current/agent-remote/protocol.md docs/current/agent-remote/provider-onboarding.md packages/agent-remote-lab/compatibility.json
git commit -m "docs: describe item identity, the journal capability and what the Controller publishes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
