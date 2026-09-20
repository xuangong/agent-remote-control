# Cloudflare Relay runtime

This package runs the authenticated hosted Relay with native Workers HTTP and
WebSocket APIs and a SQLite Durable Object. The public Worker forwards dynamic
requests to the private `RELAY` binding's stable `primary` object. The shared core
owns authentication, tenant isolation, Host sharing, quotas, and protocol rules.

The independent application is `agent-remote-control`, served at
`https://agents.xianliao.de5.net`. Its Gateway issuer is
`https://token.xianliao.de5.net`. Both applications use Custom Domains. Set
`AGENT_REMOTE_SIGNING_SECRET` as a platform secret on both applications; examples
contain placeholders only. Workers development and preview URLs are disabled.

From the repository root:

```sh
pnpm build:relay
pnpm --filter @agent-remote-controller/agent-remote-cloudflare build
pnpm --filter @agent-remote-controller/agent-remote-cloudflare typecheck
pnpm test:cloudflare
pnpm --filter @agent-remote-controller/agent-remote-cloudflare deploy:dry-run
```

The bundle is `dist/cloudflare/worker.js`; Controller assets are `dist/relay/web`.
The Worker adds the hosted authentication marker and CSP to the index and rejects
HTML fallback responses beneath `/assets/`. Local process and Docker entry points
are documented in the repository deployment guide and generate loopback origins
and isolated local persistence configuration.

SQLite stores versioned sessions, tenants, device keys, Hosts, session bindings,
creation identities, sharing grants, quota reservations, browser challenges, and
consumed proofs in separate rows. Each core commit diffs records within one SQL
transaction and awaits durable storage synchronization. Stored metadata binds the
state version, canonical origins, and a secret-derived fingerprint. Changing those
values cannot silently reuse an existing object database. Active connections are
not restored; persisted Hosts start offline and reconnect using their saved device
credentials, while browser sessions must revalidate their authority lease.

The native WebSocket adapter enforces the 16 MiB application frame limit, treats
binary data explicitly, and attaches asynchronous frame processing to `waitUntil`.
Registration, RPC, stream-opening, admission, and buffered-command bounds remain
in the shared core. Workers assembles a frame before dispatching its event. The
standard Workers WebSocket API exposes neither `bufferedAmount` nor a backpressure
signal, so the adapter reports that metric as unavailable; it cannot claim Node's
measured per-socket egress queue cutoff. It does not add an acknowledgement protocol.

A single persisted alarm keeps the earliest deadline, preserves an existing alarm
when the object is constructed, and tolerates duplicate delivery. Failed refreshes and request/frame persistence errors
schedule a new bounded retry instead of relying solely on Cloudflare's finite
automatic retries. Expiry is also checked on requests and frames. After a durable
commit error the current core fails closed; an alarm can recreate it from the last
atomic commit once storage is available again.

Tests execute the production adapter in Miniflare/workerd, using a signed Gateway
authority fixture and synthetic Host messages. A test-only subclass provides
storage fault injection and alarm inspection inside the private binding; these
methods are absent from the production bundle. Tests do not start native provider
CLIs or deploy remotely.

## Local previews

Local previews share `AGENT_REMOTE_RELAY_URL` under `/p/<id>/` by default and use the same Relay Durable Object. No additional Custom Domain is required. Set `AGENT_REMOTE_PREVIEW_URL` only to use a separately configured preview origin. Same-origin previews are trusted applications whose scripts have the same browser privileges as the Controller site. Preview data uses a dedicated binary WebSocket adapter and HTTP streaming. Application-facing preview WebSockets have a 16 MiB lifetime egress budget because Workers has no drain metric; reaching it closes the socket with 1013 so clients can reconnect. See [local previews](../../docs/current/agent-remote/local-previews.md) for authorization, base-path configuration, and Markdown image scope.
