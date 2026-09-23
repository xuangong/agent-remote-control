# Seamless workspace access

Hosted browsers separate local presentation from server authorization. The standalone workbench continues to use its existing transport directly and has no account dependency.

## Startup and foreground recovery

A browser with confirmed access in the last 24 hours loads the application bundle and checks access concurrently. It immediately renders its last saved conversation, restores the draft and reading position, and keeps the same editor mounted while the authoritative session reconnects. Every successful access check or renewal starts a new 24-hour display window. Reading cached data does not extend it.

After the display window expires, a returning browser shows the workspace shell until authorization succeeds. First-time visitors retain the sign-in entry. Storage failures disable local recovery without preventing online use.

On foreground recovery, the workspace pauses its business transport before session and directory resume listeners run. Access renewal has a 12-second request deadline, ignores late responses, and retries temporary failures with backoff. Cached content stays visible during temporary failures; the small recovery notice uses the existing five-second foreground grace period. Message sending still requires both access and live session readiness, using the existing composer pending behavior.

A missing Agents session can automatically follow the existing Gateway authorization flow for a previously signed-in browser. Canonical session targets and drafts are preserved before navigation. A tab-local ten-minute retry guard prevents authorization loops; no Google authentication is simulated or bypassed in production. Explicit sign-out disables automatic restoration, including when the logout request fails.

## Local storage and authority

- Access metadata contains only the account display identity, workspace namespace, and last confirmation time. It contains no credential and grants no API permission.
- The last conversation snapshot is isolated by account, Host, provider, and native session ID. It is bounded to 150 recent entries and 750,000 serialized characters; oversized history is reduced.
- A saved snapshot is presentation data only. It is never inserted into the live replica or used as a transport subscription cursor. Pending approvals, resources, diagnostics, and outgoing messages are not restored from it.
- Draft/outbox recovery remains independent. Unconfirmed messages are not automatically replayed by access recovery.
- Reading positions prefer tab storage, with a durable local fallback for fresh home-screen launches.
- Sign-out, confirmed access denial, or a confirmed account change clears the relevant conversation recovery data and retires waiting business requests. Other tabs observe sign-out and account changes.

The server continues to authorize every API and WebSocket request. A local display window does not change server sessions, permission confirmation, or Controller behavior. The feature does not add a service worker or promise a fully offline cold launch when the application document is unavailable.

## Validation

`e2e/seamless.playwright.config.ts` runs real local Gateway, Relay, Host-uplink and session-channel transports with a fixture authority. It covers desktop Chromium and iPhone WebKit, cached startup with a delayed access check, editor identity and draft preservation, foreground suspension, business request ordering, and automatic Gateway return. It does not use a real Google account or restart a native daemon.

## Optional device cache protection

Settings includes **Clear chat cache on close**, off by default. Turning it on requires confirmation of both the benefit and the recovery cost. Cancellation leaves the existing preference and data untouched; turning it off does not need confirmation.

When enabled, the application immediately removes its persisted conversation data and uses page-local memory for subsequent reads and writes. This avoids relying on unload callbacks, which mobile browsers may omit when terminating a background page. Backgrounding alone does not discard the live page; refresh, navigation to a new document (including an authorization redirect), closing, or OS termination loses local drafts and recovery records. Remote conversations remain available after access and session recovery, but reopening cannot show their local snapshot first.

The protected data includes workspace snapshots, reading positions, draft text and image bytes in IndexedDB, outgoing-message feedback, Ask input queues, fork context, prompt-edit reservations, recent-session metadata, and tracking lists. No pending message is replayed by changing the preference. Clearing stored copies preserves the active page's in-memory draft and delivery state. Delayed recovery writes and image writes already in flight are fenced against recreating disk copies. Other tabs observe the device preference, and storage boundaries recheck it before writing, even if a tab has not yet received its storage event. Suspended tabs apply cleanup when they resume; they cannot be forcibly executed by another tab.

A cleanup failure remains visible in Settings with a retry action. Login credentials, account access metadata, display preferences, remote history, and account-level Favorites are preserved. This is protection against local chat-data residue, not a device lock or sign-out. A signed-in browser can still retrieve remote conversations; sign out before handing the device to another person. It cannot erase browser history, downloaded files, OS app-switcher screenshots, or copies outside the application's stores. No service worker or application Cache Storage is used for conversation recovery.
