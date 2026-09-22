# Authorization renewal and session catalog investigation

## Evidence and scope

Read-only observations on September 23, 2026 (Asia/Shanghai). The local Controller's current-process window began at approximately 01:47. A snapshot around 02:40 contained 24 Relay-confirmed `credential_expired` Host disconnections. Normal connection lifetimes were approximately 119.7 seconds. Recovery took a median 7.0 seconds, up to 14.5 seconds; 22 handshake attempts received HTTP 503. These are authorization disconnects, not recorded heartbeat timeouts.

The Controller logs and its separately delivered Relay logs agree on the disconnect pattern. Worker tail captured background alarms lasting approximately 5.07 seconds, matching the authority request deadline. A separate two-minute Gateway tail captured 127 successful browser `renew` requests and two successful `user-status` checks. Gateway response times were 37–351 ms for renewals and 154 ms for owner checks. Tail captures are separate samples, not a shared request trace; they do not prove the exact network queue position of every timed-out request.

`gateway.refresh()` started every saved browser renewal through `sessions.refreshAll()` before initiating owner checks in the same `Promise.all`. Up to 1,024 persisted browser sessions could launch requests together. Request deadlines started when fetch was called, including any transport queue time. A busy browser renewal sweep could therefore starve the Host authorization check. No retry was scheduled inside the still-valid owner lease after a transient failure; the next periodic attempt could coincide with hard expiry. A short valid authority lease also scheduled refresh at expiry rather than before it. The normal 120-second lease renewed successfully in a quiet local Worker probe, whereas the short-lease case reproduced a 1013 close over an actual Worker WebSocket.

## Implemented correction

- Schedule the next owner check halfway through the remaining approved lease, at most 60 seconds away.
- Retry unavailable authority within the existing lease, at most 10 seconds away, with a minimum 250 ms delay to avoid spinning near expiry.
- Check owners before browser renewal batches. Limit each batch to four requests and recheck due owners between browser batches, so a long browser sweep cannot monopolize renewal work.
- Keep hard expiry and immediate denial enforcement. No failed request extends the lease; these changes do not relax revocation or recent-sign-in requirements.
- Cancel unused non-success HTTP bodies and record bounded owner-check metadata: start/completion, elapsed time, HTTP status, safe failure category, remaining lease, and next-check delay.
- Negotiate diagnostic delivery version 2. Version 1 Controllers continue receiving their original events; authority events require an updated Controller and never block legacy log delivery.
- Native Codex request diagnostics include the allowlisted method, numeric RPC code, safe rejection category, cursor presence, and a 16-character SHA-256 session reference. Raw error messages, error data, cursor values, session IDs, and workspace paths remain excluded.

Worker regressions exercise independent scheduled renewal, a transient failed check, persistent outage, revocation, request prioritization, bounded concurrency, long browser batches, and delivery to the owning Controller. Native error coverage includes an actual shared Unix WebSocket. Live stability across multiple renewal cycles still needs verification after authorized deployment.

## Catalog latency

The same Controller snapshot showed approximately 326 completed catalog operations, with a median 7.6 seconds, P95 9.7 seconds, and maximum 11.4 seconds. Native connection initialization was normally 1–2 ms. Session stream opening-to-ready had a median 55 ms. These measure different phases and must not be conflated with end-to-end page interactivity.

A bounded read-only probe against the existing shared daemon measured:

| Read | Duration | Returned summaries |
| --- | ---: | ---: |
| One native page, limit 30 | 1,116 ms | 30, more available |
| Current five-page scan, limit 100 | 7,056 ms | 452 |
| Page 1 / 2 / 3 / 4 / 5 | 2,452 / 2,763 / 1,661 / 134 / 46 ms | 100 / 100 / 100 / 100 / 52 |

These are individual samples under live load, not controlled benchmarks or guaranteed speedups.

The call chain explains the amplification:

1. `SessionDirectory` polls the catalog revision every five seconds whenever the document is visible and the component is mounted. It is not gated on the discovery panel actually being visible.
2. `RemoteHostCatalog.revision()`, `session()`, and every `page()` call await `reconcile()`.
3. `createCodexSessionDirectory.discover()` serially reads up to five native pages of 100 summaries. Its in-flight promise coalesces overlapping work, but no result cache survives completion.
4. `CodexAppServerProvider.listSessions()` opens, initializes, reads, and closes a native connection for each page.

Consequently a nominally cheap revision poll scans up to 500 sessions. Even continuing an existing catalog snapshot triggers another scan before reading that snapshot. The native page reads dominate; connection reuse by itself is a secondary improvement.

## Recommended catalog work, not implemented in this change

1. **Reduce unnecessary refreshes first.** Poll only while discovery is visible; suspend when its drawer/tab is hidden or the document is backgrounded. Share a short-lived Controller catalog cache across devices. Keep explicit Refresh as a fresh scan, coalesce simultaneous requests, and invalidate after create, fork, rename, and other locally known mutations. External CLI changes still require periodic reconciliation; define a visible freshness bound (for example 15–30 seconds).
2. **Serve the first native page before scanning the rest.** Extend the directory boundary to expose native pagination and request the first 30 summaries. Fetch older pages on demand. Keep provider interpretation in the adapter and preserve workspace checks, source filtering, direct-by-ID lookup, and opened-session overlays. Do not treat an incomplete first page as proof that an older session does not exist.
3. **Separate snapshot pagination from discovery refresh.** Continuing an established view should not require an unrelated whole-catalog scan. Preserve the existing cursor lifetime, stable ordering, and unavailable/deleted-entry semantics explicitly; simply removing `reconcile()` would change those guarantees.
4. **Consider one read-only native catalog connection after these changes.** It reduces socket/initialize churn, especially for private runtimes. On this shared daemon, initialization is too small a fraction of latency to make it the first optimization. Keep it separate from session ownership and subscription reclamation.

Acceptance should compare cold first-page latency, warm revision latency, native `thread/list` calls per minute with discovery hidden/visible, multiple devices, explicit refresh, external CLI-created sessions, and stable continuation pages. Use real native/Relay transports; do not benchmark by assuming a cache hit or equating stream readiness with full history catch-up.
