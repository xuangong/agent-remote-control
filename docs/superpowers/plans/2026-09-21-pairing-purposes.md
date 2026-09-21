# Pairing purposes and lifecycle

Implement in the existing docker-host-bootstrap worktree. No merge, push, cloud deployment,
real Google login, or changes to unrelated services.

## Contract

- PairingPurpose: `host-only` (default) or `gateway-setup`.
- POST /v1/remote/pairings accepts `{ purpose }` (omitted = host-only).
- It returns the existing key/expiresAt/serverUrl/command plus id, purpose, createdAt.
- GET /v1/remote/pairings returns `{ pairings: [...], availablePurposes: [...] }`. Each record has id, purpose,
  createdAt/expiresAt ISO strings, status `unused|used|obsolete|revoked`, optional
  usedAt, revokedAt, hostId, hostName. Never return the secret or its hash in listings.
- POST /v1/remote/pairings/:id/revoke revokes unused invitations. Used invitations
  return 409; Host credential revocation is a separate explicit operation.
- DELETE /v1/remote/pairings/:id deletes history, invalidating an unused invitation.
  Deleting used history does not revoke device credentials or Gateway tokens.
- Durable pairing keys are atomically claimed exactly once, including simultaneous
  registrations for the same installation. Persist audit history independently of keys.
- Registration `registered` includes optional `pairingPurpose`; production Relay sends
  the persisted Host purpose. Uplink ready returns this optional field.
- A device may call bootstrap only for a Host authorized for `gateway-setup`.
  Old Hosts with gatewayKeyRequested retain gateway-setup authority during migration;
  otherwise legacy metadata defaults to host-only. Re-pairing the same installation
  does not implicitly remove or expand an established Host's setup policy.
- Controller always enrolls before provider startup, obtains purpose, and initializes
  the configured providers only for gateway-setup. No client-side environment flag can grant authority.
  Retain the managed marker locally for native CLI commands and re-pair protection.
- Standalone non-account workbench keeps legacy process-local pairing behavior;
  Gateway purpose is unavailable there. Hosted durable invitations are one-use.

## Tasks

1. Root: protocol, durable invitation records, transactional claim, API/access checks,
   persistence validation, bootstrap enforcement and real-transport lifecycle tests.
2. UI implementer: purpose selection, scoped key history/status/revoke/delete UX,
   typed service/client methods and observable UI tests.
3. Controller implementer: purpose-driven enrollment, Docker defaults/docs, CLI tests.
4. Root: integrate and review all changes, update compatibility, build/typecheck,
   targeted transport/browser tests and simulated-account bootstrap validation.

## Decisions

- Obsolete means expired before use; used/revoked are permanent terminal statuses.
- Delete unused keys immediately invalidates them. Explain this action in the UI.
- Gateway setup is provider-neutral; the Host configuration selects CLI adapters.
- New invite history is bounded at 512 records; ask users to delete obsolete records
  on capacity rather than silently removing their history.

## Validation results

- Durable key lifecycle exercised over real HTTP/WebSocket transports, including concurrent claim, restart, terminal states, history deletion and legacy authorization migration.
- Desktop and mobile browser flows cover both purposes, secret handling and revocation.
- Provider initialization covers Codex, Claude and combined configuration; unsupported Copilot setup is rejected before issuing a token.
- Isolated simulated account and Docker Host exercise the real Gateway launch route, one-key startup, native Codex inference, session reconnect after restart and Host/token revocation without Google login.
- Native Claude 2.1.247 from the installed SDK exercises managed configuration and a real session against an isolated local messages endpoint; no personal Claude configuration is modified.
