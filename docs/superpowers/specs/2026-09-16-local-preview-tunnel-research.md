# Local preview tunnel research

Research date: 2026-09-16. Repository baseline: `20acc14`. Related requirements: [local preview tunnel design](2026-09-16-local-preview-tunnel-design.md). This report combines current source inspection, primary documentation, and bounded local experiments. It does not represent an implemented tunnel, production acceptance, or authorization to deploy. Scratch probes used synthetic services on ephemeral loopback ports and were shut down.

## Recommendation

Implement an application-level HTTP/WS reverse tunnel over a dedicated authenticated outbound WSS connection from each Controller. Keep registration and lifecycle notifications on the existing control path; put body bytes and WS messages on the new data connection. Reuse Node's HTTP/HTTPS and `ws` implementations locally, standard Web Streams in the shared Relay core, and native Workers WebSocket/DO adapters. Do not implement HTTP parsing, TLS, or RFC 6455 framing ourselves. Self-implementation concerns the reverse transport, multiplexing, routing, authorization, and lifecycle.

HTTP and SSE share one streaming request/response implementation. WS requires a distinct logical stream with handshake negotiation and message boundaries, carried by the same data tunnel. Neither the existing Agent session stream nor `readResource` is a general web proxy.

Two issues govern scope more than basic byte forwarding: the fixed `/p/<id>/` prefix requires application-aware URL handling, and Workers lacks the public WS send-backpressure controls available in Node. Both must be addressed explicitly rather than hidden by a successful GET or WS handshake.

## Current stack and concrete gaps

| Boundary | Verified current implementation | Consequence |
| --- | --- | --- |
| Controller | Node >=22; probe runtime 22.23.2; `packages/agent-host`; existing outbound `ws` client. Lockfile resolves app `ws` to 8.21.1. | Use native HTTP/HTTPS clients and the installed WS library; no additional tunnel daemon is required. |
| Browser | React 18, TypeScript, Vite 6.4.3; Markdown plus structured timeline renderers. | Registration is a UI control operation; rendering must not trigger background port registration. |
| Hosted Relay | `agent-remote-hosted` provides portable Request/Response handling, credential/session validation, Host ACLs and broker state. | Put preview authorization and routing alongside hosted functionality, not inside provider adapters. |
| Cloudflare | Wrangler 4.97.0; Miniflare 4.20260601.0; compatibility date 2026-06-01; `nodejs_compat`; SQLite DO. Worker forwards to `RELAY.getByName('primary')`. | A DO can rendezvous the Controller socket with browser requests. This is currently one shared coordination and resource boundary. |
| Node HTTP adapter | `remote-host-broker.ts:96` awaits `result.text()` before writing status/headers and ending the response. | Buffers until EOF, loses binary fidelity, and cannot deliver live SSE. |
| Node incoming adapter | `webRequest()` converts a request body with `Readable.toWeb()` and `duplex: 'half'`. | Streaming ingress exists, but disconnect-to-AbortSignal propagation needs explicit wiring. |
| Existing socket ports | `RelaySocket.send(string)`; Workers delivers binary frames to listeners as an empty string plus a binary flag; Node converts frame data to text. | Add a binary-capable tunnel port; widening types alone does not preserve bytes. |
| Existing uplink schema | Version 2, JSON envelopes, string request/response bodies, GET/POST and restricted Agent routes, session-scoped streams. | Add a preview contract and data codec; do not relax the existing RPC into an arbitrary URL proxy. |
| Browser WS upgrade | Adapters immediately accept a prepared socket and do not carry a locally selected upstream subprotocol through the preparation result. | Preview upgrade must wait for local handshake success and return selected protocol metadata. |
| Origin and cookies | Hosted Relay validates the configured control origin and uses host-only `__Host-arc_session` cookies under HTTPS. | The sibling preview origin needs an explicit authentication handoff and its own constrained session; it cannot automatically use the control cookie. |

Source anchors: [Node adapters](../../../packages/agent-remote-lab/src/server/remote-host-broker.ts), [Node hosted server](../../../packages/agent-remote-lab/src/server/gateway-relay.ts), [socket interface](../../../packages/agent-remote-hosted/src/transport.ts), [Workers socket](../../../packages/agent-remote-cloudflare/src/socket.ts), [DO](../../../packages/agent-remote-cloudflare/src/relay-object.ts), [uplink schema](../../../packages/agent-remote-protocol/src/remote-host-uplink.ts), [uplink client](../../../packages/agent-remote-relay/src/transport/remote-host-uplink-client.ts), and [gateway](../../../packages/agent-remote-hosted/src/gateway.ts).

