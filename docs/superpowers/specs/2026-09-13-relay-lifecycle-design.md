# Hosted Relay lifecycle

The approved follow-up makes hosted access usable for long-running sessions while keeping Gateway authoritative and Relay independently deployed.

## Authentication

Gateway launch grants include an opaque encrypted `continuation` for the original login and `sessionExpiresAt` (epoch milliseconds). Gateway decrypts the continuation during authority checks; Relay treats it as opaque and never needs a plaintext Gateway login token. Both services hold the root secret, so this is not cryptographic isolation against a compromised Relay. Relay exchanges the grant into its own random HttpOnly session cookie. Relay persists session records and rechecks original-login validity through Gateway every 60 seconds with a maximum 120-second authorization lease. Gateway errors cannot extend that lease. Account disable/login revocation closes browser access within the lease. Browser refresh preserves the mounted controller and WebSockets use the current lease, not the initial grant expiry. Logout revokes the Relay session and its sockets.

Gateway service API: POST `/api/agent-remote/renew` body `{continuation}` -> `{active:true,subject,expiresAt,validUntil}`; POST `/api/agent-remote/user-status` body `{subject}` -> `{active:true,subject,validUntil}`. Denial is 401/403; unavailable is 503. Responses are no-store. Service authentication is HS256 JWT with header `{alg:'HS256',typ:'arc-relay-service+jwt'}`, claims `{iss: relayOrigin,aud: gatewayOrigin,op:'renew'|'user-status',bodyHash: SHA256(rawBody) base64url,iat,exp}` with expiry at most 60 seconds. Signature uses the shared signing secret. Browser login/API keys cannot call these routes. Gateway checks authoritative records.

## Devices and recovery

Hosted pairings expire after ten minutes until first registration. The same opaque key then becomes a persistent installation-bound device credential, stored only as a hash at Relay. This preserves all existing Host/DSH wire clients. A new key used by the same installation rotates and invalidates previous keys. Device revoke removes its keys, closes Host/browser streams and removes bindings. Re-pairing is explicit. User disable closes Host access after a maximum 120-second authority lease; logging out a browser does not unpair a workstation.

Relay stores tenant owner, device hashes/installation/Host identities and native session bindings in an atomic mode-0600 local state file, with one process per state directory. No transcript is stored. Restored bindings force native reattach before snapshot/stream access. Restored authority leases are not trusted across restart: Gateway must confirm before protected access. Existing default standalone behavior stays ephemeral. Hosted CLI requires durable state, with a home-directory default and configurable AGENT_REMOTE_STATE_DIR. Existing Host reconnect is reused; managed Host saves connection settings privately for restart.

## User flow

Gateway dashboard provides Agent Remote entry and auto-submits the browser-bound launch form, with a manual fallback. Controller offers copyable Host setup and explicit device revoke. Active browser renews without losing layout. Relay restart preserves device and session identities. Deployment remains single-process behind TLS; no cross-replica durability or operating-system service installation is added.

## Validation

Use red-green tests for service auth/revocation, lease refresh/failure/expiry, persistence/restart, device rotation/revoke and UI preservation. Real HTTP/WebSocket transport validates ownership and recovery. Cross-project Chromium validates actual Gateway/Relay lifecycle without CLI inference. Run Gateway CI, ARC build/typecheck/compatibility and affected suites sequentially after build.

## Review refinements

Authority failure and denial have different transport semantics: expired unavailable authority uses retryable HTTP 503 / WebSocket 1013; actual denial uses 401 / 1008. Host request classification follows the authorized dispatch, including URLs with queries. Revoked or closing pre-registration sockets cannot mutate device state. Expired browser UI remains hidden and inert for at most five seconds during wake-up revalidation, preserving mounted drafts/sides only if authority succeeds. Atomic state locking serializes stale-lock recovery and releases only the matching random owner; a crash during the recovery critical section requires checking for live owners before removing its conservative recovery marker.
