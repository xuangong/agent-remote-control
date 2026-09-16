# Authenticated local preview tunnel

Status: design record. The URL shape, on-demand block interaction, Controller-owned registration lifecycle, and self-hosted HTTP and WebSocket tunnel are agreed requirements. Protocol names and operational recommendations below describe the intended implementation, not shipped behavior. This task records the design only.

Follow-up: [stack research and local experiment results](2026-09-16-local-preview-tunnel-research.md) identify an upstream path-mode refinement for base-aware apps and a Workers WS egress-backpressure limitation. Incorporate those findings before finalizing the implementation contract; the original discussion is retained below.

## Purpose and scope

Open a workstation's local web application from a phone through the existing authenticated Relay. Implement the tunnel inside Agent Remote Control; do not depend on Cloudflare Tunnel, Quick Tunnels, or another public forwarding service. Support both HTTP and WebSocket as required capabilities, including streaming responses and development-server hot reload. A static HTML fetch or a rewritten link alone does not satisfy this design.

Use `https://agents.xianliao.de5.net` for both the control site and previews, with `/p/<id>/` identifying registrations and `/_arc/enter` reserved for preview entry. Reuse the existing DNS, HTTPS certificate, and Relay deployment. A separately configured preview origin remains optional. No wildcard certificate or additional hostname is required by the default deployment.

```text
Original URL:
http://127.0.0.1:15811/me?agent=balabala

Preview URL:
https://agents.xianliao.de5.net/p/7f3a/me?agent=balabala

Mapping:
7f3a -> authenticated principal + Host + http://127.0.0.1:15811
```

`7f3a` is an illustrative preview ID, not a public port or credential. Production IDs must be opaque and collision-resistant. The original local port remains `15811`; external browsers connect over HTTPS on port 443. Preserve the path, query string, and browser fragment when building the link. A fragment stays in the browser and is not an upstream HTTP request component.

## Ownership and topology

| Component | Responsibility |
| --- | --- |
| Timeline renderer | Discover local URLs, expose registration actions, preserve original message content, display authoritative status. |
| Frontend preview state | Track registrations across blocks, show the Host preview list, reconcile snapshots and events. |
| Hosted Relay | Authenticate browsers and Controllers, authorize Host access, issue preview entry sessions, route requests, maintain a routing projection, and enforce immediate access revocation. |
| Local Controller | Own registration records and expiry decisions, restrict local targets, open local HTTP/WS connections, and enforce registration validity on forwarding. |
| Relay runtime adapters | Implement the same contract using Workers/Durable Objects or Node/Docker transports. |

```text
Control:
Browser -> authenticated Relay -> existing Controller control uplink

Preview traffic:
Browser HTTPS/WSS -> Relay <-> dedicated outbound Controller tunnel -> local HTTP/WS server
```

The Controller initiates the tunnel connection to the Relay. Return traffic uses that established connection, so the workstation needs no inbound NAT mapping or public listening port. Registration is a machine control operation, not a prompt sent to an AI provider. It must work independently of whether an agent turn is running.

Reuse existing identity, Host registration, authorization, and recovery concepts. Keep bulk preview traffic on a separate authenticated data connection so uploads and slow responses do not block chat or Controller heartbeat traffic. Bind that connection to the authenticated Host, principal scope, and current connection generation; possession of a preview ID cannot attach a tunnel.

## Timeline interaction and registration

Rendering a block never registers a service automatically. Recognize supported loopback HTTP(S) URLs in Markdown links, ordinary text, and code/tool-output blocks without changing the stored transcript. Bare `127.0.0.1:15811/...` can be normalized to HTTP for the action while retaining the original text. Each distinct local target in a block gets an identifiable action.

```text
127.0.0.1:15811  [Open preview]
127.0.0.1:15811  Connecting...
127.0.0.1:15811  Registered  [Open] [Unregister]
127.0.0.1:15811  Expired     [Register again]
127.0.0.1:15811  Unavailable: Controller offline
```

