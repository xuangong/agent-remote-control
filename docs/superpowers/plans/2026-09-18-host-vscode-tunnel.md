# Host VS Code Tunnel Implementation Plan

**Goal:** Let the Host owner start and stop a Controller-owned VS Code tunnel, complete device authorization in the browser, observe process/connection state, and open each session workspace.

**Architecture:** A Controller process manager owns one tunnel in the Controller state directory. Owner-only Host HTTP operations cross the existing RPC uplink. The frontend polls a typed snapshot and renders Host management plus session workspace links. Agent/provider sessions never own this process.

**Constraints:** Preserve existing tunnels and credentials. Use a dedicated CLI data directory, bounded output parsing, and private state. Do not persist device codes or forward raw logs/tokens. Controller stop or crash reclaims its process group. Short uplink loss preserves it; prolonged loss reclaims it after a configurable five-minute grace period. Missing CLI or tunnel subcommand disables the feature. A workspace link is not a filesystem sandbox. No deployment or production tunnel mutation during implementation.

- [x] Define the snapshot contract, URL helpers, and controller tests with real fixture processes: split stdout/stderr, authorization, readiness, duplicate starts, unexpected exit, stop escalation, and isolation.
- [x] Implement the process manager and CLI wiring; probe CLI JSON status independently of process liveness and keep stale links disabled.
- [x] Add owner-only GET/start/stop Host routes with mutation checks and uncached responses; test routing and rejected shared access.
- [x] Add a shared frontend state controller, compact Host management, authorization presentation, and session links; test polling, offline state, stale replies, and path encoding.
- [x] Run focused tests, typecheck/build, browser acceptance, compatibility checks, and docs lint. Document lifecycle and limitations.