The Node hosted server currently constructs Request URLs using the configured control origin. Preview dispatch therefore needs an explicit validated hostname/origin selection before this conversion; simply adding a hostname route in a reverse proxy is insufficient. On Workers, add hostname dispatch before the current control-site HTML and asset fallbacks. Unknown preview paths must not accidentally return control-site assets or bypass authorization.

## Local experiment results

| Probe | Observed result | What it establishes |
| --- | --- | --- |
| Existing Node response writer | Input bytes `00 80 ff 41 0d 0a` became `00 ef bf bd ef bf bd 41 0d 0a`. | Current text conversion corrupts non-UTF-8 content. |
| Existing Node response writer with SSE | First event was available at source immediately, second at 650 ms; browser-side fetch received both together at 656 ms. | The current writer waits for response completion. |
| Node Web Stream-to-HTTP pipeline | Same binary payload was exact; first SSE event arrived in 3 ms, before stream completion. | Node streaming primitives are suitable; timing is illustrative, not a performance benchmark. |
| Controller HTTP client choice | Source gzip was 41 bytes; built-in fetch produced 21 decoded bytes while retaining `Content-Encoding: gzip` and `Content-Length: 41`. `node:http` returned the original 41 bytes. | Naively relaying fetch headers and body is unsafe; prefer native HTTP clients for byte-transparent forwarding. |
| Workers/DO streaming bridge | A real Node WS client sent headers, binary chunks, and end to a Miniflare DO; its HTTP response delivered the first SSE event in 11 ms. | WS-originated data can feed a streaming HTTP response through the project's current runtime. |
| Workers WS primitives | Delayed upgrade selected `probe-v2`; text and binary echoed correctly; close code 1000 propagated. | The required local runtime primitives exist. This is not a complete application proxy. |
| Workers WS capabilities | `bufferedAmount` and `pause` were undefined; default `binaryType` was `blob`. | Do not port Node send-buffer assumptions into Workers; explicitly use `arraybuffer`. |
| Vite 6.4.3 default base | HTML at `/p/7f3a/` still referenced `/@vite/client` and `/main.js`. | An apparently successful HTML request does not prove prefix compatibility. |
| Vite 6.4.3 configured base | With base `/p/7f3a/`, `/` redirected to that prefix; `/@vite/client` returned 404; `/p/7f3a/@vite/client` returned 200. HMR connected at the prefixed path. | Always stripping the prefix breaks a base-aware app. |

Scratch artifacts are under `.tmp/tunnel-research/` in this worktree: `node-response-probe.mjs`, `node-response-result.txt`, `http-encoding-probe.mjs`, `http-encoding-result.txt`, `workers-primitives-probe.mjs`, `workers-primitives-result.txt`, `vite-prefix-probe.mjs`, and `vite-prefix-result.txt`. These are ignored research evidence, not shipped code or committed regression tests. The Node source probe was bundled with workspace aliases after the primary checkout's installed package links did not resolve the renamed workspace scope; no dependency install or primary-tree repair was performed.

The Vite WS probe was a Node client without a browser Origin header, so it does not establish browser token/Origin acceptance or actual hot reload. No mobile browser, full tunnel, authentication integration, production Worker, slow-client stress test, or deployment was exercised.

## Transport alternatives

| Approach | Fit | Decision |
| --- | --- | --- |
| One dedicated multiplexed WSS data connection per Host | Reuses outbound reachability, portable to Workers and Node, amortizes handshakes and supports simultaneous requests. Needs explicit framing, credit, and fair scheduling. | Recommended. |
| One reverse WS connection per HTTP request or application socket | Easier stream isolation, but each asset needs dispatch and connection setup unless a pool is built; adds pending sockets, authorization handshakes, and reconnect races. | Useful comparison prototype, not the default. |
| General TCP tunnel or existing Node HTTP proxy package | Native HTTP proxies help when the upstream is directly reachable; they do not supply the authenticated reverse path to a NATed Controller. A generic byte tunnel also needs protocol adaptation at Workers. | Reuse protocol libraries, not a second independent forwarding service. |

