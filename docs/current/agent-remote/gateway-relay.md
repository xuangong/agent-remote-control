# Gateway-authenticated Relay

The optional hosted mode reuses Copilot API Gateway user login and the existing
Agent Host uplink protocol. The gateway is the identity authority; Node runs the
Relay and serves the built controller. Agent traffic travels directly between
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
AGENT_REMOTE_BIND=127.0.0.1 AGENT_REMOTE_PORT=5910 pnpm start:gateway-relay
```

The three authentication variables above must already be exported. `AGENT_REMOTE_WEB_DIST`
can override the built controller directory; the default is
`packages/agent-remote-lab/dist`. `AGENT_REMOTE_READY_FILE` optionally writes a
non-secret JSON readiness record for supervisors.

Put a TLS reverse proxy in front of this single Relay process, forwarding HTTP
and WebSocket upgrades for the entire Relay origin. Preserve the browser Origin
header. Do not rewrite it to the gateway origin or trust a caller-provided
forwarded identity header. In a container, use `AGENT_REMOTE_BIND=0.0.0.0` and
restrict network exposure at the ingress. The configured public Relay origin is
returned in pairing invitations even when Node listens on loopback/private ports.

No provider CLI needs to run on the Relay. Sign in to the gateway, open
`/agent-remote`, and press **Open remote controller**. In the controller choose
**Pair Agent Host** and generate a key. On the workstation:

```sh
export AGENT_HOST_SERVER=https://agents.example.com
export AGENT_HOST_REMOTE_KEY=<pairing-key-from-controller>
export AGENT_HOST_PROVIDERS=codex,claude,copilot
export AGENT_HOST_WORKSPACE=/path/to/workspace
pnpm agent-host start
```

Use the existing DSH Host plugin configuration with the same `serverUrl` and
`remoteKey` for DSH. A running Host can update its uplink with `pnpm agent-host pair`.
After the Host appears, choose a provider and attach or create a session.

## Authentication and lifecycle boundaries

| Surface | Boundary |
| --- | --- |
| User authorization | Gateway checks its authoritative session and enabled-user records when issuing a grant. |
| Browser credential | HS256 JWT, fixed `arc-relay+jwt` type, issuer, Relay audience and user subject; valid at most 15 minutes and never beyond the gateway session expiry. |
| Login handoff | One-time SHA-256 challenge bound to an HttpOnly verifier cookie, valid for five minutes. A forwarded launch link cannot change another browser's user. |
| Cookie | HttpOnly, SameSite=Strict, `__Host-` prefix and Secure on HTTPS; grant removed from URL fragment before exchange. No query-key authentication or credential localStorage. |
| Browser access | Authenticated HTTP and exact-Origin WebSockets; user namespace checked before dispatch. Each broker owns all Host/session IDs. |
| Expiry and revocation | Browser UI unmounts and streams close at grant expiry. Disable/revoke blocks new grants; an issued grant stays valid until expiry. Return through the gateway to renew. No silent renewal. |
| Pairing | Existing process-local key, one installation, 24-hour lifetime. Host connections also close at expiry. Host keys cannot authenticate browser routes; user grants cannot register Hosts. |
| User disable and Hosts | An existing Host connection can survive until its pairing expiry. It cannot bypass browser authorization. This version does not implement immediate per-user Host revocation. |
| Emergency revocation | Change the shared secret on both services and restart Relay; restarting also discards all pairing keys and closes connections. |
| Restart | Relay loses pairings and bindings. Re-pair Hosts, then reattach their native sessions. Native session data stays on the workstation. |
| Capacity | One process, up to 64 user brokers by default; existing per-broker Host, key, stream, payload and RPC limits apply. Expired tenant state is reclaimed. No multi-replica durability. |
| Trust | Gateway and Relay share the signing secret and belong to the same trust boundary. Separate public hostnames are recommended; the Relay does not receive the gateway login cookie in that topology. |

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
second browser context, including rejection of a forwarded login link. It enforces a 90-second process deadline and per-operation
deadlines, cleans up child processes, and saves a screenshot in the reported
temporary evidence directory. Install Playwright Chromium if the browser is not
already available (`pnpm --filter agent-remote-lab exec playwright install chromium`).

`gateway-relay.test.ts` additionally covers session attach, snapshot and bidirectional
stream routing, tenant/Host identity collision, reconnect, role separation and
credential expiry over real HTTP/WebSocket transports. Provider-native behavior
and cloud authentication are outside this integration's test scope.
