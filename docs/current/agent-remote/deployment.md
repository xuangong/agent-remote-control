# Agents deployment

Agents has two independent runtime targets: Cloudflare Workers for the public
service and Node/Docker for an SSH server. Local Docker can run either the Node
entry or the actual Workers/workerd entry. Both use the same hosted Relay core
and the existing Agent Host protocol.

Read [Personal access security](security.md) before upgrading an existing service;
its rollout order and re-login boundary preserve existing device and sharing state.

## Production ownership

| Service | Public origin | Owns |
| --- | --- | --- |
| Agents | `https://agents.xianliao.de5.net` | Controller assets, browser-bound login exchange, paired Hosts, connection status, sharing, session bindings and cumulative creation allowance |
| Gateway | `https://token.xianliao.de5.net` | User accounts, login sessions, enabled-user checks and recipient identity resolution |
| Agent Host | Outbound connection to Agents | Native provider sessions, workspace access and execution |

The Agents Worker uses its own SQLite Durable Object namespace. It does not bind
the Gateway's D1, KV or R2 resources. Gateway calls the Agents control endpoint;
it does not keep a second quota or live connection database. Transcripts remain
on Hosts and are streamed through Relay when requested.

Both service origins are Cloudflare **Custom Domains**, so their authenticated
server-to-server fetches work in the same Cloudflare zone. A wildcard Worker
Route is not a drop-in substitute. The configuration uses the exact Agents domain
and disables unrelated preview entrypoints. Cloudflare creates the domain's DNS
record and certificate when the Custom Domain is provisioned. Existing conflicting
DNS records must be resolved explicitly before deployment.

## Configuration

Configure these values on both services:

```dotenv
AGENT_REMOTE_RELAY_URL=https://agents.xianliao.de5.net
AGENT_REMOTE_ISSUER=https://token.xianliao.de5.net
AGENT_REMOTE_SIGNING_SECRET=<same-random-secret-on-both-services>
```

Generate a new secret with `openssl rand -base64 32`; store it in the platform's
secret store or a private environment file. Never commit the value. Issuer and
Relay must be canonical origins, with HTTPS except for explicit loopback testing.
Using another Gateway hostname changes the configured identity authority; it is
not an alias to switch implicitly after pairing users and Hosts.

Gateway's corresponding setup is documented in its
`vnext/docs/agent-remote-relay.md`. Build/deploy that project's integration from
its own checkout. Agents does not import sibling source or workspace packages.

## Cloudflare

Build from the Agents worktree with Node 22+ and pnpm 10:

```sh
pnpm install --frozen-lockfile --registry=https://mirrors.cloud.tencent.com/npm/
pnpm build:relay
pnpm --filter @agent-remote-controller/agent-remote-cloudflare run build
pnpm --filter @agent-remote-controller/agent-remote-cloudflare exec wrangler deploy --dry-run
```

The Wrangler configuration owns the `agents.xianliao.de5.net` Custom Domain,
static assets, `RELAY` binding and SQLite migration for `RelayObject`. One stable
`primary` object coordinates the deployment. Callers cannot select another object
or supply a trusted owner identity.

After reviewing the dry-run, configure the shared secret on both applications
and deploy using the respective project workflows. For Agents:

```sh
pnpm --filter @agent-remote-controller/agent-remote-cloudflare exec wrangler secret put AGENT_REMOTE_SIGNING_SECRET
pnpm --filter @agent-remote-controller/agent-remote-cloudflare exec wrangler deploy
```

Gateway keeps its existing route and resources; set its secret using Wrangler
from `vnext/apps/platform-cloudflare`. Deploy the reviewed Gateway integration
separately. Do not reset or copy its production database for this integration.

Validate production `/health`, login redirect/cookies, Host registration, sharing,
Controller streams and reconnect over the public TLS domain. A successful local
workerd test or deployment dry-run does not establish public DNS/TLS readiness.

## Local Docker

First build the selected Gateway worktree's image without replacing an existing
Gateway container. Run from that checkout:

```sh
docker compose --project-name arc-gateway-runtime \
  -f docker-compose.vnext.yml build gateway-vnext
```

Then run from the Agents worktree, selecting one runtime:

```sh
pnpm relay:local up --runtime node \
  --gateway-image arc-gateway-runtime-gateway-vnext --build
# Or, independently:
pnpm relay:local up --runtime workers \
  --gateway-image arc-gateway-runtime-gateway-vnext --build
```

`--build` builds the Controller/Relay artifacts before building the runtime image.
Workers uses pinned Wrangler with local workerd and local Durable Object storage;
it does not use a remote Cloudflare binding. Providers/CLI agents are not installed
in either Relay image.

The local Workers image installs its pinned toolchain through the Tencent npm
proxy by default. Set `AGENT_REMOTE_NPM_REGISTRY` to select another public package
registry for the Compose build. This only affects dependency installation in the
image; it does not change global npm settings or the Gateway/Relay runtime origins.
For direct Docker builds, pass `--build-arg NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/`.

