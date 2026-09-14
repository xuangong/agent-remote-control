# Cloudflare and Docker Relay runtimes

Status: approved for implementation. The production Cloudflare application,
Controller, and Relay state belong to the separate `agents.xianliao.de5.net`
service. Cloud resource changes are a separate deployment step.

## Goal

Deploy the authenticated Relay and Controller to Cloudflare Workers at
`https://agents.xianliao.de5.net`. Support an independent Node/Docker deployment
on an SSH server and local Docker testing of both runtime implementations.
Cloudflare is a production target, not a proxy in front of a required Node server.

Gateway remains the identity authority. Agent Hosts and their native providers
remain on workstations. Preserve the existing public Remote protocol, Host uplink,
browser login handoff, Host sharing, and cumulative session creation allowance.
Do not deploy, change DNS, push, or provision cloud resources as part of this design.

## Approaches and recommendation

1. **Shared Relay core with Node and Workers adapters (recommended).** Workers
   uses a SQLite-backed Durable Object for coordination and persistence. Docker
   uses the same core with Node transport and private durable local storage.
   Runtime behavior is tested against one transport contract suite.
2. **Separate Workers implementation.** Easier initial extraction, but duplicates
   authorization, quota accounting, and recovery behavior. Reject because the two
   implementations would diverge in precisely the security-sensitive behavior.
3. **Worker forwarding to Docker.** Preserves current code but still requires an
   SSH server in production. Reject because it does not meet the production goal.

## Runtime boundary

Extract hosted Relay logic from the lab server into a dedicated package. The lab
entry remains a compatibility wrapper. Keep the public protocol, existing generic
Relay package, native adapters, and client renderer at their current boundaries.

The shared core owns routing decisions, authenticated principals, pairing and
device transitions, Host/session ownership, sharing, quota reservations, native
RPC correlation, logical streams, lease decisions, and recovery semantics.
Its interfaces accept Web Request/Response values and explicit transport,
persistence, clock, and scheduling dependencies. They do not accept Node Server,
IncomingMessage, Duplex, or a `ws` instance. Runtime adapters perform bounded body
reads and WebSocket frame validation using the same configured limits.

The Node adapter supplies HTTP upgrades, `ws`, timers, static files, and the
existing signed atomic state file. The Workers adapter supplies `fetch`, native
WebSocket pairs, Durable Object storage, alarms, and Worker static assets. Do not
emulate a Node HTTP server inside Workers. Hashes, signatures, and random values
must retain byte-level compatibility; use portable crypto or an explicitly
tested runtime crypto adapter.

## Cloudflare topology and capacity

Use a separate Worker application from Gateway. Public requests reach that
Worker, which serves Controller assets and forwards authentication, control,
Host uplink, and Controller API/stream requests to one stable Durable Object per
Relay deployment. Route using a server-configured object name; never use an
untrusted request parameter to create an independent authorization realm.

The first version deliberately preserves today's single Relay coordination
boundary. Tenant brokers remain logically isolated inside that object. All Host
connections, sharing decisions, creation reservations, and matching browser
streams meet in the same coordinator. Multiple edge Worker instances therefore
do not maintain competing copies of authorization or quota state.

This is not unlimited horizontal scaling. One object is a throughput and memory
boundary for this version, comparable to the current single Node process. Keep
the existing admission limits as upper bounds, add bounded queues and explicit
capacity errors, and measure realistic streaming load before setting production
capacity. Do not claim existing Node tenant/session limits are proven Cloudflare
capacity. Per-owner or per-Host object sharding requires a separate directory and
cross-object lifecycle design and is outside the initial runtime port.

Gateway instances query the same Relay authority; Gateway does not replicate the
Relay's connection maps or session allowance. Continue to configure one canonical
Gateway issuer per deployment. Separate Gateway installations do not become one
identity system merely by sharing a signing secret.

## Persistence and concurrency

Replace fire-and-forget state-change callbacks with an awaited commit boundary.
Stage security-sensitive mutations, durably commit them, then publish their
in-memory state and perform external effects. A failed commit must neither send
a native creation request nor leave an uncommitted grant usable in memory.

Creation reserves quota before dispatch. Serialize the allowance check and
reservation insertion in one transaction. Release the mutation lock before
waiting for a Host response so that incoming RPC replies can be processed.
On completion, commit the binding and creation result before acknowledging
success. Preserve request fingerprints, namespaced native request IDs, and the
existing unknown-outcome policy across crashes and retries. Never repeat native
creation merely because a Worker was restarted.

Persist device credential hashes, user sessions, tenant identities, sharing,
reservations, and native bindings. Also persist expiring login challenges and
consumed service-proof IDs so an object restart cannot make one-time operations
reusable. Store versioned records in DO SQLite transactions rather than putting
the entire Relay snapshot in a single value. Retain origin/issuer configuration
binding and explicit failure on incompatible state. Secret rotation and state
reset remain explicit operations.

Node retains compatible reading of its existing state file and fails explicitly
on unsupported versions. New records use a versioned migration. Node and CFW
deployments have independent state: this work does not add live replication,
active-active operation, or automatic transfer of paired devices between them.
Cloudflare does not need a shared filesystem, Workers KV, or a Gateway database
table for Relay authorization and quota decisions.

## WebSocket lifecycle and authorization

