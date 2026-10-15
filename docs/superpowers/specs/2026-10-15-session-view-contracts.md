# Session View Contract Cleanup

The user approved the assessed D3 -> D2 -> D1 -> D4 sequence. This document records that accepted design for implementation and review.

## Boundaries

Provider-native interpretation stays in adapters. The SDK expresses native capabilities; Host owns authority, candidate persistence and succession. Browser storage owns persistence; Lab composition owns draft coordination and navigation. Public Remote wire and existing persisted formats remain compatible.

Work continues in `.worktrees/session-view-rewind`, preserving the existing uncommitted R1-R3 corrections. No commit, push, merge, publication, deployment, real-session mutation, or existing-service restart is part of this work. Task snapshots and incremental review diffs separate these changes from the baseline.

## D3: Explicit retained operation identity

The dialog-facing succession interface accepts the retained prepare request on every action. The Lab facade maps cancel to the existing complete original-request payload; other actions retain their existing operation-ID-only wire format. Independent context/status queries keep their lower-level API. ARDB reads operation ID and expected revision from the supplied request, without reading Lab recovery storage or depending on prior prepare calls in the adapter instance.

Description caching may still validate preparation. Navigation and target following remain in Lab composition. Commit retains source authority checks; status, reconcile and cancel can recover the original operation after its source retires.

## D2: Composer-owned restoration receipts

A Lab composition owner binds DraftStore and the image writer. It captures and compares ownership, applies a replacement, and reports actual text/image mutation tokens and separate persistence outcomes. The Web image writer exposes its actual local application receipt even if later saving fails or ownership changes. Tokens identify the application at mutation time, never a later arbitrary snapshot.

The prompt operation hook retains operation identity, source/target authority, target waiting, durable intent, terminal state and snapshot cleanup. It neither predicts revision increments nor interprets synchronous editor text callbacks. Same-content newer edits, reload ownership, partial saves, retired recipients and cross-await checks remain protected. Text and image storage are not an atomic transaction.

## D1: Complete optional native-prefix capability

AgentProviderAdapter gains an optional complete native-prefix capability: bounded candidate identity, validate, create with a required awaited checkpoint, and verify. Codex/OpenCode implement it; Host directories, local runtime and wrappers consume/forward it. Unsupported providers remain valid adapters.

The SDK contains only provider-native inputs and evidence, without Remote roles, Controller identity, store objects or directory authority. Native attachment evidence stays on AgentSession. Existing non-durable convenience fork calls remain separate. Durable creation must checkpoint the exact original handle before bootstrap/readback; unknown recovery cannot create another candidate. Contract tests verify ordering and rejection, because types cannot prove await behavior.

## D4: Explicit stored Team and recipient projection boundaries

Hosted internal APIs distinguish stored role anchors, projected current recipients and frozen delivery recipients. Client projection reads explicitly by Team ID. Stored paths read stored records directly. Recipient resolution names its anchor input. The existing single projection function stays central, and the helper stripping private evidence is named accurately.

Public schema, storage JSON and Host/UI consumption stay compatible. Merely adding structurally identical type aliases is insufficient. Preserve permission filtering before legacy compatibility rejection, and preserve unknown delivery without replaying to a successor.

## Verification

Use behavioral tests with per-test/hook and outer process deadlines. Each task receives independent spec and quality review before the next implementation starts. Final verification includes affected package types, scoped integration/browser tests, SDK declaration/package closure for D1, and `pnpm compatibility:update` followed by `pnpm compatibility:check`. Existing passing evidence is a baseline, not a new result.
