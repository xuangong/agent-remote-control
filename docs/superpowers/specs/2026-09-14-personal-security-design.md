# Personal Remote Access Security

Approved scope: opaque Gateway continuation, browser session management, Host execution policy, invitation/device separation and rotation, recent authentication for sensitive actions, rate limits and security audit, explicit stop-work operation. Preserve mobile/session-link recovery and both Workers and Node runtimes. No production changes, merges or pushes are implied.

## Trust and compatibility
Gateway owns account login and an Agents-only random continuation registry; only hashes leave credential creation storage boundaries. Continuations are bound to the original user session, Relay audience, expiry and authentication time. Relay must never receive a reversible Gateway login token. Legacy encrypted continuations are rejected by default after upgrading Gateway; existing Hosts, shares and bindings remain. Roll out Gateway then Relay; users sign in again. Do not rotate the existing storage signing secret automatically.

Relay retains authoritative Host/session ACLs. Browser sessions get non-secret management IDs, creation/last activity metadata and user-agent labels. Revoking one or all sessions removes the state and closes live streams immediately. Owner/tenant checks apply on all management APIs. Recent-auth window is 10 minutes since an actual Gateway login, never reset by a Relay renewal. Pairing, credential rotation and share additions/limit changes require freshness; revocation does not. A 403 reauthentication_required response includes a safe loginUrl. Ordinary chat remains renewable.

Host execution policies are local trusted configuration, not remote mutable settings: allowed real workspace roots and locked native permission controls by default for the CLI. Use native provider sandbox options where supported; report unsupported guarantees honestly. Do not promise filesystem isolation from a cwd check alone. Explicit local opt-out exists for trusted full control. Environment credentials for the Relay/management must not be inherited by native provider subprocesses.

Credential-capable Hosts advertise credentialRotation=true in register. Relay sends credential_issued {credential}; Host atomically saves the credential before replying credential_saved. Relay commits credential activation before registered. Reconnect using a durably saved offered credential must work. New invitations become unusable after enrollment. Existing enrolled legacy Hosts remain compatible but cannot rotate until updated. Rotation is owner-only, recent-auth required and asynchronous until acknowledged. Never expose device credentials to the browser or logs.

## Controller APIs
All /auth endpoints are same-origin and no-store. Mutations require JSON and exact Origin.
- GET /auth/sessions -> {sessions:[{id,label,createdAt,lastSeenAt,expiresAt,current}], authenticatedAt:number|null, recentAuthentication:boolean}
- POST /auth/sessions/revoke body {id} -> {ok:true,current:boolean}
- POST /auth/sessions/revoke-all body {} -> {ok:true}
- GET /auth/audit -> {events:[{id,at,action,outcome,hostId?}]}; actor-filtered, no prompts, tokens or personal identifiers.
- /auth/login accepts validated reauthenticate=1 in addition to canonical session location. Gateway OAuth returns to the validated launch path after fresh authentication.
- POST <user-base>/v1/remote/hosts/:hostId/rotate body {} -> {ok:true,status:'pending'|'rotated'}
- POST <user-base>/v1/remote/hosts/:hostId/stop body {} -> {results:[{agentId,status:'cancelled'|'unsupported'|'failed',message?}]}; owner only. Cancellation means the native cancel call completed, not OS process termination.
Host list adds credentialRotation?:boolean. The UI must distinguish stopping work from revocation, and show partial failures.

## Abuse and migration
Bound login challenges per IP and globally; bound authenticated mutations per user, streams per user and messages per stream. Fixed bounded in-memory rate windows supplement existing durable admission caps. Retain bounded per-user audit entries in shared durable state. Do not log secret-bearing payloads. Preserve pre-upgrade state by normalizing optional metadata; storage key changes require a separate explicit migration, never silent reset.

## Acceptance
Behavioral tests exercise foreign users/origins, CSRF, replay, expired/revoked sessions, fake reauth, stale recent-auth, durable restoration, quota commits, rotation interruption/reconnect, symlink cwd escapes, locked permission settings, native cancellation partial failure, rate limits and redaction. Browser tests cover mobile security panel and reauth target recovery. Regression uses recorded adapters and real local HTTP/WS, never paid/native agent invocation. Run compatibility:update then check; build/typecheck and Workers runtime tests.
