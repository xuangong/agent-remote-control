# Gateway-authenticated Relay

The optional hosted mode reuses Copilot API Gateway user login and the existing
Agent Host uplink protocol. The gateway is the identity authority. The hosted Relay serves the built
Controller through Node/Docker or Cloudflare Workers. See [deployment](deployment.md)
for runtime setup and the independent `agents.xianliao.de5.net` service. Agent traffic travels directly between
browser, Relay and Hosts. Trojan and the gateway's other outbound dial protocols
are not involved.

## Topology

```text
Browser -> Relay /auth/login -> browser-bound challenge
Browser -> Gateway /agent-remote -> signed, relay-only grant
Browser -> Relay /auth/callback -> HttpOnly cookie -> private controller
Agent Host -- outbound WSS + pairing key --> Relay
Browser   -- HTTPS/WSS + user cookie      --> Relay -> user's Host
```

Each gateway user gets an independent broker and browser storage namespace.
Provider discovery, skills, children, session history, commands and resources
retain their existing provider capability boundaries. The integration neither
adds account storage to this project nor imports gateway source at runtime.

## Configure both services

Set the same three environment values on the gateway and Relay:

```sh
AGENT_REMOTE_RELAY_URL=https://agents.example.com
AGENT_REMOTE_ISSUER=https://gateway.example.com
AGENT_REMOTE_SIGNING_SECRET=<shared-random-secret>
```

Generate the secret with `openssl rand -base64 32` and place it in the services'
secret stores. URLs must be origins without paths, query strings or credentials.
HTTPS is required except for loopback HTTP development. Do not use an LLM API key
as the signing secret. The gateway accepts real `ses_` user sessions for launching
controllers; LLM API keys, legacy user keys and development auth are not accepted.

The gateway works on Bun or Cloudflare Workers. For Cloudflare, provision the
three values as Worker configuration/secrets before deploying; existing `initEnv`
wiring exposes them. No migration is required. For Bun/Docker, pass them as runtime
environment variables. Its new entry is `https://gateway.example.com/agent-remote`.

## Build and start the Relay

From this checkout, with Node 22+ and pnpm 10:

```sh
pnpm install --frozen-lockfile
pnpm build
AGENT_REMOTE_BIND=127.0.0.1 AGENT_REMOTE_PORT=5910 \
  AGENT_REMOTE_STATE_DIR=/var/lib/agent-remote-relay pnpm start:gateway-relay
```

The three authentication variables above must already be exported. `AGENT_REMOTE_WEB_DIST`
can override the built controller directory; the default is
`packages/agent-remote-lab/dist`. `AGENT_REMOTE_READY_FILE` optionally writes a
non-secret JSON readiness record for supervisors. Hosted mode persists state in
`AGENT_REMOTE_STATE_DIR/state.json`; the default directory is
`~/.agent-remote-control/gateway-relay`. Mount this directory on durable storage.
Only one Relay process may own it. The snapshot contains device credential hashes,
browser session records and native bindings, never transcript content. Writes are
atomic, mode 0600, authenticated to the signing secret and configured origins.

Put a TLS reverse proxy in front of this single Relay process, forwarding HTTP
and WebSocket upgrades for the entire Relay origin. Preserve the browser Origin
header. Do not rewrite it to the gateway origin or trust a caller-provided
forwarded identity header. In a container, use `AGENT_REMOTE_BIND=0.0.0.0` and
restrict network exposure at the ingress. The configured public Relay origin is
returned in pairing invitations even when Node listens on loopback/private ports.

No provider CLI needs to run on the Relay. Sign in to the gateway, open
`/agent-remote`, or use **Agent Remote** in the gateway navigation. The login handoff proceeds automatically; a manual button remains as a fallback. In the controller choose
**Pair Agent Host** and generate a key. On the workstation:

```sh
export AGENT_HOST_SERVER=https://agents.example.com
export AGENT_HOST_REMOTE_KEY=<pairing-key-from-controller>
export AGENT_HOST_PROVIDERS=codex,claude,copilot
export AGENT_HOST_WORKSPACE=/path/to/workspace
pnpm agent-remote-controller start
```