On click, the frontend supplies the session reference, source block/item reference, original target, and an idempotency key to the Relay. The Relay resolves the Host from the authorized session binding; it must not trust an arbitrary browser-supplied Host identity. The Controller validates the target, performs a bounded connectivity check without issuing an arbitrary page request with side effects, and prepares the registration. A reachable port does not prove that every page or WebSocket endpoint works.

Return success only after the Controller has confirmed the registration and the Relay can route it. Return a descriptor with the preview ID, canonical local origin, lifecycle state, expiry metadata, and mapped URL. Repeated clicks for the same principal, Host, and canonical local origin reuse a valid registration. Paths and queries remain per-link details, not separate port registrations. Do not share registrations across principals by default.

Record source session and block references so the Host's preview list can navigate back to where registration occurred. Show target, registration state, availability, and expiry there, with an unregister action. All block references to a reused mapping update together; unregistering one mapping affects every reference to it. Persist references using stable timeline identifiers, not array positions. Do not put secret-bearing query parameters into audit events.

For mobile browsers, make the ready URL explicitly clickable; opening a new tab after an asynchronous registration may be blocked. A failed attempt must offer retry and distinguish authorization failure, Controller offline, unreachable target, and capacity exhaustion.

## Registration state and synchronization

The Controller is authoritative for lifecycle states `active`, `expired`, and `unregistered`. `registering` is a pending frontend operation. Model availability separately, such as `online`, `controller_offline`, and `target_unreachable`; a dropped tunnel or stopped local server is not evidence that a registration has expired.

A registration records its ID, principal/Host binding, canonical target, creation time, expiry policy and computed `expiresAt`, source references, lifecycle state, and revision. The Controller evaluates and persists deadlines and publishes changes. The default renewable lease is one hour. A frontend retaining an iframe, including a minimized one, requests authenticated renewal of both the registration and preview cookie. It stops when the iframe is released. Frontend state cannot unilaterally change expiry. Browser wake can renew an expired record with the same ID while it remains in bounded history, but manual unregister is terminal. No client activity means the lease expires normally.

On expiry or confirmed unregistration, the Controller rejects new streams, cancels local HTTP requests, and closes local WebSockets for that registration before acknowledging the lifecycle change. Relay removes the usable route and closes the corresponding browser connections. For a user unregister request, Relay blocks access immediately even if the Controller is offline, durably remembers the pending removal, and delivers it on reconnect. Until Controller confirmation, display pending unregistration rather than claiming the local record has already been removed.

Synchronize using a full snapshot followed by ordered lifecycle updates. Include an authority epoch and increasing revision so a browser or Relay can detect gaps, ignore stale events, and request a fresh snapshot. Snapshot-to-subscription handoff must buffer intervening updates or resume from the snapshot revision. Send a removal state before pruning records; bound tombstone retention and require a full resync when a cursor is too old.

After a browser refresh, Relay restart, or Controller reconnect, reconcile with the Controller's current records before admitting traffic. Relay's persisted routing projection is not proof of validity. Replay pending removals before reactivation; never resurrect a removed mapping from an older snapshot. Host/credential generation checks reject events and tunnel streams from superseded connections.

Recommended recovery policy: persist registration records locally using the Controller's protected state storage. On Controller startup, evaluate elapsed expiry deadlines before reporting active records. Do not persist live sockets or replay interrupted application requests. If registration state cannot be restored, report mappings as unavailable until reconciled or explicitly registered again; Relay must not fabricate active registrations. Storage failure must not produce a successful registration acknowledgement.

## Self-implemented transport contract

Use a versioned, multiplexed transport over the dedicated Controller-to-Relay WSS connection. Define portable control envelopes and binary body/message chunks; do not encode entire web responses as JSON strings or base64 blobs. Each logical stream binds to a preview ID and tunnel generation and has a unique stream ID. The Relay chooses the registered target; an incoming browser request cannot provide a replacement upstream hostname, URL, or port.

The message families below express required semantics, not finalized public schema names:

