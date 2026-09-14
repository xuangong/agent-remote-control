# Cloudflare and Docker Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Run the authenticated Relay at `agents.xianliao.de5.net` as an independent Cloudflare Worker and support Node Docker and local workerd Docker.

**Architecture:** One hosted Relay core owns business behavior. Node and Workers adapters supply HTTP, WebSocket, durable state, and scheduling. One stable SQLite-backed DO coordinates a Relay deployment; Gateway remains the separate identity authority.

**Tech Stack:** TypeScript, Web Request/Response, Node 22+, ws, Workers/DO SQLite, pnpm 10.34.5, Wrangler/workerd, Docker Compose, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-relay-runtime-design.md`

## Global Constraints

- Production origin: `https://agents.xianliao.de5.net`; no dependency on an SSH relay in CFW mode.
- Existing Host uplink and Remote HTTP/WS schemas, authentication proof bytes, quotas, and native adapter boundaries remain compatible.
- Runtime dependencies do not import Gateway source, packages, or credentials.
- One canonical Gateway issuer and one coordination object per Relay deployment; independent deployments do not synchronize state.
- Standard WebSocket first; no idle hibernation savings or horizontal sharding claims.
- Preserve 60-second renewal, maximum 120-second leases, and failed-authority denial.
- Commit security-sensitive state before native dispatch or success; unknown creation outcomes retain quota.
- Code, comments, docs in English; Chinese user communication.
- Use existing dedicated worktrees, preserve other services/material, and do not merge/push/deploy without the appropriate deployment step.
- Every test uses per-test/operation deadlines and an outer deadline. Use real HTTP/WS for protocol/auth/reconnect tests.
- Final implementation runs compatibility:update then compatibility:check.

## Task 1: Extract the portable Host broker and retain Node compatibility

**Files:** create `packages/agent-remote-hosted/package.json`, `tsconfig.json`, `src/broker.ts`, `src/transport.ts`, `src/host-sharing.ts`, `src/index.ts`, `src/broker.test.ts`; modify lab `src/server/remote-host-broker.ts`, `host-sharing.ts`, and lab dependencies.

**Interfaces:** the core exports `createHostBroker`, `RemoteHostBrokerState`, a `RelaySocket` port (readyState, bufferedAmount, send, close, event subscriptions), and `BrokerRequestContext` with principal/authorization/expiry functions. HTTP uses `Request` and returns `Response | undefined`. Node wrapper continues exporting `createRemoteHostBroker(options)` with install/server behavior for existing callers. Core upgrade preparation returns an accept callback only after access checks and native recovery, with explicit HTTP rejection otherwise.

- [ ] Write a failing portable broker behavior test that issues a pairing `Request`, connects a transport pair, registers a Host using real protocol messages, and reads its catalog through RPC. Assert returned identity and native request body using literal expectations.
- [ ] Execute it under `python3 /tmp/arc-deadline.py 120 ... vitest run ... --testTimeout=10000 --hookTimeout=10000`; record missing portable entry failure.
- [ ] Move broker/sharing business code into the package and replace Node request/response/socket coupling with the ports. Node crypto is permitted behind `nodejs_compat` if byte-level behavior remains tested; Node HTTP/fs/ws imports are not permitted in the core.
- [ ] Keep synchronous persistence behavior during this extraction; Task 2 upgrades its atomicity. Keep local access policy enforcement in the Node wrapper, not the hosted core.
- [ ] Run the portable behavior test plus existing broker, sharing, Gateway HTTP/WS tests and package/lab type checks. Commit the extraction with RED/GREEN evidence in the report.

## Task 2: Portable hosted authentication and durable mutation boundaries

**Files:** create hosted `src/gateway.ts`, `auth.ts`, `sessions.ts`, `control.ts`, `authority.ts`, `state.ts`, `scheduler.ts`, targeted tests; modify extracted broker/sharing and lab Gateway wrappers.

**Interfaces:** `createHostedRelay(options)` receives `{origin, issuer, secret, storage, scheduler}`; it exposes `fetch(Request): Promise<Response | undefined>`, authorized socket preparation, `refresh(): Promise<void>`, and `close()`. `RelayStateStore` has versioned initial state and an awaited atomic commit. Node file adapter preserves existing signed-state decoding. `RelayScheduler` schedules the next due deadline and can be canceled. The Workers adapter invokes refresh from its alarm.

