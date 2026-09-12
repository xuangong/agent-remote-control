# Gateway authenticated Agent Remote Relay

## Decision

Keep the gateway as the identity authority and deploy a separate Node Relay with the existing controller UI. The gateway proxy package implements outbound dial/failover (including Trojan), not inbound agent routing. Reusing it would not provide ownership or session isolation. Embedding the Node broker in the gateway would couple Node WebSocket state to Bun/Cloudflare deployment. A gateway reverse proxy is possible later but unnecessary for this topology.

## Contract

- Relay `GET /auth/login` sets a random HttpOnly verifier cookie and retains its SHA-256 challenge for at most five minutes. It redirects to Gateway `/agent-remote?challenge=...`. A direct Gateway entry first redirects through this Relay step. Challenges are bounded to 4096 outstanding entries and consumed once.
- Gateway `GET /agent-remote` presents a launch form using an existing real user session. `POST /api/agent-remote/launch` accepts a same-origin form or JSON request, resolves an active session and enabled user authoritatively, and creates a relay-only HS256 JWT.
- Configuration: `AGENT_REMOTE_RELAY_URL` is a fixed HTTPS origin (HTTP loopback is allowed for development). `AGENT_REMOTE_SIGNING_SECRET` is a shared random secret of at least 32 bytes; `AGENT_REMOTE_ISSUER` is a fixed gateway HTTPS origin. No arbitrary redirect or caller-supplied user identity.
- JWT header: `alg=HS256`, `typ=arc-relay+jwt`; claims: `iss`, `aud` (Relay origin), `sub` (gateway user ID), `iat`, `exp` (at most 15 minutes and no later than the original login session), `jti`, `nonce` (the browser login challenge). Only real `ses_` user sessions are accepted; LLM API keys and dev auth cannot grant workstation control.
- Launch redirects to Relay `/auth/callback#ticket=...`. A callback script immediately removes the fragment and exchanges it by same-origin JSON POST `/auth/session`. Relay verifies all claims/signature and the matching browser verifier plus unused challenge, consumes the challenge, and sets an HttpOnly, SameSite=Strict cookie (Secure on HTTPS). On HTTPS both cookies use the __Host- prefix. No credential in query strings, logs, localStorage or trace; the challenge hash is public and grants no authority.
- Relay `/auth/status` returns the current user namespace and expiry. UI requests use `/u/<sha256(issuer,user)>/`; the Relay matches it against authenticated identity before dispatch. Browser storage naturally separates by namespace. No account database exists in Agent Remote Control.
- Each namespace owns a separate broker: Host registrations, installation identities, pairing keys, session bindings, creation ledger and streams. Guessing another user's route or session ID cannot cross the boundary.
- Pairing remains the existing process-local `arc_` credential. Public pairing URL is the configured Relay origin. Keys select their owning broker for `/ws/remote-host`; browser credentials cannot register a Host, and Host keys cannot access browser APIs.
- Enforce exact browser Origin for mutations and WebSocket upgrades, size/capacity bounds, finite socket credential lifetime, and no unauthenticated fallback into the local fixture server.

## Boundaries

Browser grants last at most 15 minutes; account disable/session revocation prevents new grants but already-issued grants remain valid until expiry. Browser streams terminate at expiry. Re-launch from the gateway renews access; no silent cross-origin refresh in this version. Host pairing keys last 24 hours and connections terminate at expiry. Disabling a user does not instantly revoke existing Host connections. Rotate the shared secret and restart Relay for emergency global revocation.

Relay is one process: restart loses pairing, host IDs and browser binding IDs; native sessions remain on Hosts and can be reattached after pairing again. It is not a durable multi-replica service. Default maximum is 64 tenant brokers; tenants are reclaimed after their credentials expire. Host owns provider execution and resource semantics; gateway never receives prompts or transcript traffic. TLS termination and shared secret distribution are deployment responsibilities. This work does not deploy, merge or push.

## Acceptance

Real SQLite-backed gateway auth tests reject missing/expired/disabled users, API keys, dev-auth and foreign origins. Real HTTP/WebSocket Relay tests cover two-user isolation, spoofed paths, pairings, host registration, catalog/attach/snapshot/stream, reconnect, token tampering/expiry, Origin checks and credential role separation. Cross-project test launches the actual gateway issuer and Relay with temporary data and a scripted Host; no CLI agent or cloud inference. Existing broker/transport and UI tests remain green; compatibility metadata is refreshed. Gateway CI includes typecheck, tests, lint, UI build and Cloudflare dry-run.
