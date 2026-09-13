# Host sharing and cumulative session creation quotas

## Approved behavior
Owners share a Host with an existing Gateway user and set the total number of sessions that user may create on that Host. Users create sessions when they have a topic. Existing sessions remain usable at the limit. Reconnect, additional browser windows, task completion, archival and share revocation do not reset usage. Raising the limit permits additional creates.

## Architecture
Gateway remains the authoritative user directory and login authority. The durable single-process Relay owns Host grants, session creators and an atomic persistent creation ledger alongside existing device state. Gateway exposes authenticated dashboard APIs and sends purpose-bound service requests to Relay. Browser session data continues directly over Relay and the existing Host uplink. User namespace paths remain caller-owned; Relay routes authorized shared Host/session operations into the owner's broker without granting access to the entire owner namespace.

The Relay service endpoint is POST /gateway/control. JSON body: {subject, operation, hostId?, targetSubject?, targetLabel?, sessionLimit?}; operations: hosts, shares, share, revoke-share. Proof: HS256, typ arc-gateway-service+jwt, iss Gateway origin, aud Relay origin, op control, bodyHash SHA256 base64url, iat, exp <= iat+60, jti unique. Reject browser Cookie/Origin, invalid method/content type, oversized bodies and replayed jti. Gateway derives subject from a real ses_ login, resolves target email authoritatively, and never accepts caller-supplied subjects.

Host overview: {id,name,online,providers,managed,access:'owner'|'shared',sessionQuota?:{limit,used}}. Share list: {shares:[{subject,label,sessionLimit,used,revoked}]}. Only owner can share/change quota/revoke or unpair. Shared users can list, create and attach only sessions created through their grant. They cannot attach arbitrary owner or peer native IDs. Existing owner access remains unchanged.

## Quota semantics and failures
Reserve a durable ledger entry before dispatching create. Key includes user, Host, provider and client requestId; compare complete request fingerprint. Namespace the native requestId so two users cannot collide. Successful creates consume one unit permanently. Definitively rejected creates may release the reservation; uncertain transport outcomes retain it and return an actionable error. Replaying the same request never dispatches a second create after uncertain restart. Reservations survive restart and count toward the limit. Lowering limit below usage blocks new creates without terminating existing sessions. Revoke immediately blocks new traffic and closes only that grantee's streams; in-flight creates keep their ledger and cannot expose results after revocation.

## Session and provider boundaries
The quota covers new sessions created through the Remote create API, including side conversations that use that API. Native automatic subagents are provider-managed descendants, not additional user creation allowance; their attachment must be verified against a caller-owned parent's native child metadata. This is not an OS sandbox or a quota on native CLI activity outside Remote. Host-scoped workspace/model discovery remains available to a shared user; it is part of using the shared machine. Unknown activity must be displayed as unknown, not idle.

## Delivery
Gateway Host directory and share/quota editor; safe deep link through existing login into the selected Controller Host; Controller shared/owner and quota display; durable authorization and transport tests without invoking CLI agents. Keep both worktrees, do not merge/push/deploy.
