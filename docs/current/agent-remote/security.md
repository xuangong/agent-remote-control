# Personal access security

Gateway authenticates the account, Relay authorizes remote access, and Agent Host
owns execution. Each boundary must be configured separately. This hardening does
not make an unrestricted native agent safe for untrusted users or untrusted code.

## What each boundary enforces

| Boundary | Enforced behavior | Remaining limit |
| --- | --- | --- |
| Gateway | Random Agents-only continuation handles; hash-only registry bound to the original login, user, issuer and Relay audience; disabled/revoked/expired login checks | A compromised Gateway remains an identity authority; a stolen active session is still a bearer credential |
| Relay browser | HttpOnly, same-origin sessions; redacted browser list; individual/all-browser revocation; immediate closure of those live streams | Revoking browser access does not stop native work or revoke the separate Gateway login |
| Sensitive controls | Ten-minute actual-authentication window for pairing, device rotation and share additions/limit changes; renewal cannot refresh authentication time | Browser compromise during the recent-authentication window can still exercise granted authority |
| Device enrollment | Short-lived invitation exchanged for a separately generated device credential, saved before acknowledgement; owner-only rotation and revocation | A lost initial offer before local persistence requires another pairing invitation |
| Host | Local canonical workspace admission, imported-session filtering, permission settings locked, management environment variables masked | A workspace boundary is not an OS filesystem sandbox; provider credentials and accessible credential files remain available to native tools |
| Native provider | Codex workspace-write with escalation disabled; Claude command sandbox with unsandboxed fallback disabled | Copilot supplies no filesystem sandbox guarantee here; DSH/external Hosts require their own native execution policy |
| Sharing | Host ACL plus creator-specific session access and cumulative creation allowance | Sharing does not provide OS user, process, filesystem or network isolation |

An opaque continuation cannot reveal the original Gateway login token, even to a
Relay that holds the shared service-signing secret. It is still an Agents renewal
credential. This limits compromise propagation into unrelated Gateway APIs; it
does not protect Hosts from a fully compromised, trusted Relay.

## Everyday controls

Open **Security** from the desktop account controls, or **Settings → Security**
on a phone. Each browser entry shows its coarse platform/browser label, creation,
last observed activity and expiry. Activity is updated at most once a minute;
these labels are user-agent descriptions, not verified device identities.

- **Sign out browser** closes that login's remote streams. Other logins and Hosts
  remain available. **Sign out all browsers** includes the current browser.
- **Rotate credential** asks an updated, online Host to save a replacement. A
  pending response means issuance was accepted, not that disk persistence has
  completed. An interrupted saved offer can reconnect; the prior credential is
  retired when acknowledgement or replacement registration commits.
- **Stop work** requests cancellation for attached sessions and reports each
  native result independently. `cancelled` means the cancel call completed,
  `unsupported` means no cancel API, and `failed` includes timeout/failure. It
  does not guarantee OS process termination or discover every unrelated native
  process on the machine.
- **Revoke Host** removes its remote credentials and bindings. For an incident,
  request Stop work before revocation if native cancellation is wanted. Stop the
  local daemon and inspect remaining native processes when termination matters.

If a sensitive action requires another login, use **Sign in again**. The client
builds a local canonical return link and retains the session target. It never
uses an arbitrary server-supplied redirect and never automatically repeats the
sensitive operation after authentication. Signing out or revoking access does
not require recent authentication.

## Local execution setup

Use the CLI's default policy and set an explicit workspace before startup:

```sh
export AGENT_HOST_WORKSPACE=/absolute/path/to/project
export AGENT_HOST_ALLOWED_WORKSPACE_ROOTS='["/absolute/path/to/project"]'
agent-remote-controller start
```

Canonical paths must exist. Remote commands cannot change this local policy.
Configuration changes require a Host restart. The explicit local
`AGENT_HOST_TRUSTED_FULL_CONTROL=1` opt-out restores unrestricted behavior; it
must not be enabled for an account or workspace that should remain constrained.
See [Agent Host configuration](../../../packages/agent-host/README.md) for the
provider-specific sandbox, environment and persistence behavior.

For stronger execution isolation, run the Host under a dedicated OS account or
in a disposable VM/container with only the intended project mounted. Use separate
native login profiles and credentials. Do not mount the whole home directory,
SSH agent, Docker socket, Gateway database or deployment secrets. A separate
container per trust domain is stronger than multiple sessions in one Host. The
Relay Docker image is only the control service; putting Relay in Docker does
not isolate a Host running directly on a workstation. Automatic isolated Host
provisioning is not part of this change.

## Abuse controls and audit

The Relay bounds login challenges by observed client address and globally,
control mutations per user, pairing invitations, renewal/logout requests,
concurrent streams and control frames. The per-user stream allowance spans
shared Hosts belonging to different owners. CFW uses the platform-supplied
client address; Node uses the actual socket peer and ignores forwarded headers.
Behind a Node reverse proxy, clients sharing that peer share its login limit.

Limits are bounded in-memory windows and may reset on restart. Durable capacity
limits remain in force. They supplement ingress protections rather than replace
a distributed WAF. Audit contains only actor-scoped action/outcome/time and safe
Host identifiers. Retention is up to 100 events per user, 4096 globally and 30
days; it excludes prompts, transcripts, credentials and raw user-agent strings.
Audit is persisted in Node state and a separate SQLite table in the existing
Agents Durable Object. It is a small operational history, not a tamper-proof
forensic log.

