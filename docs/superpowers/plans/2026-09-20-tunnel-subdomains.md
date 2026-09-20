# Isolated Tunnel Subdomains Implementation Plan

**Goal:** Serve each local preview at the root of a stable tunnel hostname without modifying the target application.

**Architecture:** Configure one wildcard DNS record and Worker route. Resolve `t-<sha256-prefix>.<preview-domain>` to an active preview registration. Keep authentication on the control origin and exchange a short-lived proof bound to an HttpOnly challenge cookie on the destination origin. Do not share the control login cookie across subdomains.

**Tech Stack:** TypeScript, hosted Relay, Cloudflare Workers/Durable Objects, React, Vitest, Playwright.

## Constraints

- Dedicated worktree; preserve existing services, pairing, secrets, registrations and deployment rollback.
- Hash case-sensitive registration IDs into DNS-safe lowercase labels; do not lowercase IDs.
- HTTP, SSE, WebSocket and application cookie paths retain root semantics.
- Authenticate ownership and active browser authority for every request and existing stream.
- Entry proof is one-use, short-lived, destination-bound and browser-bound. Copied URLs contain no credential.
- Never route existing control, gateway or other Custom Domains to a tunnel.
- Retain traffic and iframe renewal. Keep legacy path mode available when no preview domain is configured.
- Configure DNS/certificates only with scoped credentials; never log credential values.
- Every test run has per-test and outer deadlines; sequence builds before dependent tests.

## Tasks

- [x] Add hostname routing helpers and browser-bound subdomain access with negative tests for cross-origin, replay, expiry, wrong browser and owner revocation.
- [x] Connect HTTP/WebSocket forwarding, root cookie/redirect semantics and manifest credentials. Add real transport acceptance.
- [x] Update browser entry/renewal and cross-origin iframe navigation; preserve legacy entry mode.
- [x] Add Node and Worker domain configuration and compatibility metadata; document the migration.
- [x] Validate root-mounted Vite imports, API calls, cookies, WebSocket, navigation in real browsers; verify independent tunnel authorization.
- [ ] Inspect DNS and certificates with the scoped token, stage wildcard routing while excluding existing services, and verify TLS.
- [ ] Build, commit and deploy the approved change; verify production resources and target app without exposing credentials. Retain rollback information.

## Authentication flow

1. A target-origin challenge endpoint generates a random challenge plus an HttpOnly browser cookie, both limited to five minutes.
2. The control origin authenticates the existing Google/Gateway session, verifies Host ownership, and authorizes that challenge with a one-minute proof.
3. The target origin redeems its one-use proof only when the challenge cookie matches, then sets a host-only preview session cookie.
4. Embedded entry uses credentialed CORS restricted to the exact control origin. Direct navigation uses the existing login return flow.
5. Every preview request rechecks the retained control session and active Host registration. Logout, unregister and expiry revoke access.

## Deployment

Use `AGENT_REMOTE_PREVIEW_DOMAIN=xianliao.de5.net`. DNS is a proxied wildcard A record with an unroutable documentation address; the Worker terminates matching requests. Inventory exact existing Custom Domains and route them without the generic tunnel Worker. Only `t-<48 lowercase hex>` hosts enter tunnel routing; unknown hosts fail closed. Verify existing services before and after changes.

## Verification and deployment status

The isolated implementation is available on `feat/tunnel-subdomains`. Production remains unchanged until wildcard DNS, edge certificate coverage, and exact existing-service route exclusions have been verified. Wrangler OAuth can deploy Workers and manage routes but does not grant DNS editing. A short-lived zone-scoped DNS token is required for the infrastructure step.

Browser acceptance uses a local TLS terminator with real sibling origins and Strict/Secure cookies. It covers React/Vite root imports, API calls, HMR, manifest access, iframe navigation, and direct browser-bound entry. Physical iPhone/Home Screen acceptance and production wildcard TLS remain pending.

Validated locally: root build and typecheck; 126 hosted tests, 323 web tests, 21 focused Node/UI integration tests, 24 Cloudflare runtime tests, and one real TLS Chromium root-Vite acceptance test. Compatibility check, documentation lint, and diff whitespace checks pass. No production DNS, routes, environment variables, or deployments were changed.