- [ ] Add failing tests for a deferred/failed quota commit preventing native create, failed sharing commit preventing newly authorized traffic, restart-preserved login challenges, and consumed control proofs rejected after restart.
- [ ] Capture RED with bounded tests; implement durable staged state transitions with a short mutation gate. Never hold a gate across an awaited Host RPC response.
- [ ] Move auth/session/control logic to portable requests, preserving exact cookie flags, challenge handling, subject namespace, Origin checks, authority proofs, and error contracts. Use asynchronous Web Crypto or compatible node crypto with conformance tests.
- [ ] Route the existing Node hosted entry through the core. Persist expiring challenges and proof IDs, and migrate old Node state explicitly. Fail on storage corruption/config mismatch and close access on unrecoverable persistence failure.
- [ ] Verify all existing lifecycle/sharing tests plus new storage-failure and restart tests; commit with evidence.

## Task 3: Native Cloudflare Worker, SQLite DO, and runtime contract tests

**Files:** create `packages/agent-remote-cloudflare/package.json`, `tsconfig.json`, `wrangler.jsonc`, `src/worker.ts`, `src/relay-object.ts`, `src/storage.ts`, `src/socket.ts`, `test/runtime.test.ts`, `.dev.vars.example`; add root bounded test entry.

**Interfaces:** Worker serves static Controller assets and forwards dynamic routes to the private `RELAY` binding using `getByName('primary')`. `RelayObject` implements fetch/alarm and owns one hosted core. Store versioned typed records in SQLite, not one oversized snapshot value. Expose no public direct DO identity/subject bypass.

- [ ] Add a real Miniflare/workerd test for `/health`, browser-bound login, Host registration, RPC catalog, and bidirectional Controller stream; expect the absent Worker to fail before implementation.
- [ ] Configure independent application `agent-remote-control`, custom domain `agents.xianliao.de5.net`, SQLite migration, static assets, and `nodejs_compat` where required. Keep secrets in platform bindings; examples contain placeholders only.
- [ ] Implement native WebSocketPair adaptation with payload/backpressure checks and bounded active request timers. Reject unauthorized upgrades before acceptance. No Node HTTP emulation.
- [ ] Implement durable record commits and idempotent earliest-deadline alarms. Persist configuration fingerprint and reject mismatches, restore bindings offline, and allow Host/client reconnect after object replacement.
- [ ] Exercise shared-host isolation, concurrent quota, unknown creation, logout/revoke, alarm duplicate/delay, and persisted restart with the actual Workers adapter. Run dry-run bundling and types. Commit with evidence.

## Task 4: Docker packaging and paired Gateway deployment configuration

**Files:** create ARC `Dockerfile`, `.dockerignore`, `compose.yaml`, `deploy/relay.env.example`, `deploy/gateway.env.example`, `scripts/relay-local.mjs`; modify root scripts and deployment doc. Modify Gateway `vnext/docs/agent-remote-relay.md` and add explicit local Docker integration examples as needed.

**Interfaces:** Node image starts a built entry without tsx or provider CLIs. Compose `node` and `workers` profiles are mutually selected and use an explicitly supplied Gateway image. Shared network namespace makes canonical loopback origins reachable by the browser and both containers. Persistent volumes remain separate between runtime profiles.

- [ ] Add launcher tests that reject missing/ambiguous runtime selection, preserve configured free ports, and emit origins with the correct matching services.
- [ ] Build production Node bundle and Controller assets. Package a Node runtime image and a local Wrangler image with pinned tool versions. Neither imports a sibling checkout at runtime.
- [ ] Configure health checks, restart policy, loopback-published development ports, independent volumes, and local bindings without remote resources. Print Gateway entry and Controller URL only after bounded readiness checks.
- [ ] Add concrete production configuration examples using `agents.xianliao.de5.net` and canonical issuer `token.xianliao.de5.net`; document choosing another issuer as an explicit configuration change.
- [ ] Build/run/restart both Docker profiles using local test Gateway identities and a scripted WS Host. Update Gateway instructions and commit each project's changes separately.

## Task 5: Whole-runtime verification and deployment handoff

**Files:** `scripts/test-gateway-relay.mjs`, shared transport fixtures, runtime tests, both deployment docs, this plan.

- [ ] Run the same cross-project Chromium flow against Node and local workerd, including selected Host, shared catalog, cumulative quota, retry, restart and revocation. Save evidence without tokens/transcripts.
- [ ] Run ARC workspace build/type checks and relevant tests with deadlines; run compatibility:update/check after reviewed changes. Run Gateway checks for its changed files and Cloudflare dry-run.
- [ ] Review the complete diff for bypasses, failed-commit side effects, stale authority, transient operation replay, Docker reachability, and accidental private dependency inclusion. Address important findings and reverify the changed surface.
- [ ] Document measured validation and remaining cloud-only checks. Prepare exact Wrangler/domain/secret instructions; ask the user only for unavailable account access or the actual external deployment step when required.
- [ ] Mark tasks complete only with evidence. Leave unrelated branches, services, and worktrees intact.