| Family | Required information and behavior |
| --- | --- |
| HTTP open | Stream and preview IDs, method, upstream path/query, validated headers. |
| HTTP body | Direction, bounded byte chunks, ordering, and an explicit end-of-body signal. |
| HTTP response | Status and headers before response body chunks; repeated headers preserved where meaningful. |
| HTTP cancellation/error | Correlation, bounded error code, terminal cleanup, and no request replay. |
| WS open/result | Path/query, allowed handshake metadata, offered protocols, accepted protocol or rejection. |
| WS message | Direction, text/binary type, message boundaries, bounded chunks if needed, and ordering. |
| WS close/error | Valid close code/reason where transferable, abnormal termination mapping, and terminal cleanup. |
| Flow control | Per-stream and connection-wide byte credit, bounded queues, fair scheduling, and cancellation priority. |
| Tunnel liveness | Independent data-connection health, timeout, reconnect, and generation fencing. |

The receiver must validate state transitions, sizes, stream ownership, and credit before acting on a message. Bound concurrent streams, headers, individual WS messages, chunk sizes, aggregate queued bytes, and reassembly buffers. Reject excess work explicitly. Backpressure must reach the local request/socket and the browser-side stream where runtime APIs permit it. If a runtime cannot pause a WebSocket producer, enforce a bounded queue and close an overloaded stream rather than claiming lossless unlimited buffering. Configure limits from the lower supported runtime capabilities and validate them under load.

### HTTP behavior

Support ordinary application methods including GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS. Handle WebSocket upgrade through the dedicated WS path. Reject CONNECT, TRACE, and arbitrary forward-proxy requests. HTTP refers to application request/response semantics; it does not require preserving the browser's HTTP/2 wire framing end to end.

Stream request and response bodies as bytes, preserving binary assets, JSON, form uploads, multipart bodies, downloads, and SSE. Deliver response headers and initial chunks without waiting for the complete body. Bound buffering even for large or slow responses. Handle empty bodies and HEAD/204/304 semantics, conditional requests, range requests, and separate Set-Cookie values. Do not retry POST or another interrupted request automatically when the tunnel reconnects.

Normalize hop-by-hop headers and reconstruct Host for the registered local target. Strip Relay credentials and internal routing headers before contacting the local application. Preserve application headers only through explicit forwarding rules. Resolve HTTP redirects in the browser after rewriting eligible Location headers; do not let the Controller automatically follow redirects to an unregistered destination.

If the browser cancels a request, cancel the logical stream and abort the local request. Apply separate connect, header, and inactivity deadlines so SSE and other active long-lived streams are not killed by an ordinary total-response timeout. Registration expiry and access revocation override those deadlines. Before response headers, return a controlled gateway error; after headers have started, abort the stream rather than pretending to change its HTTP status.

### WebSocket behavior

Authenticate and authorize every browser handshake and reconnect. Bind the upgrade to a currently active registration and accepted origin policy. Have the Controller attempt the local WS handshake and report the selected subprotocol before acknowledging a successful browser upgrade. Return a bounded failure if the local service refuses the handshake or the registration is revoked while it is pending.

Forward full-duplex text and binary messages, preserve message order and boundaries, and propagate close and error events in both directions. Large messages require bounded reassembly and explicit rejection above the configured limit. WebSocket extensions/compression, fragmentation, and protocol ping/pong are handled by the respective socket endpoints; the tunnel promises application-message semantics, not byte-for-byte forwarding of every WS frame. Do not select a subprotocol the local server did not accept.

Controller tunnel reconnect restores routing availability, not an existing application WebSocket. Close both ends when transport is lost; the application reconnects and performs any application-level resume itself. Never replay buffered messages into a replacement socket. Expiry, unregister, logout/revocation, or superseded credentials terminate affected sockets even if they are otherwise active. Idle WS health must be distinguishable from stalled Controller transport.

Development-server hot reload is an explicit acceptance flow: a browser opens the preview, loads assets, establishes WSS through the preview path, receives a file-change notification, and reconnects after a temporary tunnel interruption. Merely getting a 101 response does not prove this flow.

## Fixed-prefix application compatibility

Strip exactly `/p/<previewId>` for authorized upstream requests. For example, `/p/7f3a/me?agent=balabala` becomes `/me?agent=balabala`. Treat path/query data as structured URL components; do not repeatedly decode or rewrite query values. Validate encoded separators and dot-segment behavior so normalization cannot switch the routing identity.

