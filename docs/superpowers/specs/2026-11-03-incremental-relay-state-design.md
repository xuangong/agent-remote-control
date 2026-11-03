# Incremental Relay state commits

Status: proposed on 2026-11-03, after Teams moved to their own records (snapshot format 4, `306fc4cc`). For review before implementation.

## Problem

The hosted Relay keeps its whole state, for every account, in one in-memory tree inside one Durable Object (`getByName('primary')`). Every change, however small, goes through `createRelayState().mutate` (`agent-remote-hosted/src/state.ts`), which processes the complete tree:

1. `structuredClone(current)` of the whole Relay.
2. `stageRelayState`, then `assertSuccessionCapacity`, which measures the complete snapshot twice: once as it is and once as its ordinary view (`ordinaryView` is another `structuredClone`).
3. `storage.commit`, which encodes the complete snapshot a third time (`validateRelayState` with its own `structuredClone`, then JSON, UTF-8, SHA-256 and chunks for every record, then `preflightHostedSnapshot`, which decodes and hashes every record again), and finally writes only the records whose digest changed.

Encoding one record also serializes its payload twice: `payloadStringBytes` is computed as `jsonBytes(JSON.stringify(payload))`, a second, escaped serialization of the same payload.

Above the Relay state, each broker commit (`broker.ts`, `commit`) starts from `structuredClone(snapshot())`, and `snapshot()` rebuilds the account's broker state from its in-memory maps on every call. Team changes (`TeamBroker.change`) additionally compact every Team, compare the whole Team list with `isDeepStrictEqual`, and measure it with `JSON.stringify`, repeatedly while pruning.

So the cost of a change grows with the size of the whole Relay, not with the change. Format 4 only fixed the write: the cost before it stays.

### Measurements

On the operating datasets of `storage-operating-fixture.ts` (Node 22, this Mac, node:sqlite store, cost-backed accounting as in production):

| Dataset | Snapshot | Records | One commit | Capacity accounting | One complete encode | Clone | Validate |
|---|---|---|---|---|---|---|---|
| M | 117 KB | 149 | 8.6 ms | 4.1 ms | 2.9 ms | 0.3 ms | 1.2 ms |
| L | 7.1 MB | 52 | 132 ms | 62 ms | 59 ms | 1.0 ms | 2.7 ms |
| O | 8.1 MB | 52 | 167 ms | 81 ms | 68 ms | 1.1 ms | 3.4 ms |

One complete encode of L: `JSON.stringify` 19.5 ms, the second escaped serialization about the same again, UTF-8 encoding 4.7 ms twice, SHA-256 2.2 ms, preflight 7.4 ms. Cloning and validation are cheap; encoding, done three times per commit, is the cost.

All accounts share the Durable Object and commits run one at a time, so at L's size the Relay commits about seven changes a second in total. Changes are frequent: Team messages, receipts, presence and usage, session grants and authority renewals, stars, titles, Windows.

The production snapshot size is unknown: Durable Object storage cannot be exported. L and O are the succession operating envelope, close to the bounds, not a sample of production.

## Goals

- The cost of a commit follows the size of the change: the records it changes plus the headers that list them.
- Unchanged on-disk format (snapshot format 4, record format 1) and unchanged semantics: the same validation, the same succession admission results, atomic commits and the same durability rules. Phases 1 and 2 can therefore be rolled back with the Worker.
- A restart still decodes, validates and re-encodes the complete state once.
- Afterwards, the account's 2 MiB Team-state bound gives way to a per-Team bound.

