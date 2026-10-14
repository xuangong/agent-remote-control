# Self-hosted product deployment

## Outcome

The full Agent Remote Control product supports two independent choices:

- Runtime: Node/Docker or Cloudflare Workers.
- Authentication: Google OpenID Connect or the existing Gateway integration.

All four combinations use the same hosted Relay, public Session protocol, session renderer, pairing and account-isolated product features. The standalone diagnostic workbench remains account-free. Existing production Gateway users, namespaces, credentials and persisted records must continue working.

## Authentication boundary

Choose one authentication provider per deployment. Share opaque browser sessions, browser-device management, recent-authentication checks and tenant authorization in the hosted package. Provider adapters supply login verification and authority semantics. Google uses the authorization-code flow with PKCE, state, nonce, browser binding, signature/issuer/audience/expiry validation and verified-email admission; use Google `sub` as identity. Require a configured email allowlist (no default public access). Google sessions have an explicit local lifetime; do not claim Google logout immediately revokes local sessions. Gateway retains remote renewal, denial versus temporary unavailability, signed callback/control protocol and namespaces. Do not silently merge accounts when changing authentication provider.

Host-only pairing is available for both providers. Gateway model-key/CLI bootstrap and Gateway control remain explicit Gateway-only capabilities. Installation instructions use the deployment's own origin. Controller keeps its existing single-site pairing; native Agent CLIs remain on the Host machines.

## Runtime boundary

Node and Workers provide storage, transport, scheduling and assets, not independent authentication or business logic. Preserve storage admission and handoff guarantees; do not enable handoff by bypassing capacity checks. Private deployment must not require the production site or token gateway. Provide runnable Docker Compose and configurable Workers deployment instructions/templates; preserve existing production configuration. Document HTTPS, persistence, credentials, OAuth callback, upgrades and backup boundaries.

## Validation

Use signed local OIDC fixtures and real HTTP/WebSocket transports. Cover successful admission, wrong identity claims, denied emails, state/nonce/PKCE, callback replay, local session restart and logout/device behavior. Re-run Gateway regression tests and runtime smoke tests. Check both runtimes for provider-independent pairing and shared product routes. Real Google login cannot be claimed without operator OAuth credentials. Verify build/typecheck and compatibility metadata. Do not publish, push, deploy or restart existing services in this task.
