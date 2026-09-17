# Reusable Codex daemon client

## Purpose

Extract the Codex-native connection and recovery logic into `packages/codex-daemon-client` (`@agent-remote-controller/codex-daemon-client`). Another repository must be able to use or reference the package without depending on the Agent Provider SDK, Remote protocol, Relay, Web, or Host. The user approved this extraction after discussing these boundaries; implementation is authorized, publication and deployment are not.

## Boundary

The new package owns JSON-RPC transport, native initialization, reconnect scheduling and cancellation, generation fencing and stale connection disposal, native thread reattachment, authoritative history reads, and the ordering of snapshots and notifications during recovery. Codex-specific RPC methods and payloads belong here. Application timeline projection, Agent observations and descriptors, UI capabilities, identity/authorization and operation deduplication stay in existing packages.

Use explicit native types and narrow callbacks for consuming notifications, server requests, recovery invalidation and snapshot handoffs. Do not move SDK-shaped session objects into the package under new names. It is acceptable to retain application-specific child descriptors and observation bookkeeping in the Provider while the client owns native discovery/recovery data. A native thread registry/router can be included when it avoids duplicating the snapshot/discovery correctness rules; expose native IDs, metadata and raw events, never application Agent types.

## Preserved contracts

- Existing public Provider imports and the external Remote wire protocol remain compatible; use thin re-exports for moved transport primitives where needed.
- Private child-process transport remains supported and has its existing lifecycle; shared disposal never starts/stops the external daemon.
- Automatic reconnect preserves attached native thread identity; it never starts a replacement thread or replays a mutation.
- Recovery keeps authoritative snapshot cutoffs, post-snapshot deltas, server-request resolutions regardless of timeline cutoff, and buffered child discovery. Old-generation requests and callbacks become invalid.
- Preserve default retry delays (500 ms initial, 30 seconds maximum), 10-second connect deadline, 30-second restoration deadline, unlimited transient attempts by default, and four simultaneous root restorations within the existing Provider use. Make the concurrency scope explicit/injectable when extracting it.
- The package must let consumers supply their client initialization identity/capabilities; the Provider supplies its current identity to avoid an application name hidden in reusable code.
- Do not introduce persistence, automatic retry of uncertain mutations, new daemon ownership, a generic multi-provider framework or dependencies on sibling repositories.

## Reference usability

Document public entrypoints, lifecycle ownership, operation outcomes and the snapshot/event handoff contract. Include a small runnable or typechecked example that translates native data into an arbitrary application protocol without importing this repo's SDK or Relay. Raw transport consumers must understand that raw RPC access does not imply automatic mutation replay or safe application-level retries.

## Verification

Retain the existing real Unix recovery regressions and Provider-to-Manager/Wire cases. Add package-owned real transport tests for the independent consumer boundary, disconnect/reconnect, snapshot handoff, stale request invalidation and disposal. Prefer moving existing native-only tests/fixtures to their new owner and keeping application integration tests in the Provider. Verify the built package from a temporary consumer outside the workspace using its packed artifact; its runtime dependencies must resolve without workspace packages. Run affected tests with runner and outer deadlines, then workspace build/typecheck, compatibility and standalone Host packaging. Never run the package lifecycle test that modifies launchctl, and never restart live services.
