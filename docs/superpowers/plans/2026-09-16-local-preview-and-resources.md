# Local Preview and Markdown Resources Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent resource work and review, and executing-plans for the coupled tunnel integration. Execute all authorized work in this worktree.

**Goal:** Provide authenticated local HTTP/SSE/WebSocket previews and inline Markdown images from the Controller filesystem.

**Architecture:** Keep control and data connections separate. The Controller owns registrations and filesystem access; hosted Relay binds owner authentication to registered targets; browser renderers request resources and register ports only through explicit controls. Node and Workers adapt shared transport state machines.

**Tech Stack:** TypeScript, TypeBox, Node HTTP/HTTPS and ws, Web Streams, Workers Durable Objects, React 18, react-markdown 10.

**Spec:** `docs/superpowers/specs/2026-09-16-local-preview-tunnel-design.md`, its tunnel research companion, and `2026-09-16-markdown-local-resource-research.md`.

## Global Constraints

- Work only in this dedicated worktree. Do not modify production services, deploy, or push as part of implementation.
- Browser requests must retain existing Relay authorization; preview management is owner-only.
- Previews use the control origin by default; a separate origin remains configurable. Same-origin preview scripts are trusted with the control site privileges. Route by `/p/<id>/`, never infer a current preview from a cookie or Referer.
- Use binary streaming and bounded queues; preserve separate WS text/binary messages. Cancel interrupted operations instead of replaying them.
- Use Controller-owned fixed expiry, initially one hour with a configurable duration; retain bounded tombstones and reconcile after reconnect.
- Local files are session-scoped and canonicalized under authorized workspace roots. Do not expose arbitrary filesystem access to a shared session.
- All tests use runner deadlines and an outer subprocess deadline. Preserve protocol fixtures and compatibility metadata.

## Task 1: Markdown resource loading

**Files:** Existing resource protocol, Relay resource ingestion/session wire, Controller resource-reader integration, Web Markdown renderer and timeline resource context; new local-file-reader and image-resolver tests beside their modules.

**Interfaces:** Existing `ResourceBinding`, `ResourceState`, `requestResource(resourceId)` stay authoritative. Add a typed resolve operation only where an existing authorized binding is unavailable. Keep this independent from preview transport schemas and hosted broker changes; communicate any required owner gate before enabling arbitrary path resolution.

- [x] Write failing behavior tests: inline/reference images load real permitted bytes; code fences do not request; relative images use source context; foreign session, traversal/symlink escapes, oversized and unsupported files are denied.
- [x] Implement a pure rehype locator marker before URL filtering and a custom image component with shared request deduplication and stale-result fencing. Preserve safe ordinary links and scoped footnotes.
- [x] Connect permitted local file resolution and existing resource delivery. Keep filesystem interpretation at Controller boundary and document the read scope.
- [x] Run focused tests and package typechecks; record results and commit only owned files.

## Task 2: Shared tunnel transport and Controller forwarding

**Files:** Uplink preview snapshot schema, new tunnel codec, portable tunnel peer, Node local upstream adapter, Controller registration store, and their tests. Existing uplink client/host integration receives explicit lifecycle hooks.

**Interfaces:** Binary-capable `TunnelSocket` carries JSON control and binary chunks. `TunnelPeer` multiplexes bounded logical streams. HTTP streams exchange method/path/headers, response status/headers, byte chunks, end and cancellation. WS streams exchange handshake protocol, text/binary messages and close. Registration control uses a narrow `/remote/previews` RPC family; targets are never supplied by browser data requests.

- [x] Write failing real HTTP tests for binary echo, early SSE, cancellation and capacity; write real WS text/binary/protocol/close tests.
- [x] Implement framed streams with per-stream credit, bounded total streams and queues, timeout and cleanup.
- [x] Implement loopback-only HTTP/HTTPS and WS forwarding without redirect following or fetch decompression, with protected management ports.
- [x] Implement persisted fixed-deadline registrations, atomic mutations, epoch/revision snapshots, tombstones, expiry cancellation, and reconnect fencing.
- [x] Run focused transport and lifecycle tests, record results, and commit.

## Task 3: Hosted authorization and runtime adapters

**Files:** Hosted broker/gateway and new preview router; Node gateway/socket writer; Workers worker/DO/socket adapters; runtime contract tests.

**Interfaces:** Authenticated owner session creates a single-use, short-lived preview handoff; redemption creates a registration-scoped host-only cookie. Every data request revalidates origin, registration and current authorization. Dedicated Controller data upgrades bind credential and current control generation.

- [x] Write failing auth tests for anonymous/foreign/revoked access, stale connection, replayed handoff and offline removal.
- [x] Route management through existing authorized session binding and persist pending unregister before dispatch. Reconcile snapshots before admitting traffic.
- [x] Implement HTTP streaming and delayed WS acceptance with selected protocol in both adapters. Preserve binary data and response headers; propagate browser cancellation.
- [x] Rewrite eligible redirects and application cookies under the preview prefix; support configured-base apps with explicit path mode and bounded static HTML adaptation. Reject unsupported opaque rewrites with actionable guidance.
- [x] Run both runtime contract suites and commit.

## Task 4: Preview UI and complete acceptance

**Files:** Web preview client/context and timeline controls; Lab workbench host preview list and configuration; docs and compatibility metadata.

**Interfaces:** Block actions expose distinct loopback targets, register on click, then show a ready link and unregister. Shared Host state reconciles server snapshots/revisions and distinguishes lifecycle from connectivity.

- [x] Write UI tests for no registration on render, explicit registration, reused mappings, expiry/offline state and unregister synchronization.
- [x] Integrate actions for Markdown, code/tool-output text; include Host list with source navigation and configuration instructions for base-aware dev servers.
- [x] Validate a real Vite app through prefixed HTTP/WSS, including hot reload; validate Markdown images through real session resource transport.
- [x] Run relevant suites, typechecks/builds, compatibility update/check, and document actual supported behavior and validation boundaries.
- [x] Obtain independent whole-change review, fix findings, and report completion without deployment or push.