Use the existing DSH Host plugin configuration with the same `serverUrl` and
`remoteKey` for DSH. A running Host can update its uplink with `pnpm agent-remote-controller pair`. Successful
managed Host registration saves private connection/provider settings in its state
directory. Subsequent `pnpm agent-remote-controller start` can reuse them without exporting the
key again. Server/key overrides must be supplied together. Explicit re-pairing of
the same installation rotates its credential and rejects the previous key.
After the Host appears, choose a provider and attach or create a session.

## Authentication and lifecycle boundaries

| Surface | Boundary |
| --- | --- |
| User authorization | Gateway checks its authoritative session and enabled-user records when issuing a grant. |
| Login handoff | Signed `arc-relay+jwt` grant with fixed issuer/audience/subject and browser challenge. It expires in at most 15 minutes and is consumed through the five-minute one-time verifier exchange. |
| Browser credential | Random HttpOnly cookie; only its hash is persisted. An encrypted Gateway continuation allows server-side checks of the original login without forwarding a plaintext Gateway login token. |
| Cookie | SameSite=Strict, `__Host-` prefix and Secure on HTTPS. No query-key authentication or credential localStorage. |
| Automatic renewal | Relay rechecks authority every 60 seconds; access leases last at most 120 seconds. The browser refreshes without unmounting the controller or reconnecting valid streams. |
| Browser sleep | On waking after lease expiry, hide and disable the mounted controller during a maximum five-second authority check. Success preserves draft/side state; denial, error or timeout clears the private view. |
| Revocation | Logout deletes that Relay browser session and closes its streams. Gateway login revocation blocks the corresponding browser at the next authority check; user disable also blocks Hosts. The maximum existing-authority window is 120 seconds. |
| Pairing | A new invitation expires after ten minutes. First registration binds the same opaque key to one installation as a durable device credential. Existing native Host and DSH clients keep their wire format. |
| Devices | Choose a Host, then **Revoke Host** and confirm. Keys are removed before success, active connections close, and the device cannot reconnect with the old key. An explicit new pairing rotates credentials. Browser logout does not unpair devices. |
| Authority outage | A failed check cannot extend a lease. Expired access stops; Host receives retryable 1013/503, allowing automatic recovery when Gateway returns. Actual denial uses terminal 1008/401 and requires operator action. |
| Restart | Persisted Host IDs and native bindings survive. Existing Host clients reconnect; browser sessions are revalidated against Gateway; restored bindings reattach native sessions before forwarding. Native session content stays on the workstation. |
| Emergency reset | Stop Relay, rotate the shared secret on both services and archive/remove the old Relay state before restarting. Old signed state and continuations intentionally fail validation with a new secret. All devices must pair again after this reset. |
| Storage and capacity | Single process per state directory, default 64 tenant brokers, 1024 browser sessions and existing per-broker limits. No multi-replica or network-filesystem coordination. Keep the state directory private. |
| Trust | Gateway and Relay share a root secret and are in one trust boundary. The continuation is opaque by protocol, not cryptographically isolated from a compromised service holding that secret. Separate public hostnames keep the Gateway login cookie off Relay. |

State locking also serializes recovery of a dead process's lock. If a process is
killed during the short recovery critical section, startup conservatively refuses
the remaining `state.json.lock.recovery` file. Confirm no process owns that state
directory before removing the stale recovery marker. An invalid snapshot, changed
origin or wrong secret is a startup error, never an implicit empty-state reset.

The local `pnpm start` / fixture workflow remains available without gateway auth.
The authenticated server has no fallback route into that local fixture server.

## Regression without CLI agents

Both projects must be built. Point the explicit test-only environment variable to
the gateway checkout containing its integration fixture:

```sh
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/copilot-api-gateway-worktree \
  pnpm test:gateway-relay
```