Multiplexing over WSS retains TCP head-of-line behavior. Chunking and fair scheduling prevent application-level starvation but do not create QUIC-style independent transport streams. Avoid putting preview traffic on the existing chat/control socket. A small data-connection pool can be evaluated later if measured contention justifies it.

## Proposed contract and module placement

Use a small portable state machine with injected transport and clocks. Keep Node socket types out of the wire model. Suggested files are implementation recommendations, not existing modules:

| Package | Proposed responsibility |
| --- | --- |
| `agent-remote-protocol` | Preview registration descriptors, lifecycle snapshots/events, tunnel metadata schema and binary codec. |
| `agent-remote-hosted` | `preview-registry`, preview access sessions, `preview-router`, stream admission/cancellation and transport-neutral broker. |
| `agent-remote-relay` | Controller-side `preview-tunnel-client`, logical stream bookkeeping and outbound connection recovery. |
| `agent-host` | Local `preview-registrations` persistence/policy and native `preview-http`/`preview-websocket` target adapters. |
| `agent-remote-cloudflare` | Binary tunnel socket adapter, streaming Response and asynchronous WS upgrade, hostname routing. |
| `agent-remote-lab` Node server | Streaming response writer, cancellation bridge, selected-protocol WS upgrade and validated hostname dispatch. |
| `agent-remote-web` | URL discovery, on-demand controls, status projection and Host preview list. |

Suggested control operations are `preview.register`, `preview.unregister`, `preview.snapshot`, and revisioned `preview.changed`. Route them through authenticated Host control semantics; do not send prompts or overload Provider `readResource`. Bind registration requests to session-to-Host resolution and explicit Host preview permissions. Controller owns expiry and local records; Relay owns access and the usable routing projection.

Suggested data messages are `http.open`, `http.headers`, body data/end, `ws.open`, `ws.accept`/`ws.reject`, WS data/close, `stream.cancel`, `stream.error`, and `window.update`. The initial data handshake binds protocol version, Host identity, credential generation, and tunnel generation. Use a device-authenticated attach or a short-lived attach ticket minted by the existing control authority; never accept a browser-chosen Host ID as authentication.

A candidate binary header is 16 bytes: version u8, kind u8, flags u16, stream ID u32, sequence u32, payload length u32, followed by payload bytes. Metadata may use bounded JSON text envelopes. WS message IDs/types/end flags must preserve application message boundaries when a message spans several chunks. This layout is a proposal to validate with fixtures, not a finalized protocol. Keep preview IDs separate from compact per-connection stream IDs, and never reuse a stream ID within a generation.

## HTTP and SSE implementation

For each authorized HTTP request, create a logical stream and send method, structured upstream path/query and validated headers. Pump request-body bytes only while the Controller grants credit. The Controller uses `node:http.request` or `node:https.request`, with a pinned loopback target, connection deadline, bounded header size, and explicit abort behavior. Return response metadata as soon as local headers arrive, followed by bounded byte chunks. Construct a Relay Response with a `ReadableStream<Uint8Array>` immediately after headers; do not await EOF.