Not in scope: one Durable Object per account (a separate design, needed for isolation between accounts and beyond one object's memory), the group model of sessions, and record format changes.

## Design

### Phase 0: measure production

Add a Relay diagnostic event after each commit: snapshot bytes, record count, records re-encoded, records written, and the duration of each step (clone, staging, capacity, encode, write). It carries no account, session or content data. This shows the real size and which phases matter, and later confirms each phase's effect.

### Phase 1: reuse encodings of unchanged records, keyed by content

A record cache in `record-codec.ts`, owned by each caller (the store, and each of the two capacity views):

- Key: the record's logical identity `[kind, owner, key]`. Value: the payload's JSON text, the encoded bytes, manifest, chunks and cost.
- Encoding a record serializes its payload once. When the JSON text equals the cached text, the cached bytes, digest, chunks and cost are reused: no UTF-8 encoding, no hashing, no chunking, no preflight of that record.
- `payloadStringBytes` is derived from the JSON text by counting the characters that `JSON.stringify` would escape, instead of serializing again.
- The store keeps the cache for the rows it has written; the capacity accounting keeps one cache per view.
- Decoding at startup fills the store's cache.

Nothing about drafts or mutations changes, so this cannot lose a change: equal text is equal content. Expected on L: one serialization per record and view instead of six serializations, encodings and hashes, so a commit of about 45 ms instead of 132 ms. It still grows with the size of the whole Relay.

### Phase 2: share unchanged objects between commits, keyed by identity

To make the cost follow the change, unchanged objects must keep their identity from one commit to the next, so the codec can skip them without serializing them.

1. **Copy-on-write drafts.** `state.mutate` replaces `structuredClone(current)` with a copy-on-write draft: the callback edits the draft as it does today, and only the objects it touches, and their parents, are copied. The existing callbacks (about 26 Relay state mutations across the gateway, sessions, security, Favorites, stars, titles, Windows and migrations, and about 20 broker commits) keep their shape. The same applies to `ordinaryView`, which then copies only the parts it strips.
2. **The broker keeps a committed tree.** Instead of rebuilding its state with `snapshot()` and cloning it, each broker keeps the tree it last committed. A commit drafts from that tree, and `publish()` updates its runtime maps from the changed entities. Fields that exist only at runtime (socket generations, recovery handles) stay out of the tree, as `snapshot()` strips them today. `TeamBroker.change` does the same for Teams: only the Teams a change touches are copied, compacted and measured, and the account's Team bytes become a running total, adjusted by the Teams that changed.
3. **Identity fast path in the cache.** When a record's payload is the same object as at the last commit, its encoding is reused without serializing. Headers (relay, tenant, broker, associations, Favorites progress) are rebuilt on each commit but are small, now that Teams are their own records.
4. **Validation per changed entity.** `validateRelayState` keeps its whole-state invariants (uniqueness, per-account counts, cross references) over keys, which is cheap, and runs the per-item checks, including the protocol decoding of titles and migrations, only for objects it has not validated before. Its final `structuredClone` is dropped when no migration applies.

The copy-on-write mechanism is either [Immer](https://immerjs.github.io/immer/) (`produce`, with patches listing the changed paths, automatic freezing on in tests) or a small in-house proxy. Immer is about 16 KB, maintained, and covers the corner cases (arrays, nested drafts, `delete`); it is a new dependency and needs approval. An in-house proxy avoids the dependency but has to cover those cases itself.

**The rule this phase introduces:** a committed object is never changed in place. An in-place change of a committed object would keep its identity, so the cache would skip it and the change would not be written until something else changed that record. Guards:

- Tests and development freeze committed trees deeply, so an in-place change throws where it happens.
- Production re-encodes the complete snapshot without the cache every N commits (for example every 500, and at idle) and compares digests. A mismatch is logged with the record kinds involved, the cache is dropped, and the commit is written from the complete encoding.
- A restart re-validates and re-encodes everything, as it does now.

Expected: a Team message re-encodes that Team and a few small headers, whatever the size of the Relay.

### Phase 3: bounds that follow the record, not the account

With phase 2 in place, the account's 2 MiB Team-state bound (`broker.ts`, `trimTeamDeliveryReceipts`, the Call For Support retention threshold) is replaced by:

- a bound per Team record (for example 256 KiB: the 128 KiB message budget, the 64 KiB Call For Support group, receipts and members);
- the existing count limit of 1,024 Teams per account;
- a guard on the whole Relay's in-memory state, well inside the Durable Object's 128 MB, until accounts move to their own objects.

Call For Support's pruning by size then only protects that guard; archiving and removal by age stay.

## Verification

- **Equivalence (phases 1 and 2):** for sequences of mutations over the existing fixtures (codec inventory, operating datasets, Teams, Call For Support groups, successions), the cached encoding equals a complete encoding after every commit: the same manifests, digests and costs. The same check runs for the capacity accounting results.
- **Immutability (phase 2):** the suites run with committed trees frozen, so any in-place change of a committed object fails its test.
- **Production check (phase 2):** the periodic complete re-encode, with its mismatch log, verified by a test that injects an in-place change.
- **Performance:** commit-time tests on M, L and O for a small change, with an upper bound per phase; phase 0's diagnostics before and after each deployment.
- **Existing suites:** storage, succession capacity and replay, operating envelope, Teams and Call For Support, unchanged.

## Rollout

Each phase is a separate website deployment. No phase changes the stored format, so each can be rolled back with `wrangler rollback`. Phase 0 first, to know production's size; phase 1 next, because it removes most of the cost without changing how state is changed; phase 2 after a dependency decision; phase 3 last.

## Risks

- **Phase 2 depends on immutability.** Code that changes a committed object in place would silently skip a write. The frozen trees in tests catch it where code is tested; the production re-encode catches the rest within N commits, and writes it then.
- **Broker refactor.** The broker's runtime maps and its committed tree must not diverge. The committed tree is the persisted truth; the maps are rebuilt from changed entities in `publish()`, and a test compares them with a complete rebuild after each commit.
- **Memory.** Keeping committed trees and caches costs memory, at most about twice the snapshot, which matters only near the whole-Relay guard.
- **Unknown production size.** If production is small, phases 1 and 2 matter mostly for growth; phase 0 decides how urgent they are.

## Decisions needed

1. Immer as a dependency for phase 2, or an in-house copy-on-write proxy.
2. Whether to implement phases 0 and 1 now, before deciding phase 2.