A fixed path prefix does not automatically make every local web app work. Root-relative references such as `/assets/app.js` resolve against the preview hostname root, not `/p/7f3a/`; parent-relative references can also escape the prefix. A base element alone cannot repair root-relative URLs. This follows the browser's [URL resolution rules](https://developer.mozilla.org/en-US/docs/Web/API/URL_API/Resolving_relative_references).

Required compatibility work includes HTML URL attributes, CSS URLs/imports, eligible redirect headers, app cookie scope, forms, API calls, and WS/HMR addresses. Prefer applications configured with the preview base path and public WS endpoint. For unconfigured apps, implement and test a bounded adaptation layer for supported patterns. Do not rely on global string replacement of HTML or JavaScript, and do not route unprefixed requests using a mutable 'current preview' cookie or Referer inference: simultaneous previews would collide.

When transforming a body, account for compression, Content-Length, validators, CSP, and integrity metadata; either preserve a valid representation or report the app as requiring configuration. Do not buffer unlimited responses to rewrite them. Opaque computed JavaScript URLs, hardcoded localhost URLs, service workers, and third-party origin assumptions are not transparently solved by registering a port. Service workers require a separate isolation review before support. The implementation must document its supported compatibility cases and display actionable failures for unsupported ones.

## Authentication and target boundary

Opening a preview starts from the existing authenticated control site. Use a short-lived, single-use, audience-bound handoff redeemed at the fixed preview origin to establish a preview-scoped session. Bind access to principal, registration, and current Host authorization. Use host-only Secure/HttpOnly cookies and a reserved authentication namespace; never forward main-site tokens, preview-auth cookies, handoff proofs, or Controller credentials upstream. Avoid placing reusable credentials in preview URLs or access logs.

Require authorization on every HTML, asset, API request, and WS handshake. Revalidate permissions for long-lived streams and propagate revocation to close them. When identity validation is unavailable, deny access. The preview hostname must enter the authenticated preview router before static-asset fallback; there must be no anonymous path or alternate origin that reaches the same local target.

Accept only explicit HTTP(S) loopback targets supported by the Controller. Normalize localhost to an allowed loopback address, validate ports, reject userinfo and non-loopback aliases, and prevent DNS rebinding or redirects from expanding the target scope. Do not expose Controller management listeners, reserved internal ports, or an arbitrary LAN proxy. HTTPS local targets retain certificate validation unless an explicit local trust policy is configured. Map browser WSS to WS for HTTP local origins and WSS for HTTPS local origins.

Treat a port registration as access to that local service, not just the one path mentioned in the timeline. Use Host-level preview permission; session visibility alone must not silently grant arbitrary local port access. Begin with owner-only registration/access unless an explicit Host sharing capability is defined. Do not inherit broad preview rights from an unrelated session share.

The default preview origin is the control site's origin. Browser scripts in a preview can access the control site's authenticated APIs, storage, and other previews as the signed-in principal. Cookie paths are not a security boundary; stripping credentials from upstream HTTP forwarding does not remove these browser privileges. This mode is only for trusted local applications. Every preview request still requires valid Relay-backed preview authorization, so knowing its URL does not grant access. Preserve Origin/CSRF checks and restrictive credentialed CORS. A separately configured preview origin isolates local scripts from the control site, but previews on that origin still share browser privileges; hostile application isolation requires different origins per application.

## Runtime integration and evidence

The core tunnel state machine must be shared by the Node/Docker and Cloudflare Workers implementations. Inject HTTP streaming, WS acceptance/connect, storage, clock, scheduling, and transport interfaces. Keep Node socket objects out of portable protocol types. The Controller remains responsible for workstation access regardless of where Relay runs.

