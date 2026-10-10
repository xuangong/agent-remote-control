# Local session succession storage evidence

Measured on 2026-10-11 with Node 26.0.0, Darwin 25.6.0 arm64, Miniflare
4.20260601.0 and its nested workerd 1.20260601.1. This is a bounded local
Worker/SQLite fixture checkpoint, not a supported production operating envelope.
No production code, capability or effect guard changed for this checkpoint.

## Cases and observable behavior

The fixed run contains three nominal samples of each S/M/B0/B1/L/O dataset,
plus late-progress, hold and reject cases for each of L/O: 24 sequences total.
S is empty feature state; M contains ordinary-sized retained evidence. B0/B1
place both a retained freeze record and the broker header exactly at 262144 and
262145 encoded bytes, exercising one versus two BLOB chunks. L starts at
8384512 feature bytes, 4096 below the 8388608-byte feature limit. O preserves
L's feature identities and charge while adding 1048576 ordinary ASCII bytes.
Ordinary state is not added to feature charge.

The L/O nominal path connects its fake Host peer, commits terminal projection,
applies Favorites progress, rotates credentials, acknowledges registration and
then requests an actual source-bound creation through the Broker owner route.
At refusal, feature charge is 8246505 bytes and remaining reserved allowance is
1156650 bytes. All six requests return 409
`succession_projection_capacity_exceeded`, with two measurement calls, 30 quote
calls and zero commit, transaction, sync, SQL or native-create effect entries.
This is refusal by the real admission path, not a codec-only estimate.

A trigger rejects late Favorites progress after a successful freeze upsert and
the actual transaction rolls back. Hold/reject gates run after the real
`storage.sync()`; they do not delay physical flush. Rejection is unknown
durability, not rollback. Restore-constructor SQL is attributed separately from
the held commit. All sequences compare complete exposed and reopened snapshots
and remove their owned state directory.

## Measured durations

Values are milliseconds, minimum / median / maximum of exactly three nominal
samples from the corrected attribution run. Later finalizer regressions use the
same frozen inputs without replacing or reaggregating these measurements.

| Case | Warm update or four-action chain | Validated Worker restart readback |
| --- | ---: | ---: |
| S | 2.51 / 2.79 / 3.03 | 6.73 / 7.95 / 17.24 |
| M | 10.89 / 12.48 / 15.93 | 25.70 / 26.19 / 27.57 |
| B0 | 18.13 / 18.28 / 19.71 | 36.19 / 36.29 / 41.07 |
| B1 | 16.26 / 18.65 / 20.01 | 35.55 / 36.73 / 39.23 |
| L | 135.75 / 138.92 / 192.71 | 155.49 / 171.69 / 175.82 |
| O | 182.46 / 183.60 / 243.59 | 182.44 / 184.13 / 200.84 |

Warm timing includes dispatch and response body. The L/O four-action chain
excludes connection, inspections and refusal. Restart readback excludes
Miniflare disposal/reconstruction and its disposed-file probe. Inspections and
instrumentation can affect scheduling/GC; their overhead was not independently
measured. Three samples establish neither p99, throughput, SLO nor a latency limit.

## Verification and boundaries

The reviewed final source passed 24 operating sequences, five failure-finalizer
checks and production/fixture typechecks in Root's independent bounded run.
The unchanged accounting fixture separately passed 27 checks. The ordinary test
entry constructs its data and owned temporary output; an explicit measurement
run requires paired input/output paths and verifies the frozen dataset identities.
Missing measurement inputs fail rather than silently skipping or regenerating.

The finalizer preserves primary, cleanup and evidence-write causes in order.
Cleanup rejection still attempts sample persistence. A real EISDIR failure
verifies unwritable-output behavior, without claiming a saved file when writing
is impossible. Hard process death cannot guarantee JavaScript finalization.

Transport is actual Miniflare Worker dispatch with SQLite and a fake RelaySocket
Host peer. Restart is dispose/recreate, not OS crash or power loss. No real Host
or native provider was run. Node CPU/heap/RSS points measure the harness, not the
Worker isolate. Owned-file lengths are apparent bytes, not allocated blocks,
peak memory, storage reservations or proof of WAL checkpoint. Production resource
telemetry, native certification and full product acceptance remain separate gates.
