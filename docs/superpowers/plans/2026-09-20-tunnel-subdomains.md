# Isolated Tunnel Subdomains Implementation Plan

**Goal:** Serve each local preview at the root of a stable tunnel hostname without modifying the target application.

**Architecture:** Configure one wildcard DNS record and Worker route. Resolve `<color>-<animal>-<12-hex>.<preview-domain>` to an active preview registration. Keep authentication on the control origin and exchange a short-lived proof bound to an HttpOnly challenge cookie on the destination origin. Do not share the control login cookie across subdomains.

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
- [x] Inspect DNS and certificates with the scoped token, stage wildcard routing while excluding existing services, and verify TLS.
- [x] Build, commit and deploy the approved change; verify production assets, health, TLS and unauthenticated entry. Retain rollback information.
- [ ] Complete signed-in production target-app and physical iPhone/Home Screen acceptance.

## Authentication flow

1. A target-origin challenge endpoint generates a random challenge plus an HttpOnly browser cookie, both limited to five minutes.
2. The control origin authenticates the existing Google/Gateway session, verifies Host ownership, and authorizes that challenge with a one-minute proof.
3. The target origin redeems its one-use proof only when the challenge cookie matches, then sets a host-only preview session cookie.
4. Embedded entry uses credentialed CORS restricted to the exact control origin. Direct navigation uses the existing login return flow.
5. Every preview request rechecks the retained control session and active Host registration. Logout, unregister and expiry revoke access.

## Deployment

Use `AGENT_REMOTE_PREVIEW_DOMAIN=agents.xianliao.de5.net`. Live certificate inspection confirmed an active `*.agents.xianliao.de5.net` certificate, so deployment uses the narrower `*.agents.xianliao.de5.net/*` route and DNS wildcard. This avoids intercepting sibling services. DNS is a proxied wildcard A record with an unroutable documentation address; the Worker terminates matching requests. Inventory exact existing Custom Domains and route them without the generic tunnel Worker. Only `<color>-<animal>-<12 lowercase hex>` hosts enter tunnel routing; unknown hosts fail closed. Verify existing services before and after changes.

## Verification and deployment status

The isolated implementation is available on `feat/tunnel-subdomains`. Production wildcard DNS, the scoped Worker route, and edge TLS have been verified. The friendly-name deployment is live as version `107558f8-3de3-4d22-baec-d273e27fd77c` from commit `6baf68a`. The previous isolated-origin deployment was `33a95929-6998-43d2-8b90-e9cb3c76aaaa`. Friendly color/animal names replace the initial hash-only names without compatibility redirects. Wrangler OAuth manages deployment; a separate short-lived zone-scoped token configured DNS.

Browser acceptance uses a local TLS terminator with real sibling origins and Strict/Secure cookies. It covers React/Vite root imports, API calls, HMR, manifest access, iframe navigation, and direct browser-bound entry. Production wildcard TLS and unauthenticated login redirects pass. Production authenticated target-app and physical iPhone/Home Screen acceptance remain pending; the available production browser is signed out.

Validated locally: root build and typecheck; 126 hosted tests, 323 web tests, 21 focused Node/UI integration tests, 24 Cloudflare runtime tests, and one real TLS Chromium root-Vite acceptance test. Compatibility check, documentation lint, and diff whitespace checks pass. The seven existing service origins returned HTTP 200 before and after deployment. Infrastructure snapshots are retained locally under `~/.agent-remote-control/deployments/tunnel-subdomains-20260920/`. The pre-subdomain rollback version is `c49ccf18-9025-4ae7-8ae4-bd529ff5a1b0`.

Friendly-name validation: Relay and Worker builds, root typecheck, four hostname/CSP tests, one real Node HTTP/WebSocket test, eight Cloudflare preview runtime tests, and one TLS Chromium/Vite browser test passed. Compatibility and documentation checks passed. Production confirmed the new hostname redirects to control login (303), unauthorized resources return 401, the former hash hostname returns 403, TLS validates, and the served JavaScript matches the local build. The control site and six existing sibling services return 200. Deployment evidence is saved as `friendly-hostnames.json` beside the infrastructure snapshots. The branch remains unmerged and unpushed.