Workers provides [streaming request/response primitives](https://developers.cloudflare.com/workers/runtime-apis/streams/) and a [WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/); their existence does not establish this tunnel's implementation or capacity. Validate adapter behavior using the deployment's actual compatibility date, binary-message representation, close-handshake semantics, and resource limits. Node/Docker must pass the same functional contract suite. Neither deployment requires an external tunnel vendor; both still need a reachable authenticated Relay and the fixed preview hostname certificate.

Source anchors reviewed at `20acc14`:

| Existing boundary | Integration implication |
| --- | --- |
| `packages/agent-remote-web/src/react/MarkdownContent.tsx` | Central Markdown link rendering exists; discovery in code/tool blocks and registration state need additional integration. |
| `packages/agent-remote-protocol/src/remote-host-uplink.ts` | Current envelopes carry registration, heartbeat, bounded Agent RPC and session streams; this is not a generic HTTP/WS proxy. |
| `packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts` | Reuse authenticated outbound Controller connectivity and recovery concepts; add a dedicated data transport. |
| `packages/agent-remote-hosted/src/gateway.ts` | Reuse authoritative principal/Host/session authorization; explicitly add preview management and data routing. |
| `packages/agent-remote-cloudflare/src/worker.ts` | Add hostname-aware preview dispatch before control-site HTML and static-asset routes. |
| `packages/agent-host/src/` | Local Controller implementation location in this checkout; own registrations and local connections here without interpreting provider transcripts. |

Use bounded local diagnostic records for register, reuse, expire, unregister, target failure, tunnel disconnect, reconnect, and capacity rejection. Record IDs, generation, reason, safe target metadata, and timing; omit payloads, cookies, tokens, and query strings. Browser-visible errors should be actionable without exposing private upstream diagnostics. Idle registrations hold metadata, not permanently open local application sockets; no registrations means no need to retain an otherwise unused data connection.

## Acceptance criteria for implementation

| Area | Required evidence |
| --- | --- |
| On-demand UI | Rendering performs no registration; click transitions through pending to ready; multiple URLs remain distinguishable; ready links open on mobile; original transcript remains unchanged. |
| Mapping identity | Two Hosts using the same port remain distinct; repeat clicks are idempotent; paths, repeated query keys, escaping, and fragments survive link translation. |
| Discoverability | Host list exposes active/inactive registrations and source navigation; unregister updates every referencing block and releases connections. |
| State recovery | Expiry with no browser attached, browser refresh, missed/reordered events, Controller restart, Relay restart, offline unregister, and stale generations converge without resurrecting mappings. |
| HTTP | Real local server round trips cover methods, binary responses, multipart upload, range/conditional requests, cookies, redirects, cancellation, errors, and bounded streaming. |
| SSE | Initial events reach the browser before completion; an active stream survives ordinary response deadlines and stops on revoke/expire. |
| WebSocket | Real local WS server verifies bidirectional text/binary, ordering, subprotocols, rejection, close/error propagation, bounded message sizes, and application reconnect. |
| Hot reload | A real supported dev server loads through the prefixed URL and pushes a file-change update through WSS in a browser. |
| Concurrency | Two simultaneous previews do not cross-route root assets, API requests, cookies, or WS upgrades; slow streams do not starve other streams or Controller heartbeats. |
| Security | Unauthenticated and foreign-principal requests, expired handoffs, revoked shares/sessions, unknown IDs, stale tunnels, non-loopback targets, reserved ports, redirect escapes, and credential leakage are rejected. |
| Runtime parity | The HTTP/WS suite passes against Node/Docker and the Workers adapter; bounded memory and cleanup are measured during disconnect and overload. |

Use dedicated local ports and synthetic fixtures; do not disturb the production Controller, shared provider daemons, or unrelated worktrees. Apply both runner and outer-process timeouts. Implementation changes must update protocol fixtures and compatibility metadata, run `pnpm compatibility:update` and `pnpm compatibility:check`, and sync affected current architecture docs. Those implementation checks are not claimed by this design-only record.

## Decisions still needed before implementation defaults are fixed

- Select the Controller expiry policy and duration, local record/tombstone retention, stream and byte limits, and timeout values. Keep these independent of the frontend clock.
- Define the first supported application/base-path adapters and an actionable unsupported-app experience. General transparent rewriting of arbitrary JavaScript applications is not an agreed capability.
- Verify control/preview host-only cookie behavior and choose the exact one-time handoff transport using the existing identity implementation; reserve authentication routes and cookie names.
- Provision the fixed preview DNS, certificate, and authenticated route in each selected deployment. Neither DNS work nor deployment is performed by recording this design.
