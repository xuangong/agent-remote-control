# Resource Attachments Implementation Plan

> For agentic workers: use the subagent-driven-development workflow with disjoint file ownership and review each boundary before integration.

**Goal:** Transfer ordinary files through the composer and between Team members on independent Hosts.

**Architecture:** Add structured resource inputs and chunked transfers beside existing Image operations. Use a Node file store for session inputs and a portable chunk store for hosted Team resources while keeping authorization in each owning boundary. Native adapters receive verified local paths; Team messages contain references only.

**Tech Stack:** TypeScript, TypeBox, Node.js, React, Vitest, Playwright, WebSocket.

**Spec:** [Resource attachments](../specs/2026-10-13-resource-attachments.md)

## Global constraints

- Work only in `.worktrees/resource-attachments`; preserve existing services.
- Keep Image behavior, native input semantics, and Team delivery receipts compatible.
- Use 50 MiB/file, eight resources/message, 100 MiB/message, 1 GiB/store, 32 KiB chunks, and 24-hour unreferenced draft expiry.
- Every test has per-test and outer process deadlines; native model requests are not required for fault fixtures.
- Do not publish, install globally, or restart existing Controllers as part of verification.

## Resource protocol and Host storage

Owner: resource_core. Files: `agent-remote-protocol/src/resource-input.ts`, `image-input.ts`, exports and unions; `agent-provider-sdk` input types; `agent-remote-relay/src/resources/input-resource-store.ts`, `agent-manager.ts`, `session-wire.ts`, and native adapters.

- [x] Add failing schema/store/transport tests for ZIP round-trip, empty files, digest mismatch, offset retry, quota, scope denial, and restart retention.
- [x] Implement `ResourceUploadReceipt` with `{uploadId,offset,resource?}` and resource metadata `{resourceId,name,mediaType,byteLength,sha256}`.
- [x] Add `MessagePart` resource references and resource upload/download operations; preserve text/image unions.
- [x] Implement durable `InputResourceStore` and adapter-owned local-path representation, then run targeted tests.

## Composer and history

Owner: resource_ui. Files: `agent-remote-web/src/react/AgentComposer.tsx`, resource draft hook, editor, timeline rendering, client request helpers, and related tests.

- [x] Add failing UI tests for Resource selection, pending/failed/retry/removal, structured send, and history download.
- [x] Consume resource capabilities and chunked upload receipts; add Resource beside Image.
- [x] Render resource references and metadata, retaining stable identity across reconnect and history.
- [x] Run existing Image regressions plus Resource tests; prepare browser acceptance scenario.

## Team transfer

Owner: resource_team. Files: `agent-remote-protocol/src/team.ts`, `agent-host/src/team.ts`, resource tool helpers, `agent-remote-hosted/src/teams.ts`, `broker.ts`, and related tests.

- [x] Add failing tests for cross-member file transfer, denied foreign references, idempotent publication, restart authorization, and text quota separation.
- [x] Add independent resource begin/chunk/finish/metadata/read calls and resource references on Team messages.
- [x] Add upload/download tools, durable grants, local checksum validation, and collision-safe file materialization.
- [x] Verify real transport delivery and returned report bytes without storing payloads in Team messages.

## Integration and delivery

Owner: Leader. Files: `agent-host/src/host.ts`, production broker construction, compatibility fixtures/metadata, feature documentation, and isolated acceptance harness.

- [x] Wire session and Team stores into persistent runtime directories and verify defaults through Host tests.
- [x] Build affected packages, review dependency boundaries, and run compatibility update/check.
- [x] Exercise browser upload and independent Host transfer using the diagnostic ZIP as a realistic artifact.
- [x] Establish the native Windows verification boundary: existing Controllers lack resource tools and remain unchanged. Local two-Host transport tests pass; execution on a physical Windows Host is not claimed.
- [x] Review authorization, memory/size bounds, retry semantics, resource retention, and Image regressions; deliver code and evidence without publishing.