The launcher chooses free loopback ports and saves each runtime's origins and
random shared secret in private `.runtime/relay-<runtime>/` files. Subsequent runs
reuse those ports and the saved Compose project identity. New project names include
a checkout-specific suffix so another worktree cannot replace or stop this stack.
Do not copy a running stack's private settings into another checkout. Existing
saved project names are preserved for continuity. Optional `--gateway-port` and `--relay-port` select the ports
on first launch. Changing saved origins requires an explicit state migration or
reset; the launcher rejects an implicit change.

Gateway and Relay share a Docker network namespace, allowing the browser and
both services to use exactly the same loopback origins. Both published ports
bind to `127.0.0.1`. Each profile has independent Gateway/Relay data volumes.
Configure local Google OAuth if you want to sign in interactively; the ordinary
launcher does not create test accounts or enable a development auth bypass.

After both services are healthy the launcher prints Gateway and Controller URLs.
Manage a saved stack with:

```sh
pnpm relay:local status --runtime workers
pnpm relay:local down --runtime workers
```

`down` preserves data volumes. It affects only that named local stack.

## SSH Docker

Build the production Node target after `pnpm build:relay`:

```sh
docker build --target node -t agent-remote-control:local .
```

Transfer the image through your chosen registry or `docker save` / `docker load`.
On the SSH server, copy `deploy/compose.ssh.yaml` and create a private environment
file based on `deploy/relay.env.example`. Set `AGENT_REMOTE_IMAGE` to the exact
transferred image tag, then:

```sh
docker compose --project-name agents --file deploy/compose.ssh.yaml \
  --env-file /private/path/agents.env up -d --wait
```

Terminate TLS at the server ingress and forward the complete Agents origin to
`127.0.0.1:5910`, including WebSocket upgrades. Preserve the browser's Origin
header. Back up the named state volume while the Relay is stopped. Only one
Node process may own the state directory. Do not mount it into multiple replicas
or place it on a network filesystem as a substitute for coordination.

Node uses an OS advisory lock held for the process lifetime, so an abrupt process
or container exit releases ownership without relying on reusable PIDs. Linux
requires `/usr/bin/flock` (verified by the image build); direct macOS execution
requires `/usr/bin/python3` with `fcntl`. A missing locking tool fails startup.
Stop the previous Relay before upgrading from a version that used PID lockfiles;
the old and new locking schemes must not run concurrently on one state directory.
Do not delete a lockfile while a Relay is running.

The CFW and SSH targets have independent devices, cookies and state. Selecting
SSH is an alternative deployment, not an automatic replica of the CFW service.
An origin must route to exactly one chosen state authority.

## Regression matrix without provider CLIs

The browser contract uses a real Gateway with an isolated SQLite database,
scripted WebSocket Hosts and Chromium. It does not execute native provider CLIs.
Build both runtime artifacts and the Gateway test image first, then run from
Agents:

```sh
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/gateway-worktree \
  AGENT_REMOTE_TEST_RUNTIME=node pnpm test:gateway-relay
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/gateway-worktree \
  AGENT_REMOTE_TEST_RUNTIME=workers pnpm test:gateway-relay
```

To run the same contract inside Docker, additionally set
`AGENT_REMOTE_TEST_DOCKER=1` and
`AGENT_REMOTE_GATEWAY_IMAGE=arc-gateway-runtime-gateway-vnext`.
The harness uses `deploy/compose.test.yaml`, an explicitly selected test-only
Gateway entry with temporary Alice/Bob identities. It never uses production user
data or OAuth credentials. Test stacks get unique names, free loopback ports and
volumes which the harness removes on completion. The regular local launcher
does not apply this override.

Every run has an outer deadline and bounded startup/HTTP/browser operations.
The restart scenario kills the Relay with SIGKILL and replaces its process or
container while preserving its data, exercising recovery without graceful cleanup.
Evidence records identify the runtime and screenshot location. A Node-only run
cannot certify Workers behavior, and neither can certify provider-native SDKs.

## Capacity and recovery boundaries

- One stable Durable Object coordinates all tenants in a CFW deployment. It avoids
  competing edge-isolate copies of authorization and quota state. This version
  does not claim horizontal scaling beyond one coordinator's limits.
- Workers uses standard native WebSockets. Active sockets keep the object active;
  this version does not implement hibernation or promise its cost savings.
- Persisted state includes device hashes, login challenges, consumed service
  proofs, sessions, sharing, bindings and creation reservations. Live sockets and
  transcripts are not persisted. Restarted Hosts appear offline until reconnect.
- Grant and quota changes must commit before success or native create dispatch.
  Unknown creation outcomes retain allowance after restart, preventing automatic
  duplicate native creation. Storage failure closes access instead of publishing
  uncommitted permissions.
- Gateway authority renews every 60 seconds with a maximum 120-second lease.
  Request/frame checks enforce expiry even if an alarm is delayed. A failed
  authority check cannot prolong access.
