# O3 and O6: succession seam tests, mutation mapping (2026-11-19)

Scope: the 53 Controller tests of `session-succession-runtime.test.ts` that started a real Relay Broker. They moved to `agent-remote-seams/tests/S2/succession-*` (O6). This file records which of them were deleted, with the owner tests that catch what they caught, and which stay.

## Method

One-line mutations (negate an `if`, flip `===`/`!==`, swap `&&`/`||`, swap `return true/false`, delete a statement) were applied to the owner modules, one at a time, in a copy of the worktree. For each mutation the failing tests were recorded in three groups: the 53 moved tests, the owner tests (Controller tests that do not start a Relay; for the Relay module, the relay-core tests), and the rest. Sampled: every 3rd to 6th mutation of `session-succession-service`, `session-succession`, `session-succession-boundary` and the Relay's `succession-service`; all 86 of `session-succession-enrollment`. A mutation that makes a test time out counts as caught (timeout 800 ms; a baseline run without a mutation had 0 failures).

First result: `session-succession-enrollment.ts` (the Controller's side of the enrollment rpc, 231 lines) had no unit test. Of the 15 mutations first sampled in it, 1 was caught by a Controller test that does not start a Relay; the rest were caught only by the 53 seam tests. It now has `session-succession-enrollment.test.ts` (30 tests, 0.4 s, no Relay: the frames the Relay would send, a freeze built from a describe answer). After it, 86 of 86 enrollment mutations: 60 caught by it (11 by other Controller tests as well), 0 caught only by a seam test, 21 caught by nothing (mostly statement deletions whose effect no test observes, recorded below as blind spots).

All mutations: 158 valid, 129 caught by an owner test, 29 caught by no owner test, and none of those is caught by a seam test either. So every one of the 53 moved tests catches only mutations that an owner test also catches. The Relay module's owner tests are the relay-core tests (`succession-service`, `succession-replay`, ...) and only 7 of its mutations were valid, so the Relay side is a sample, not a proof.

## Deleted: old test -> owner tests that catch the same mutations

Rule: a test is deleted only if every mutation it catches is also caught by an owner test. 38 tests (31 blocks) deleted.

| Moved test (deleted) | Mutations caught | Per module | Owner tests that catch the same (file, mutations) |
|---|---|---|---|
| association: a competing edit between describe and reserve rejects before persisting a stale Host clock | 61 | enrollment 35, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (35); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: a current-B native reader stays fixed until the next B-to-C frozen enrollment | 57 | enrollment 31, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (31); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: an unknown native creation without a result witness stays frozen and is never recreated | 8 | enrollment 3, service 2, coordinator 1, boundary 1, relay-service 1 | native-prefix-role-runtime.test.ts (4); session-succession-directory.test.ts (4); session-succession-providers.test.ts (4); session-succession-recovery.test.ts (4) |
| association: broker binding persistence failure recovers from the Host result after broker restart | 17 | enrollment 11, service 2, coordinator 1, boundary 1, relay-service 2 | session-succession-enrollment.test.ts (11); directory-source-create.test.ts (6); native-prefix-role-runtime.test.ts (4); session-succession-directory.test.ts (4) |
| association: cancelling the first reservation restores ordinary relationship updates | 32 | enrollment 24, service 2, relay-service 6 | session-succession-enrollment.test.ts (24); succession-replay.test.ts (6); succession-service.test.ts (6); native-prefix-relations.test.ts (4) |
| association: concurrent exact same-ID relation describes join the saved operation before catalog drift checks | 61 | enrollment 35, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (35); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: durable exact pre-effect reset fences a delayed absent operation before reserve and after restart | 61 | enrollment 35, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (35); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: fresh relation reserve refuses transient A and preserves exact concurrent durable identity | 64 | enrollment 37, service 8, coordinator 8, boundary 5, relay-service 6 | session-succession-enrollment.test.ts (37); session-succession-runtime.test.ts (19); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: fresh relation reserve refuses transient B and preserves exact concurrent durable identity | 64 | enrollment 37, service 8, coordinator 8, boundary 5, relay-service 6 | session-succession-enrollment.test.ts (37); session-succession-runtime.test.ts (19); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: fresh relation reserve refuses transient side and preserves exact concurrent durable identity | 64 | enrollment 37, service 8, coordinator 8, boundary 5, relay-service 6 | session-succession-enrollment.test.ts (37); session-succession-runtime.test.ts (19); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: fresh relation reserve rejects a restored persistent old-source reservation without a transient fence | 60 | enrollment 33, service 8, coordinator 9, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (33); session-succession-runtime.test.ts (19); session-succession-recovery.test.ts (17); session-succession-providers.test.ts (16) |
| association: lost relation_apply response keeps exact operation recoverable across both restarts | 62 | enrollment 36, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (36); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: lost relation_release response keeps exact operation recoverable across both restarts | 62 | enrollment 36, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (36); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: lost relation_reserve response keeps exact operation recoverable across both restarts | 63 | enrollment 37, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (37); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: metadata persistence failure after Host reserve remains recoverable without false success | 62 | enrollment 36, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (36); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: missing durable grant rejects reserve and retains the exact Broker edit for later reconcile | 62 | enrollment 36, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (36); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| association: native source creation and succession freeze have symmetric admission fences | 43 | enrollment 23, service 8, coordinator 4, boundary 3, relay-service 5 | session-succession-enrollment.test.ts (23); session-succession-runtime.test.ts (13); session-succession-recovery.test.ts (12); native-prefix-role-runtime.test.ts (11) |
| association: relation persistence admission precedes async store publication and blocks a reader handoff | 64 | enrollment 36, service 8, coordinator 10, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (36); session-succession-runtime.test.ts (20); session-succession-recovery.test.ts (18); session-succession-directory.test.ts (17) |
| enrollment: a full Host and broker restart safely rejects a known candidate when capture cannot be revalidated | 60 | enrollment 30, service 8, coordinator 13, boundary 3, relay-service 6 | session-succession-enrollment.test.ts (30); session-succession-runtime.test.ts (22); session-succession-recovery.test.ts (21); session-succession-directory.test.ts (17) |
| enrollment: broker persistence failure keeps a committed Host decision fenced across restart | 54 | enrollment 29, service 8, coordinator 7, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (29); session-succession-runtime.test.ts (17); session-succession-providers.test.ts (15); session-succession-recovery.test.ts (15) |
| enrollment: cancellation serializes ahead of a delayed pre-begin grant snapshot | 40 | enrollment 28, service 5, coordinator 1, relay-service 6 | session-succession-enrollment.test.ts (28); native-prefix-role-runtime.test.ts (6); succession-replay.test.ts (6); succession-service.test.ts (6) |
| enrollment: concurrent different provider cannot reuse one frozen operation identity | 38 | enrollment 21, service 6, coordinator 4, boundary 2, relay-service 5 | session-succession-enrollment.test.ts (21); native-prefix-role-runtime.test.ts (10); session-succession-runtime.test.ts (10); session-succession-recovery.test.ts (9) |
| enrollment: concurrent different revision cannot reuse one frozen operation identity | 38 | enrollment 19, service 7, coordinator 5, boundary 3, relay-service 4 | session-succession-enrollment.test.ts (19); session-succession-runtime.test.ts (13); session-succession-recovery.test.ts (12); native-prefix-role-runtime.test.ts (11) |
| enrollment: concurrent different source cannot reuse one frozen operation identity | 38 | enrollment 19, service 7, coordinator 5, boundary 3, relay-service 4 | session-succession-enrollment.test.ts (19); session-succession-runtime.test.ts (13); session-succession-recovery.test.ts (12); native-prefix-role-runtime.test.ts (11) |
| enrollment: old operation replay preserves A to B to C | 53 | enrollment 27, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (27); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| enrollment: past and future expected revisions fail before any broker freeze or Host preparation | 53 | enrollment 27, service 8, coordinator 8, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (27); session-succession-runtime.test.ts (18); session-succession-providers.test.ts (16); session-succession-recovery.test.ts (16) |
| enrollment: pre-begin validation failure can be durably cancelled without late preparation effects | 35 | enrollment 27, service 2, relay-service 6 | session-succession-enrollment.test.ts (27); succession-replay.test.ts (6); succession-service.test.ts (6); native-prefix-relations.test.ts (4) |
| enrollment: pre-role retained queued input blocks enrolled first enablement | 44 | enrollment 28, service 5, coordinator 4, boundary 2, relay-service 5 | session-succession-enrollment.test.ts (28); native-prefix-role-runtime.test.ts (11); session-succession-recovery.test.ts (10); session-succession-runtime.test.ts (9) |
| enrollment: public context status reads durable Host state and requires native materialization across reconnect | 63 | enrollment 30, service 9, coordinator 9, boundary 9, relay-service 6 | session-succession-enrollment.test.ts (30); session-succession-runtime.test.ts (25); session-succession-providers.test.ts (22); session-succession-recovery.test.ts (19) |
| enrollment: public description validates authority and source, exposes blocking facts and never creates a candidate | 54 | enrollment 27, service 10, coordinator 7, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (27); session-succession-runtime.test.ts (17); session-succession-recovery.test.ts (16); session-succession-service.test.ts (16) |
| enrollment: replacing the association authority never takes over a previously bound role | 49 | enrollment 26, service 8, coordinator 6, boundary 3, relay-service 6 | session-succession-enrollment.test.ts (26); session-succession-runtime.test.ts (15); session-succession-recovery.test.ts (14); session-succession-directory.test.ts (13) |
| succession-native-prefix.integration.test.ts > native prefix original cancel reaches the real Host with no preparation progress or fork | 32 | enrollment 25, service 2, relay-service 5 | session-succession-enrollment.test.ts (25); succession-replay.test.ts (5); succession-service.test.ts (5); native-prefix-relations.test.ts (3) |
| succession-native-prefix.integration.test.ts > native prefix v3 rejects an insufficient projection allowance before native effect | 31 | enrollment 19, service 5, coordinator 2, boundary 1, relay-service 4 | session-succession-enrollment.test.ts (19); native-prefix-role-runtime.test.ts (8); session-succession-recovery.test.ts (7); session-succession-runtime.test.ts (6) |
| negotiation: authenticated committed output invariant errors preserve complete evidence and never become pre-effect refusal | 55 | enrollment 30, service 8, coordinator 7, boundary 4, relay-service 6 | session-succession-enrollment.test.ts (30); session-succession-runtime.test.ts (17); session-succession-providers.test.ts (15); session-succession-recovery.test.ts (15) |
| negotiation: authenticated v2 retries reject missing invalid or changed ceilings without another native creation | 38 | enrollment 19, service 7, coordinator 5, boundary 3, relay-service 4 | session-succession-enrollment.test.ts (19); session-succession-runtime.test.ts (13); session-succession-recovery.test.ts (12); native-prefix-role-runtime.test.ts (11) |
| negotiation: public projection rejection is pre-effect and leaves the durable Relay freeze safely cancellable | 42 | enrollment 28, service 5, coordinator 2, boundary 1, relay-service 6 | session-succession-enrollment.test.ts (28); native-prefix-role-runtime.test.ts (8); session-succession-recovery.test.ts (7); session-succession-runtime.test.ts (6) |
| tpm: unknown TPM creation retains exact admission and paused work without browser bindings (existing role false) | 52 | enrollment 36, service 5, coordinator 4, boundary 1, relay-service 6 | session-succession-enrollment.test.ts (32); session-succession-runtime.test.ts (12); native-prefix-role-runtime.test.ts (10); session-succession-recovery.test.ts (9) |
| tpm: unknown TPM creation retains exact admission and paused work without browser bindings (existing role true) | 52 | enrollment 36, service 5, coordinator 4, boundary 1, relay-service 6 | session-succession-enrollment.test.ts (32); session-succession-runtime.test.ts (12); native-prefix-role-runtime.test.ts (10); session-succession-recovery.test.ts (9) |

## Kept as wiring: Relay-built frames and the handshake

Every one of these also catches only owner-caught mutations (so they could be deleted by the rule), and stays by decision: they are the real Controller against the real Broker, the only place where a frame the Relay builds (freeze v1, v2, v3, relations, relation_reserve/apply/release, source-result, cancel, TPM participants) is read by the Controller's validator, and where the handshake (enrollment version, installation, allowance) is negotiated. Neither side's owner tests can fail when the two drift apart, and a mutation set of one module cannot show that. They are the contract tests of this seam.

| Kept test | Mutations caught | Path through the pair |
|---|---|---|
| association: cold complete grants enroll only linked direct readers and preserve immutable provenance | 53 | Relay-built relations in a freeze |
| association: lost source creation response recovers its original durable result without native replay | 40 | create rpc, source-result, rpc timeout |
| association: trusted postcommit unlink and relink reconcile cold direct readers and keep nested Ask fixed | 64 | relation_reserve, relation_apply, relation_release |
| enrollment: authenticated broker enrollment derives a role, freezes associations and commits over a real uplink | 52 | describe, prepare, commit, release (freeze v2) |
| enrollment: mismatched Controller or unnegotiated peer fails before native creation: {"enrollment":false} | 1 | installation and enrollment negotiation |
| enrollment: mismatched Controller or unnegotiated peer fails before native creation: {"installationId":"foreign"} | 4 | installation and enrollment negotiation |
| enrollment: real HTTP and WebSocket cancel a blocked create without activating its late candidate | 54 | create rpc, cancel while creating |
| enrollment: real uplink authorizes snapshot provenance on its source provider and retains both create identities | 5 | source provider authorization of a create |
| succession-native-prefix.integration.test.ts > native prefix enrolled Host blocks WebSocket input and background dispatch throughout projection gap | 55 | freeze v3 |
| negotiation: negotiated v2 saves an exact ceiling and unsupported producer certification refuses before create | 32 | exact projection ceiling |
| negotiation: new Host retains ordinary connection when preparation cannot be negotiated or admitted: {"legacyRelay":true} | 1 | no allowance, legacy Relay |
| negotiation: new Host retains ordinary connection when preparation cannot be negotiated or admitted: {"noAllowance":true} | 4 | no allowance, legacy Relay |
| negotiation: old Host on upgraded Relay is legacy-recovery-only and gets no strict v2 acknowledgment field | 4 | freeze v1 and no v2 acknowledgment |
| negotiation: saved bounded recovery is explicitly unavailable on an old Relay while ordinary connection and records remain intact | 47 | old Relay without bounded recovery |
| tpm: completed persisted TPM is enrolled without attaching its native session | 33 | TPM participants in a freeze |

## Mutations no test catches (blind spots of the whole suite)

29 mutations are caught by no test, owner or seam. Most are deleted statements and flips whose effect nothing observes; some are equivalent mutations. They are not covered by the moved tests either, so deleting those did not widen them. By id (module:line:kind): enrollment:42:delete-stmt, enrollment:53:delete-stmt, enrollment:62:and-or, enrollment:73:delete-stmt, enrollment:82:delete-stmt, enrollment:92:or-and, enrollment:97:delete-stmt, enrollment:120:eq-flip, enrollment:144:delete-stmt, enrollment:147:delete-stmt, enrollment:164:delete-stmt, enrollment:174:delete-stmt, enrollment:179:delete-stmt, enrollment:184:negate-if, enrollment:197:delete-stmt, enrollment:198:eq-flip, enrollment:211:negate-if, enrollment:212:delete-stmt, enrollment:213:delete-stmt, enrollment:216:delete-stmt, enrollment:217:delete-stmt, service:108:delete-stmt, service:113:delete-stmt, service:129:and-or, service:147:and-or, service:178:or-and, coordinator:56:delete-stmt, boundary:243:negate-if, boundary:374:negate-if.

## O3: decisions for the remaining succession and gateway groups

Counts are real test counts from a package run (it.each variants counted). Decision classes: main flow (an e2e flow covers it, lower duplicates go), seam (seams package with mock data, the slower copy goes), duplicate of an owner unit test (deleted after a mutation check), unique wiring (kept, reason recorded).

| Group | Tests | Decision | Reason |
|---|---|---|---|
| Moved succession tests (O6), `tests/S2/succession-*` | 53 | 38 deleted (duplicate of owner unit tests, mutation-checked), 15 kept (unique wiring: contract) | see the two tables above; E5 (3 flows) is the main flow and is not duplicated by them (E5 asserts the page; these assert the frames) |
| relay-core `succession-replay` | 96 | kept, unique wiring | `createHostedRelay` over HTTP and WebSocket with the saved state as a file: route, account namespace, cookie, persistence and restart together. A mutation survey of the Relay's `succession-service` (22 valid mutations, every 4th; 11 caught by the owner unit tests, 6 by nothing) shows 26 of the 60 replay tests that catch anything catch a mutation no owner unit test catches (kept with proof). 34 catch only owner-caught mutations, but 27 of those assert rules owned by modules not mutated here (`session-bindings` source claims, Team receipts, star capacity), so the rule cannot be applied to them. 7 are candidates for deletion once the full set of 92 mutations is run: `rejects malformed authenticated readback...`, `cannot report cancellation when its durable fence cannot be written`, `requires revision headroom for the final cancellation...`, `refuses a stale immutable quote after an ordinary star overtakes it...`, `keeps an admitted exact freeze when the Controller declines its participant projection ceiling`, `rejects delayed describe after Host generation changes...`, `maps ordinary star capacity refusal...` (each catches 4 to 8 sampled mutations, all owner-caught). It also still opens real ports (authority and listener servers); an in-memory network is open work |
| relay-core owner unit tests (`succession-service` 12, `succession-capacity` 24, `state-succession` 6, `session-successions` 4, `broker-state` 12) | 58 | owner tests | the modules' own tests; out of scope |
| relay-core `gateway-*` (23 files) | 81 | unique wiring | one persistence and route smoke per feature (route, account scope, restart), ported from the Worker tier; no owner unit test states them. Not mutation-checked |
| relay-core `gateway.test` | 12 | unique wiring | `createHostedRelay` composition (authority, lease, cookies) |
| relay-core `broker.test`, `broker-heartbeat` | 88 | unique wiring | `createHostBroker` composition with browser streams; the 10 that duplicated `host-session` were deleted in M11 |
| relay-core `broker-journal*`, `broker-timeline-admission` | 84 | unique wiring | Broker, journal service and browser channel together; the journal rules have S2 and journal-service tests, but no mutation survey of those owners was run, so none is deleted |
| Node Relay `gateway-*` | 49 | unique wiring | the Node host's own authority lease, state file, bootstrap and process exclusion |
| Node Relay `succession-revocation` | 20 | unique wiring | revocation across restart and open sockets on the Node host |
| Node Relay `hosted-runtime` | 8 | unique wiring | the 8 MiB state ceiling and the Node entrypoint authentication; the near-ceiling pair is not duplicated by relay-core (it checks the file on disk) |
| Node Relay `remote-host-broker`, `broker-lifecycle` | 20 | unique wiring | the Node uplink broker over a real port; the slowest test loaded three packages inside its own time (1.9 s, over the 1 s gate in the baseline run) and now loads them at the top of the file |

Totals for the groups above: moved 53, deleted 38, kept as wiring 15 + 96 + 81 + 12 + 88 + 84 + 49 + 20 + 8 + 20 = 473, owner tests 58 (not decisions). The wiring groups other than the moved ones were decided by file, with the reasons above, not by a mutation survey of their owners.

## O3 remainder: mutation census of the gateway and broker owners (final slice)

Run on a detached copy of dc6c1b44, every mutation reverted before the next. A regex generator made one-line mutations (negate an `if`, drop a guard, flip a comparison, swap `&&` and `||`, flip a returned boolean, add 1 to a constant, drop a call), taking every Nth site of each module, N from 3 to 64 by module size (about 6 to 18 sites each). Each mutation ran the module's owner unit tests and every `gateway-*` and `broker*` file of relay-core (`--testTimeout=5000`, outer 45 to 120 s), with failures read per test from the JSON reporter. About 100 minutes on a machine shared with another run.

**Modules (233 sites).** Without a unit test of their own: `gateway`, `broker`, `socket-edge`, `session-directory-routes`, `session-read-routes`, `host-service-routes`, `window-routes`, `controller-routes`, `preview-routes`, `team-routes`. With owner tests: `host-session`, `broker-state`, `client-admission`, `session-bindings`, `session-drafts`, `session-outbox`, `session-reads`, `session-migrations`, `session-stars`, `session-titles`, `session-identity`, `session-successions`, `journal-sessions`, `journal-session-stream`, `journal-host-stream`, `journal-partition`, `journal-deletion`, `journal-uplink`, `host-journals`, `pairing-routes`.

| Result | Mutations |
|---|---:|
| Completed (6 hung and are not counted) | 227 |
| Caught by an owner test | 89 |
| Caught only by gateway or broker tests | 54 (33 in modules with no unit test) |
| Caught by nothing | 84 |

**Per test.** Of the 265 gateway and broker tests, 94 catch a mutation (the per-file counts below; the census summary said 96) that no owner test catches (kept with proof; 30 of them only through a mutation that breaks more than 40 tests), 152 catch mutations only in modules that have no unit test (the only coverage; kept), 17 caught nothing in the sample (8 `gateway.test`, 8 `gateway-window-wait`, 1 `broker.test`) and are not judged. No test is a deletion candidate.

| Files | Unique against owner / only coverage / caught nothing |
|---|---|
| `broker.test` | 24 / 49 / 1 |
| `broker-heartbeat` | 4 / 10 / 0 |
| `broker-journal-sessions` | 10 / 17 / 0 |
| `broker-journal-switch` | 2 / 32 / 0 |
| `broker-journals`, `broker-journal-grant`, `broker-timeline-admission` | 0 / 23 / 0 |
| `gateway-*` feature files (21) | 54 / 13 / 0 |
| `gateway-window-wait` | 0 / 4 / 8 |
| `gateway.test` | 0 / 4 / 8 |

**Owner tests that miss what the wiring tests catch** (the next unit tests to write; then the wiring copies can be re-judged): `host-session` lines 200, 216, 261, 308, 322, 340, 355, 391; `session-bindings` 223, 431; `session-stars` 47; `session-titles` 12; `pairing-routes` 150, 175.

**`succession-service`, every site (233).** 113 caught by an owner test, 66 only by `succession-replay`, none only by gateway or broker, 54 by nothing. The 7 candidates of the O3 row are kept:

| Test | Mutations no owner unit test catches |
|---|---|
| `rejects malformed authenticated readback...` | line 103 (no other test fails on it), 124, 198 to 200 |
| `cannot report cancellation when its durable fence cannot be written` | line 146 (also 6 other replay tests) |
| `requires revision headroom for the final cancellation...` | line 46 (no other test fails on it) |
| `refuses a stale immutable quote...` | line 158, 124, 198 to 200 |
| `keeps an admitted exact freeze when the Controller declines...` | line 168, 124 |
| `rejects delayed describe after Host generation changes...` | only line 124 (the `successionEnrollmentVersion < 2` threshold), which 21 replay tests also catch: deletable once an owner unit test pins it |
| `maps ordinary star capacity refusal...` | lines 119, 158, 124, 198 to 200 |

**Caught by nothing** (some may be equivalent; clear gaps): `succession-service` 53, 146, 162 (association revision exhaustion), 78 (enrollment unavailable), 116, 168, 196, 202, 207; `host-session` 370 (provider management not advertised), 408 (credential capacity 128); `broker` 262, 354; `gateway` 380, 537 (origin check), 710 (command-line approval sign-in), 668, 933, 1143 (status and close codes); `session-bindings` 98, 134, 416, 467; `session-migrations` 13, 29; the authorization checks `session-directory-routes:51` and `session-read-routes:35`; `controller-routes:57`, `host-service-routes:118`, `team-routes:62`. Hung under mutation, not examined: `broker-state` 139, 148; `host-session` 90, 249, 284; `session-reads` 62.

Not judged: modules that were not mutated (`call-for-support`, `teams`, `preview-*`, `favorites`, access and authentication internals); tests that assert their rules cannot be ruled on by this census.

## Security checks pinned

The Relay checks that the "Caught by nothing" and "owner tests that miss" lists above left to wiring tests or to nothing are now held by owner unit tests (mock data, no socket, fake or manual clock; every new test under 100 ms). Each mutation below is the census's exact `after` line (or, marked "adjacent", a one-call removal next to it), run against the new test alone: the test fails with the mutation and passes without it. 43 tests were added in 10 files; 27 census mutations are caught, 15 adjacent mutations are caught, 2 are equivalent, 1 is judged not security-relevant. No bypass was found: every guard that was examined is effective, and removing it exposed data or an action that no other layer stopped.

| Site | Check | Mutation | Owner test | Caught |
|---|---|---|---|---|
| `host-session:200` | `registered` carries `outbox` only when the Host asked and the Relay serves one | flip-eq | `host-session.test` "acknowledges the outbox only when..." | yes |
| `host-session:216` | no diagnostic delivery (503) while the connection is backed up | drop-guard | "refuses diagnostic delivery while the connection is backed up..." (availability guard, not authorization) | yes |
| `host-session:261` | registering a device drops the installation's other keys and keeps other installations' | flip-eq | "keeps one device credential per installation..." (also 2 rotation tests) | yes |
| `host-session:308` | an invitation with a rotation is issued a device credential; a device is registered at once | flip-neq | "issues a device credential after an invitation...", "registers a device that rotates at once..." | yes |
| `host-session:322` | after the Controller saved the credential, the installation's other keys are deleted | flip-eq | "issues a device credential after an invitation..." | yes |
| `host-session:340` | an outbox answer goes only to the connection and generation that asked | negate-if | "delivers an outbox answer only on the connection and generation that asked" | yes |
| `host-session:355` | a browser stream opens only while its page may still use it | negate-if | "does not open a browser stream the page may no longer use..." | yes |
| `host-session:370` | provider snapshot refused (1008) from a Host that did not advertise provider management | drop-guard | "ignores a provider snapshot from a Host that did not advertise..." | yes |
| `host-session:391` | a 401 during a message closes with 1008, not a server failure | flip-eq | "closes with 1008 and the reason when a registration is no longer authorized..." | yes |
| `host-session:408` | at most 128 device credentials | drop-guard | "refuses a new device credential at 128 and issues one at 127" | yes |
| `pairing-routes:150` | smart-reading body needs a provider and a boolean, nothing else | or-to-and | `pairing-routes.test` "changes smart reading only for a body..." | yes |
| `pairing-routes:175` | account revocation only on an account-backed Relay, only POST to a revoke path | and-to-or | "serves the account revocation only to an account-backed Relay..." (and "lets only the owner of a shared Relay revoke...") | yes |
| `session-bindings:98` | a revoked binding is not reopened and the Controller is not asked | drop-guard | `session-bindings.test` "does not ask the Controller to reopen a session whose binding was revoked" | yes |
| `session-bindings:134` | a binding revoked while its reattachment waits to be saved is not restored | drop-guard | "does not restore a binding that was revoked while its reattachment was waiting..." | yes |
| `session-bindings:223` | the shared creation reserves quota before the Controller is asked | negate-if | "keeps a guest to the creation quota the Host owner granted" | yes |
| `session-bindings:431` | a creation source contradicting the native source identity is refused | flip-neq | "refuses a creation whose source contradicts its native source identity..." | yes |
| `broker:262` | a guest does not see a relation whose followed current source is the owner's session | drop-guard | `session-relation-projection.test` "a guest does not see a relation whose followed current source..." (a leak of the owner's session identity without the guard) | yes |
| `session-directory-routes:51` | a guest adds a reference only to a session it may open | drop-guard | `session-directory-routes.test` "lets a guest add a reference only to a session it may open..." | yes |
| `session-read-routes:35` | the answer is withheld when access was revoked during the read | drop-guard | `session-read-routes.test` "withholds the answer when the guest lost access while the Controller was reading" | yes |
| `controller-routes:57` | the Controller release lookup is the owner's | drop-call | `controller-routes.test` "shows the Controller release lookup to the owner..." | yes |
| `controller-routes:52, 74, 94` (adjacent) | `requireOwner` of succession, Controller update, provider settings | drop-call | "refuses a guest every succession action..." | yes (3) |
| `controller-routes:105` (adjacent) | owner and Host access rechecked after the Controller answers | drop-call (2) | "withholds the provider settings ... connection no longer belongs to the owner", "... Host was removed while it answered" | yes (2) |
| `controller-routes:52` (adjacent) | `requireAccess` before `requireHost` on succession | drop-call | none | equivalent: only the owner reaches it, an owner has access to every Host that exists, and `requireHost` refuses an unknown Host with the same status and code; differs only in the message (and 403 against 503 while the state is unavailable, both refusals) |
| `host-service-routes:118` | VS Code tunnel: GET to read, POST to start or stop, else 405 | drop-guard | `host-service-routes.test` "reads with GET and starts or stops with POST only..." | yes |
| `host-service-routes:116, 123` (adjacent) | `requireOwner` before, owner and Host access after the Controller answered | drop-call (3) | "is the owner's...", "withholds the Controller's answer when the connection no longer belongs to the owner", "... Host was removed while it answered" | yes (3) |
| `host-service-routes:116` (adjacent) | `requireAccess` before `requireHost` | drop-call | none | equivalent, same reason as `controller-routes:52` |
| `team-routes:62` | an unknown Team answers 404 before any access check | negate-if | `team-routes.test` "answers 404 for a Team that does not exist, and acts on one that does" | yes (the 404 itself is not an authorization check; the pin keeps the sequence) |
| `team-routes:35, 53, 54, 56, 57, 63` (adjacent) | owner only; access to the Team's Host and the member's Host before; owner and access again after the change | drop-call (7) | "are the owner's...", "refuses a Team whose Host the caller may not reach...", "refuses to add a member on a Host...", "does not answer a change when the connection stopped belonging to the owner...", "does not answer a member addition whose member Host went away..." | yes (7) |
| `gateway:537` | a request that did not arrive under the Relay's origin is refused (403) | drop-guard | `gateway-security-pins.test` "refuses every request that did not arrive under the Relay's own origin" | yes |
| `gateway:668` | sign-in session changes need a same-origin POST; anything else 403, no change | const+1 (the status) | "changes sign-in sessions only for a same-origin POST..." | yes |
| `gateway:710` | command line approval page: a person not signed in sees only "Sign in first", never the code or label; the approving POST answers 401 | drop-guard | "shows a person who is not signed in no command line approval..." (also caught by `cli-access.test`, which the census did not run). Not a bypass: the POST needs `authorize()` either way | yes |
| `gateway:380` | an owner the authority confirmed is trusted until the lease ends without asking again; after it, the authority decides | drop-guard | "trusts an owner the account authority confirmed until the lease ends..." | yes |
| `gateway:933` | a malformed session rename is a 400, never a 401 that a client reads as a sign-out | const+1 | "answers a malformed session rename with 400, which is not a sign-out" | yes |
| `gateway:1143` | close code 1008 when preview access is revoked | const+1 | none | not security-relevant: the revocation itself (abort and close) happens whatever the code; the code is the reason a client sees. Pinning it needs a full preview WebSocket flow through a Host bridge, so it is left to the preview tests |

Judgements: `host-session:216` and `:200` are availability and capability negotiation rather than authorization, and are pinned because the owner asked for all eight. `team-routes:62` runs after the owner check at line 35, so it is not an authorization decision by itself.