The harness starts an in-memory SQLite gateway and the actual Relay entrypoint on
free loopback ports, opens Chromium, follows the real login handoff, connects a
scripted WebSocket Host, reads its session catalog, and verifies isolation in a
second browser context, including rejection of a forwarded login link, automatic entry, session renewal, actual Relay process restart, stable Host/native binding recovery, device revoke and logout. It enforces a 90-second process deadline and per-operation
deadlines, cleans up child processes, and saves a screenshot in the reported
temporary evidence directory. Install Playwright Chromium if the browser is not
already available (`pnpm --filter @orchardworks/agent-remote-lab exec playwright install chromium`).

`gateway-relay.test.ts` additionally covers session attach, snapshot and bidirectional
stream routing, tenant/Host identity collision, reconnect, role separation and
credential expiry over real HTTP/WebSocket transports. Lifecycle tests also use the production Host uplink client to verify automatic recovery after authority failure, and a delayed-registration peer to verify revoked sockets cannot recover control. Provider-native behavior
and cloud authentication are outside this integration's test scope.

## Shared Hosts and session creation allowance

In the Gateway Dashboard, open **Agent Remote**, choose **Manage sharing** on an
owned Host, enter an existing user's email and set a total session creation limit
from 0 to 10000. The recipient sees the Host and its used/total allowance in both
Gateway and Controller. Opening a Host preserves that selection through login.
The Host continues to use one uplink; each browser session uses a logical stream.

The allowance is cumulative per Host and recipient, across all providers. Each
successful Remote `create` consumes one unit. This includes side conversations
created by Controller. Existing sessions, reconnects and extra browser windows do
not consume additional units. Completing a task, archiving a conversation, closing
a page, revoking a share and granting it again never reset usage. Owners may raise
or lower the total; lowering below usage blocks new creates without blocking
existing sessions. The owner retains management access to the Host and its sessions.
Recipients see only their own created sessions, not the owner's or other recipients'
catalog. Native child sessions inherit their parent creator even when the Host
owner opens the child first. Child attachment checks the parent's reported native
children before dispatching it to the provider.

The Relay persists a quota reservation before forwarding a creation request.
Concurrent requests cannot overspend the final unit; retries with the same operation
ID and settings reuse the result. User operation IDs are scoped into UUIDs before
forwarding to the Host. Known pre-creation rejection releases a reservation. An uncertain
native or transport outcome retains its reservation, including after Relay
restart, and returns `creation_outcome_unknown` on retry instead of creating a
second session. Used allowance therefore includes unresolved reservations. There
is currently no automatic orphan reconciliation or reservation-release UI; the
owner can increase the total after investigating. A known completed binding can be
recovered from the persisted creation ledger without another native creation.

Revoking a share blocks subsequent HTTP and stream traffic and closes only that
recipient's streams, discarding buffered commands. It does not undo a native
operation already accepted or stop its ongoing task. Unpairing a Host is a separate
owner action which removes the device and its session bindings; pairing it again
creates a new Host identity. Sharing cannot restrict the agent's filesystem or
shell authority. The quota applies to user-created Remote sessions; provider-native
automatic subagents and CLI activity outside Remote are not metered by this feature.

Gateway control uses a separate, purpose-bound `arc-gateway-service+jwt` proof on
`POST /gateway/control`, signed for the exact request body and valid for at most
60 seconds. Browser cookies/origins, wrong direction/purpose and replayed proofs
are rejected. Gateway resolves recipients and authenticates callers using the
live user/session repositories. Grants, creator bindings and allowance state live
in the Relay's existing signed state file; Gateway remains the user identity
source and does not proxy session content. The feature keeps the existing
single-process, single-state-directory deployment boundary. Existing broker capacity
limits also apply: at most 4096 bound sessions per owner namespace, independently
of a recipient's configured allowance.

The cross-project browser harness also verifies sharing through actual Gateway
APIs, selected-Host login, filtered recipient catalogs, cumulative quotas,
idempotent retries, restart persistence and revoke/regrant. Provider CLI execution
and a complete Host-wide activity inventory are outside this validation.

## Local previews and Markdown resources

See [local previews](local-previews.md) for same-origin preview paths and the optional separate hostname, HTTP/SSE/WebSocket transport, Controller registration lifecycle, and session-scoped Markdown image loading.