- Browser authorization is checked when an HTTP request is admitted. An already
  pending Host catalog/snapshot RPC does not recheck the browser lease before
  returning its result. This existing behavior means logout/expiry is not a
  cancellation guarantee for admitted HTTP requests; active stream revocation
  and checks on subsequent requests remain enforced.
- Node snapshots remain signed and bound to the configured secret and origins.
  DO records also validate the configuration binding. Secret rotation or origin
  changes require an explicit migration/reset; neither silently starts empty.

Cloud-only acceptance still includes DNS/TLS, actual account routing, deployment
replacement/reconnect and realistic coordinator load. Record those results before
claiming the public deployment is ready for use.

References: [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

### Workers transport measurement

The native Workers WebSocket API does not expose `bufferedAmount`, and `send`
returns no completion promise (confirmed in local workerd). Node retains its
measured per-socket send-queue cutoff. Workers enforces the shared application
frame limits, command-buffer bounds and stream admission limits, but cannot claim
the same cutoff for its internal outgoing queue. It reports the measurement as
unavailable, not as an empty queue. Slow-peer memory behavior remains part of
production load acceptance; no additional acknowledgement wire protocol is added.
Incoming frames are assembled by workerd before application size validation.

## Verified local acceptance

The 2026-09-14 implementation was exercised with real Gateway SQLite identities,
scripted Host WebSockets, and Chromium against Node, Node Docker, Workers/workerd,
and Workers Docker. The contracts verify login, selected/shared Hosts, per-user
catalogs, cumulative creation allowance, idempotent retry, unknown reservations,
revocation, logout and SIGKILL recovery using the same retained state.

Focused regression includes 31 portable-core tests, 43 Node HTTP/WS and state
adapter tests, and 7 real workerd scenarios. Workers scenarios additionally cover
atomic SQL rollback, persisted configuration fingerprints, alarm renewal and
storage-failure recovery, frame limits and registration deadlines. Gateway's local
CI passed 3593 tests with one existing skip, plus type checks, lint, UI build and
Cloudflare dry-run. No provider CLI or production identity was used for these
runtime contracts.

The final ARC workspace build and type checks passed. The workspace regression
passed 1479 tests with six skips while excluding native CLI test entrypoints:

```sh
pnpm -r run test --hookTimeout=30000 \
  --exclude '**/*.local.test.ts' --exclude '**/codex-host-process.test.ts'
```

Run that command with an outer process deadline (540 seconds for this acceptance).
Compatibility metadata was regenerated and verified after the final test-script
change. The complete runtime diff and the final packaging adjustments passed
independent review; the admitted-HTTP authorization boundary above predates this
runtime extraction and is retained explicitly.

This evidence does not constitute an actual Cloudflare or SSH deployment. Public
DNS/TLS, the production login account, deployment replacement, and realistic
streaming load remain deployment acceptance checks. The worktrees do not modify
or replace existing local service stacks when running the isolated contracts.

## Production deployment: 2026-09-14

The independent `agent-remote-control` Worker is deployed on the Custom Domain
`agents.xianliao.de5.net`, version `f96ce501-084b-4828-a7f9-2bb993d019b2`.
It owns its `RELAY` SQLite Durable Object namespace and Controller assets.
The paired `copilot-gateway-vnext` Worker is enabled at `token.xianliao.de5.net`,
version `31469215-d142-4a33-802e-219fe9937fe8` (Gateway commit `3dd3661c`).
Existing Gateway D1, KV, R2 and OAuth bindings were retained; no D1 migrations
were pending and no production test users were created.

Both versions received the same generated signing secret using Wrangler's
`--secrets-file` deployment option. A private recovery copy is retained at
`.runtime/production-agents/secret.json` in the primary Agents checkout, mode
0600, outside version control. Back it up securely; do not regenerate it when
rebuilding, redeploying or removing a development worktree. Existing durable
state is bound to this secret and the configured origins.

Public smoke checks passed for HTTPS, both health endpoints, Controller assets,
the Gateway authentication marker, the browser-bound login redirect and Secure
HttpOnly challenge cookie. Gateway reports `enabled: true`. Unauthenticated Host
access returns 401 and missing assets return 404. Both services accept their
correct service proof type and reject invalid proofs; Relay also rejects replay
of a consumed control proof. Gateway continues rejecting invalid inference API
keys. These checks do not claim a completed production user login, paired Host,
native provider invocation, replacement/reconnect test or load acceptance.

Gateway's Relay fetch was additionally adapted to Workers' supported manual
redirect mode. Its complete CI passed 3594 tests with one existing skip. A real
local Gateway workerd instance with D1 sessions verified successful control
requests and refusal of all five redirect statuses without forwarding credentials.

For first use, open `https://agents.xianliao.de5.net`, sign in through the existing
Gateway account, and create a Host pairing invitation in Controller. Use that
invitation's connection details with Agent Host. No separate Agents account,
Google OAuth application or manually created Durable Object is required.