The initial Workers adapter uses the native standard WebSocket API. Active
connections keep the coordinator active; this version does not promise idle
hibernation or its associated cost savings. This is an explicit production cost
tradeoff, not a claim that Durable Objects cannot hibernate. A later hibernating
adapter needs durable stream attachments and recovery of every in-flight native
RPC before it can preserve this broker's semantics.

On deployment or object restart, mark restored Hosts offline until they register
again. Close or fail stale streams and rely on the existing Host reconnect and
Controller snapshot/replay paths. Persist bindings and quota, not live sockets
or transcripts. Treat interrupted non-idempotent operations as unknown unless
their committed result proves completion. Never claim replay restores an
unconfirmed native mutation.

Use a persisted earliest-deadline schedule and one DO alarm for background lease
renewal and expiry cleanup. Alarm handlers must be idempotent, tolerate duplicate
delivery, and reschedule after transient failures. Native request deadlines may
use bounded active timers while an operation is pending. Use request/frame-level
expiry checks as well: delayed alarms must never extend an authorization lease.

Preserve the existing 60-second renewal cadence and maximum 120-second authority
lease. Check current ownership, share status, and session lease before accepting
commands and before forwarding private Host output. Logout, share revocation,
and device revocation durably invalidate access before success and discard
queued unauthorized commands. Authority errors cannot extend a lease. Owner
disable stops its Host access; browser logout does not unpair the Host.

## Docker and local testing

Provide two selectable local Compose profiles:

| Profile | Relay runtime | Purpose |
| --- | --- | --- |
| `node` | Built Node production entry | SSH Docker parity and routine integration testing |
| `workers` | Pinned Wrangler local / workerd with local DO bindings | Exercise the actual Workers adapter without cloud resources |

Each profile runs alongside a local Gateway Docker image built by the Gateway
project. Supply that image explicitly; do not import Gateway source or packages
into the Relay application. Use separate named state volumes for Node and local
DO storage. Local bindings must not use remote production resources or production
credentials. Include a bounded scripted Host harness, with real CLI execution
optional and outside the default regression command.

Public origins must be reachable by the browser and by both services. The local
Compose stack uses a shared network namespace for Gateway and Relay, with
configurable published loopback ports. Consequently their canonical
`http://127.0.0.1:<port>` origins also work for server-to-server requests inside
the stack. Do not silently substitute `http://gateway:port` into signed origins,
relax the production HTTPS rule, or confuse a container's isolated localhost
with the host machine. The profiles are alternatives, not two backends behind
one local Relay URL. Bind published development ports to host loopback.

The SSH production profile runs the built Node entry directly, rather than tsx,
with a durable volume, health check, restart policy, and TLS ingress supporting
WebSocket upgrades. CLI providers are not installed in the Relay image. A local
launcher prints the Gateway entry and Controller URL after readiness checks.

## Project responsibilities and delivery

Agent Remote Control supplies the shared hosted core, Node and Workers entry
packages, Wrangler configuration and DO migrations, Controller assets, Docker
image/Compose profiles, and dual-runtime contract tests. Keep the current local
unauthenticated workbench behavior available independently.

Gateway retains the existing authenticated HTTP integration and its three
configuration values. Its worktree receives paired CFW/Docker configuration
examples, explicit local image/start instructions, and cross-project test
updates. It does not gain a second transcript proxy or a second copy of Relay
authorization state.

Suggested implementation order:

1. Capture the existing Node transport contract and extract the shared core.
2. Add awaited transactional commits and restart-safe expiring records.
3. Add the Workers/DO adapter and run the same contract tests under workerd.
4. Package Node Docker, local Workers Docker, and cross-project launch profiles.
5. Run the full runtime matrix and document measured capacity and limitations.

## Acceptance and evidence

Run observable HTTP/WS tests with per-operation and outer process deadlines:

- Gateway login, browser challenge binding, selected-Host handoff, renewal,
  logout, disabled-user handling, authority outage, and service-proof replay.
- Self-pairing, saved credentials, Host reconnect, device revocation, provider
  discovery, session catalog, history, native child attachment, and resources.
- Two users sharing one Host: filtered catalogs, session isolation, revocation
  of an open stream, and removal of commands buffered before stream readiness.
- Concurrent creation of the final allowed session; idempotent retries;
  conflicting settings; known rejection; unknown results; and post-native errors.
- Real runtime restart during creation, restart after commit, persistence of
  reservations, and restart without resetting allowance on revoke/regrant.
- Storage-failure injection before dispatch and before response publication.
  No native creation or newly effective permission may escape a failed commit.
- Late/duplicate alarms and authority timeouts without extending expired access.
- Browser smoke and session replay against both Node and local workerd stacks.
- Docker build/start/stop/restart using isolated free ports and durable test
  volumes; no production Gateway database or live CLI agents are required.

Run workspace builds, type checks, reviewed compatibility update/check, Gateway
checks appropriate to its changes, and a Cloudflare deployment dry-run. Local
workerd verification is necessary but not evidence of cloud DNS, TLS, routing,
production limits, or deployment behavior. A separate authorized staging smoke
must validate those before claiming production Cloudflare readiness.

## References

- Current implementation: `packages/agent-remote-lab/src/server/gateway-relay.ts`,
  `remote-host-broker.ts`, `host-sharing.ts`, and `gateway-state.ts`.
- [Durable Object coordination and sharding](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- [WebSocket lifecycle and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
- [Cloudflare local development](https://developers.cloudflare.com/workers/local-development/).
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