## Upgrade and rollback

1. Back up Gateway SQL and Relay state using the existing deployment procedure.
   Preserve configured origins, the shared signing secret, Durable Object
   identity and storage volumes. Do not reset state to perform this upgrade.
2. Deploy the Gateway migrations `0011_agent_remote_continuations.sql` and
   `0012_session_authentication_time.sql` with its application first. Apply them
   to the chosen Bun/SQLite or CFW/D1 database through the Gateway's migration
   workflow. They add non-secret session identity, the continuation registry,
   browser-bound OAuth state and a separate `authenticated_at` field. Existing
   sessions deliberately receive no authentication-time backfill, and migration
   0012 clears old continuations. Ordinary Gateway access remains available, but
   Agents requires a real sign-in for sessions without authentication provenance.
   Device authorization inherits the original authentication time; creating or
   renewing a token cannot make an old login recent. API-key-authorized device
   sessions cannot supply recent-authentication proof.
3. Upgrade Relay and Controller together. The existing Agents Durable Object
   adds its audit table without replacing Host, share, session-binding or quota
   records. Node accepts optional metadata on older records.
4. Sign in again. Gateway rejects legacy encrypted continuation values. Old
   browser sessions stop renewing; an already issued authority lease can remain
   usable for at most its existing two-minute lease. This is an intentional
   login compatibility break, not an account/Host reset.
5. Upgrade Agent Host before new enrollment. Existing enrolled legacy device
   credentials remain compatible, but cannot rotate until the Host advertises
   durable credential support. New invitations reject obsolete clients. Stop
   and restart an installed daemon to apply a new package and local policy.
6. Verify sign-in, session-link recovery, an updated Host's enrollment, renewal,
   rotation, another-browser revocation and the actual native cancellation
   behavior on the chosen deployment.

Rolling back Relay UI/runtime alone loses the new controls. Rolling back Gateway
removes enforcement and cannot renew new opaque continuations, so expect another
sign-in transition. Keep additive SQL columns/tables during an application
rollback and preserve the deployment secret. Older Host binaries lack the
credential-save handshake and local policy; do not use them for new enrollment.
Test any rollback against a copy of persistent state before touching production.
A secret rotation is a separate coordinated operation because existing Relay
storage is bound to that secret; changing only the environment value can make
persistent state unreadable.

## Account and workstation actions

The repository cannot turn on account MFA or protect an unlocked phone. Enable
strong authentication/passkeys for the Gateway identity provider and Cloudflare
account, keep recovery codes offline, require device screen locks, and review
active browser access periodically. Check that public SSH/Docker ingress exposes
only HTTPS and the intended administration path. Configure ingress rate limits
for the Agents domain without challenging the machine-to-machine Host WebSocket
or Gateway service endpoints indiscriminately.

Previously exposed live pairing/device credentials should be explicitly revoked
or rotated after the updated Host is available. Do not paste credentials into
chat, screenshots or commits. These account changes, credential rotation and
production rollout are operator actions; this implementation does not perform
them automatically.

## Repeatable local validation

The protocol/security suites can use recorded providers and real loopback
HTTP/WebSocket transports. To avoid starting the optional installed CLI probes:

```sh
pnpm build
pnpm -r --workspace-concurrency=2 run test \
  --exclude '**/*.local.test.ts' --exclude '**/tests/native.test.ts' \
  --exclude '**/codex-host-process.test.ts' \
  --hookTimeout=30000
pnpm typecheck
pnpm compatibility:update
pnpm compatibility:check
```

Wrap direct recursive test commands in an outer process deadline when running
them outside the root test runner. The package commands set per-test deadlines.
The ordinary root `pnpm test` also runs installed native CLI fixtures; it is not
an offline-only command.

The cross-project browser contract uses an isolated Gateway test database and
synthetic accounts. It starts no provider CLI:

```sh
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/gateway-worktree \
  pnpm test:gateway-relay
pnpm build:relay
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/gateway-worktree \
  AGENT_REMOTE_TEST_RUNTIME=workers pnpm test:gateway-relay
```

The script owns its temporary processes and free ports and enforces an outer
deadline. Its synthetic fixture credentials must never be used in production.
Native sandbox effectiveness and provider-specific cancellation on the actual
workstation remain a separate acceptance step from protocol regression.

### Signed-in browser inventory

The hosted Security panel groups repeated sign-ins using a server-signed,
HttpOnly, host-only browser cookie. This identifier grants no access and is
separate from the session credential. It survives sign-out and rolls its one-year
expiry on authenticated status/refresh responses. Grouping is scoped to the
account; browser names, operating systems, and network addresses are not identity.
Clearing site data, private browsing, and separate browser profiles can create
separate entries. Legacy sessions are linked only when their existing credential
or a verified browser cookie identifies them, never by matching a label.

The inventory shows browsers active within the last seven days, with the current
browser first and other browsers ordered by latest activity. Each row can expand
the latest observation per UTC day within that rolling window. These are activity
observations from retained sign-ins, not a complete login audit. Session expiration
and sign-out can remove their history. The seven-day filter does not expire access.
Signing out a row revokes all credentials in that account's browser group, including
older credentials; signing out all browsers also covers entries outside the window.
