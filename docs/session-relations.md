# Cross-device Side and Ask navigation

Hosted Side and Ask relationships belong to the Relay's product navigation layer, not Provider SDK ancestry or normalized Session View events. Opening the source on another device discovers the same target sessions. Mobile keeps its existing full-screen Side navigation and Ask overlay; layout, focus, drafts, outboxes and the Ask visibility preference stay local.

## Creation and discovery

Hosted `POST /v1/remote/hosts/:hostId/create` accepts optional `conversationKind: "side" | "ask"` alongside `sourceNativeSessionId`. The Relay validates source access, includes the kind in creation deduplication and commits the relationship with the target binding. It does not forward this product metadata to the Controller. Shared-host creation preserves the original browser operation ID separately from the Host's quota reservation ID.

Authenticated `GET /v1/session-relations` returns `{ relations }`, each containing `id`, `kind`, `createdAt`, `source` and `target`. Both endpoints identify a session with `hostId`, `providerId`, `nativeSessionId`, `agentId` and a fallback `title`. Both sessions must be accessible to the caller. Relationship metadata survives Relay restart; native attachment still requires the Host. Revoking access removes the corresponding discovery entries.

Clients refresh on source selection, foreground/focus and every ten seconds while visible. Before opening Ask, the client checks discovery again to reuse the latest known Ask instead of blindly creating a new one. A currently open Ask is not replaced by another device's Clean action; after closing, its next open can use the newest relationship. An explicit Clean still creates a new Ask. Concurrent intentional creation remains independent.

Shared records contain navigation only. They never restore first-input delivery receipts, pending messages, snapshot text or inherited settings. Opening one attaches the existing native session without creating it, replaying input or resetting settings. The creating browser retains its original delivery ledger, including uncertain outcomes. Remote navigation lives in memory and is rediscovered after reload.

## Older browser records

Authenticated `POST /v1/session-relations` imports `{ hostId, providerId, nativeSessionId, sourceNativeSessionId, id, kind, createdAt }`. It verifies the source against the Relay's completed native creation receipt, checks access to both sessions and rejects conflicting relationships. It cannot invent a relationship between arbitrary sessions. Identical imports are idempotent.

The original browser backfills completed reference records from its Side and Ask ledgers, four at a time. Older Ask records require the original tab, since its ledger used session storage. No prompt text, drafts, settings, captured history or private Host source grants are uploaded. Old Relay receipts alone cannot reliably distinguish Side from Ask; when the browser ledger has already been deleted, the relationship cannot be automatically classified. Snapshot `/fork` records remain local.

No Controller update or Session View wire-version change is required. Deploy the hosted Relay and web client together. The standalone workbench keeps its existing local behavior and sends no product relationship metadata to native providers.

## Verification

- Cloudflare HTTP/WebSocket tests cover second-device discovery, durable restart, idempotency, import validation, nested Side/Ask, shared-host privacy and revoked access.
- Client tests cover foreground refresh, local backfill, local uncertain-input preservation and navigation-only remote records.
- A real Node Relay/Host transport with the recorded Provider connects separate desktop and clean mobile browser contexts. The phone opens the desktop-created Side and Ask without issuing another create request or adding timeline messages. Native Provider-specific behavior is unchanged.