On Node, bridge that response using `Readable.fromWeb` and `pipeline`, or explicit `response.write()`/`drain` handling. Preserve multiple Set-Cookie headers with `getSetCookie()`, handle HEAD/204/304 correctly, and flush headers promptly where needed. On Workers, return the native streaming Response through the DO and outer Worker without calling `.text()`, `.json()`, `.arrayBuffer()`, `clone()`, or `tee()` on arbitrary preview bodies. [Node 22 HTTP documentation](https://github.com/nodejs/node/blob/v22.23.0/doc/api/http.md) and [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) describe the underlying primitives.

Relay header rules must strip hop-by-hop headers, including names listed by Connection, reconstruct upstream Host, reserve internal/authentication names, and preserve representation headers only if the bytes still match. Do not conflate local app Authorization/Cookie values with Relay credentials. Proxy-level transfer framing is not forwarded as application content. Compressed bodies can remain opaque byte streams; if URL adaptation modifies them, decode/transform/re-encode explicitly and repair length and validators. Trailers, interim informational responses and specialized upgrade protocols need explicit capability decisions; a Fetch Response abstraction does not imply wire-perfect HTTP proxying.

SSE needs no event parser or separate tunnel type: preserve `text/event-stream`, event bytes, comment heartbeats, and `Last-Event-ID` on reconnect. Do not buffer/compress small events into long delays or cache event streams. Use connect/header/inactivity deadlines rather than a blanket short total-response deadline. Browser EventSource decides to reconnect; the local application decides replay semantics. A tunnel reconnect must never replay an unconfirmed POST or buffered SSE events on its own.

The current Node `server.requestTimeout = 15000` concerns receiving the incoming request, not the duration of an outgoing SSE response. Adjusting it matters for slow uploads, but it does not fix current SSE buffering. Preserve a finite anti-stall policy while adding streaming-friendly upload limits. Node Request construction currently has no explicit abort controller tied to response disconnects: bridge premature request abort and response close into stream cancellation, distinguishing normal request-body completion from a disconnected browser.

Reject unauthenticated traffic before reading the body. Map target connection errors and pre-header deadlines to controlled gateway responses; after headers, fail the stream rather than emitting a second status. A registration expiry, authorization revoke, or cancel must destroy the corresponding local request and release all pending readers/writers, even during upload or SSE idle periods.

## WebSocket implementation

The browser opens `wss://preview.xianliao.de5.net/p/<id>/<socket-path>`. Relay authenticates it, validates Origin and the active registration, and sends `ws.open` with offered subprotocols and allowed handshake headers. Controller constructs the local WS/WSS URL from the registered service and opens it using `ws` with bounded `maxPayload`, handshake timeout, disabled redirects, and compression initially disabled. Preserve browser Origin and app handshake tokens according to the explicit application policy; do not remove them merely to bypass a development server's checks.

Wait for the local socket to open, then return its selected subprotocol before completing the browser handshake. Extend the preparation result to carry response headers/protocol and pending cleanup. Node `handleProtocols` must use that selected protocol rather than selecting independently. Workers can put `Sec-WebSocket-Protocol` on the 101 Response. Revalidate authorization/generation when the local handshake completes, since unregistration can race with it.

For data, forward `string` and binary messages without losing the `isBinary` distinction. Preserve per-stream order and whole-message boundaries; do not expose internal tunnel chunks as separate browser messages. Honor library/runtime message limits before unbounded accumulation. The native [ws API](https://github.com/websockets/ws/blob/8.21.1/doc/ws.md) supplies send callbacks, `bufferedAmount`, pause/resume, close, and termination on Node. Its `createWebSocketStream()` is useful for byte-stream cases but is not a complete drop-in solution for preserving text/binary message semantics in this proxy.

WS ping/pong, compression and fragmentation are hop-local protocol behavior. Application heartbeat messages must pass unchanged; tunnel heartbeat independently detects an unusable Controller connection. On tunnel loss, close browser and local application sockets. On reconnect, create fresh logical streams only when the application reconnects. Do not replay WS messages into a different socket.

Workers compatibility date 2026-06-01 includes the documented binary default and automatic close-reply behavior: set `binaryType = 'arraybuffer'`, normalize allowable close codes, and explicitly test both peers closing concurrently. Abnormal status 1006 cannot be sent as an ordinary close frame. The [Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/) documents these runtime semantics; do not assume a Node close handler maps unchanged.

## Backpressure and resource containment

Use explicit per-stream and per-tunnel byte windows. Initial candidate values for load experiments are 64 KiB body chunks, 256 KiB per HTTP direction, and a 4 MiB aggregate tunnel window. These are research starting points, not approved shipping defaults. Only grant additional credit when bytes have left the bounded receiving queue for the next consumer. Enqueuing data into another unbounded queue is not consumption.

For HTTP response flow, browser demand drives ReadableStream pulls and therefore response credit. For uploads, Controller HTTP write completion/drain releases credit. Interleave streams fairly, cap metadata and message reassembly, and reserve capacity for cancellation and window updates so data congestion cannot deadlock control. Abort on over-credit sends or malformed stream transitions. Node local WS reads can pause when a tunnel window is exhausted.

There is an important asymmetry: both ends of our internal tunnel speak our credit protocol, but an arbitrary browser application's WS does not. Workers' public WS API in the tested runtime has no pause, send-completion callback or bufferedAmount. Calling `send()` does not prove the browser has consumed anything. Internal credit therefore bounds our own queues, but cannot by itself prove bounded native egress buffering to a stalled arbitrary browser. The [upstream workerd backpressure issue](https://github.com/cloudflare/workerd/issues/988) is relevant context; the local capability probe establishes this checkout's behavior independently of the issue's status.

For initial Workers deployment, require conservative message/concurrency limits and slow-client stress validation. A finite cumulative byte budget per application WS can cap accepted traffic, at the cost of forcing reconnect after that budget; a rate limit alone is not a bound on accumulated unsent bytes over an unlimited connection. Do not claim unlimited high-throughput, lossless WS proxying with strict end-to-end backpressure. If that guarantee is required, use a runtime with observable send drainage or an application-aware acknowledgement protocol, which changes compatibility. This limitation does not prevent ordinary low-volume HMR/event sockets, but their actual load still needs verification.

Separate data and control sockets do not isolate CPU or heap when both terminate in the same `primary` DO. Start functional validation in that topology to minimize authorization changes, but measure whether bulk traffic harms chat. A separate preview DO keyed by authenticated Host is the scaling option: the primary remains the authorization authority, while preview objects own data streams. That split needs authenticated internal admission, generation fencing, revoke propagation, and bounded authorization leases; it is an architectural recommendation to evaluate, not a silent change to the agreed design.

Workers has a shared per-isolate memory limit and deployment/runtime interruptions can end active streams. Active ordinary WebSockets and HTTP streams should not be represented as hibernatable state. Hibernation would require a separate recovery design, and it does not preserve in-memory HTTP response controllers. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). Do not claim a global six-stream tunnel limit from Workers' per-invocation outgoing-connection limit; incoming sockets and multiplexed logical streams are different quantities.

## Fixed-prefix compatibility changes the upstream mapping

The earlier design's unconditional prefix stripping needs refinement. The observed Vite behavior requires explicit upstream path modes:

| Application mode | Public request | Local request | Additional work |
| --- | --- | --- | --- |
| Root-mounted application | `/p/7f3a/me` | `/me` | Adapt supported generated root URLs, redirects, cookies, APIs and WS addresses. |
| Application already mounted under the preview base | `/p/7f3a/me` | `/p/7f3a/me` | Preserve prefix and avoid double rewriting. |
| Application mounted under another known base | `/p/7f3a/me` | `<upstreamBase>/me` | Map between explicit bases and apply matching response rules. |

This must be a registration/adapter property, not a heuristic based on Referer or the most recently opened tab. Prefix parsing determines registration identity once; encoded separators and dot normalization must not switch that identity. Path adaptation does not modify query values. WS uses the same mapping mode as the matching app endpoint.

For the repository's Vite 6.4.3, a cooperative app can use `base: '/p/7f3a/'` and configure `server.hmr` for the public WSS host/port as needed. The current Vite documentation has evolved to `server.ws`; use the [version-pinned Vite configuration](https://github.com/vitejs/vite/blob/v6.4.3/docs/config/server-options.md) for this project. The [Vite client](https://github.com/vitejs/vite/blob/v6.4.3/packages/vite/src/client/client.ts) derives its socket address partly from the delivered client module, but injects an HMR base and a token. Its [WS server](https://github.com/vitejs/vite/blob/v6.4.3/packages/vite/src/node/server/ws.ts) checks the path, Host and browser token. Preserve `vite-hmr`, the token query, and the matching local endpoint.

The user wants to click a link to an already-running app. Setting a new Vite base after registration may require app reconfiguration/restart and cannot be silently done by the tunnel. Even a configured Vite base does not rewrite arbitrary application code such as `fetch('/api/status')`. For an unconfigured running app, a Vite-specific adaptation path would need to cover module imports, HTML URLs, CSS assets, HMR base and application request URLs. Returning the wrong MIME type with status 200 is still a failure; the default-base probe returned HTML for a prefixed client-module path.

The recommended compatibility order is byte-transparent transport plus explicit base-aware applications, followed by narrowly tested adapters for unconfigured apps. Generic HTML regex replacement, injecting only a base tag, or patching only `window.fetch` is incomplete: modules, CSS, workers, EventSource, WS, navigation and computed URLs have separate behavior. A Service Worker is not a universal fix and introduces shared-origin persistence and interception risks. Do not promise arbitrary already-running websites work without configuration under the fixed prefix.

Location and cookie rewriting also need explicit rules. Reserve preview-auth cookie names and filter local Set-Cookie attempts to overwrite them; scope app cookies to the registration path where possible and strip Domain. Path rewriting cannot preserve every `__Host-` application-cookie constraint, which requires Path=/, so such application auth is a known compatibility case. Different previews still share an origin and are not isolated from hostile scripts; keep the trusted-project scope recorded in the design.

## Authentication and lifecycle integration

Retain the agreed Controller authority over active/expired/unregistered records and revisioned snapshot/event synchronization. Add `pending_unregister` to frontend operation state while Relay blocks a removed mapping and waits for offline Controller confirmation. A reconnect snapshot cannot restore a mapping covered by a pending removal. Bind tunnel attach and individual stream opens to the currently accepted Controller generation.

A concrete browser handoff can use a control-site POST to mint a short-lived, one-use opaque code bound to the principal, source session and preview ID, then redeem it through a top-level form POST at a reserved preview authentication route. Establish a preview host-only HttpOnly session, redirect to the mapped URL, and keep all reusable credentials out of the local application request. Origin checks, single-use redemption and the existing session's current validity must be enforced server-side. This is a recommendation requiring auth-focused tests, not implemented behavior.

Maintain one preview browser session with an explicit set of authorized preview IDs rather than an unbounded cookie per preview. Each request rechecks the requested ID and current Host permission. Avoid cross-tenant existence leaks; distinguish 'expired' for an authorized owner from an unknown ID for an unauthorized requester. Mutations remain on the control origin and require CSRF checks; the preview origin is only permitted to redeem scoped handoffs and access granted data.

Do not send app payloads or secret-bearing URLs through lifecycle broadcasts or audit logs. Expiry and access revoke cancel both live HTTP and WS streams. UI state is a projection: a client clock or stale Relay cache cannot establish Controller validity. The renewal/retention policy still needs a concrete product default; this research does not silently pick a TTL.

For Cloudflare, the existing deployment already uses a Worker Custom Domain for the control hostname. Under an owned active zone, adding an exact preview Custom Domain can provision its DNS and certificate through Cloudflare; manual wildcard issuance is unnecessary. The account's zone ownership, hostname conflicts and actual certificate activation were not inspected. See [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Node/Docker needs its own HTTPS ingress for the same chosen public URL shape. Neither option depends on Cloudflare Tunnel.

## Implementation and validation order

1. Define registration authority, path mode, Host permission, binary codec and stream states. Pin fixtures and error semantics. Keep the public Agent protocol and preview transport separate.
2. Implement the native local HTTP/WS adapters and shared streaming core with real loopback targets. Verify binary payloads, streaming uploads, SSE, cancellation, subprotocols and close propagation before UI work.
3. Integrate both Node and Workers adapters. Verify hostname dispatch, no asset fallback on preview requests, request aborts, protocol selection, bounded queues and generation changes.
4. Integrate authenticated registration, handoff, revoke, expiry, snapshots and missed-event recovery. Exercise foreign users, offline unregister, credential rotation and Relay/Controller restarts.
5. Add on-demand block controls and Host preview management. Implement explicit path modes and the agreed first app adapters; preserve per-link query and fragment values.
6. Run real browser flows on desktop/mobile-sized viewports, including a supported Vite app's actual HMR, two concurrent previews, SSE reconnect, expiring access and stalled consumers. Run the same transport contract against Docker and Workers, then separately validate hosted behavior before deployment claims.

Shipping gates include byte-exact compressed and binary bodies, first-event-before-EOF SSE, upload abort cleanup, WS message-boundary preservation, no request/message replay, revoked access closing existing connections, bounded internal queues, documented Workers WS buffering limits, and a supported-application matrix. Full project checks must use existing timeouts and update protocol fixtures/compatibility metadata when implementation changes land.

The experiments show that the present stack can supply the necessary primitives. They do not yet prove the full tunnel, seamless compatibility for arbitrary localhost pages, or production capacity. The next engineering work should focus on the reverse transport and its flow-control contract, with fixed-prefix adaptation treated as a separate, equally explicit compatibility layer.
