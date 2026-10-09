# Session attention on desktop and mobile

Track view is a product-wide panel, independent of each Session View. Touch devices default to showing it; desktop devices default to hiding it. Device detection uses the primary pointer (`pointer: coarse`), not the width of an individual Session View. An explicit browser preference overrides the default.

- `/track` toggles Track view from any product composer, including Side and Ask.
- `/track on` / `/track off` explicitly show or hide it (`enable` / `disable` also work).
- View → Track view provides the same control without a connected composer.
- Hiding the panel preserves tracked sessions, activity subscriptions and retained connections.

Desktop session notifications are enabled by default. When permission is undecided, each desktop visit attempts to request it as soon as workspace access is ready, before a session needs attention. If the browser blocks automatic prompting, the first trusted click or Enter retries once. Concurrent requests and StrictMode effect probes do not create duplicate prompts. View → Session notifications can disable them; Allow browser notifications can also retry a dismissed or blocked request. A denied permission requires changing browser site settings. Mobile continues using Track reminders and does not request notification permission.

## Activity and delivery

Notifications reuse the existing read-only activity subscription for open, auxiliary and tracked sessions. Entering `waiting` produces a pending-input reminder; `running` → `idle` produces a completion reminder. The first observation is a baseline. Repeated states, a new timeline epoch and failed/closed states do not produce completion notifications. Reconnection retains the last observed activity, allowing an actual transition during the interruption to be reported without repeating unchanged pending state.

These rules use provider-normalized activity rather than interpreting text or maintaining another native session status. They do not introduce another network subscription, timeline aggregation or provider operation.

Tabs displaying a session (including its Side/Ask composition) hold a shared Web Lock for notification routing. Background-only trackers yield to those tabs. A separate lock serializes delivery, and a bounded list of opaque hashes of workspace/session/activity/cursor identities deduplicates reminders across tabs. Without Web Locks or storage, notification tags provide a best-effort fallback. Activity without a cursor does not receive persistent deduplication receipts.

Clicking a notification focuses its originating tab and reveals the corresponding session, preserving the existing composition when possible. If no tab displays the session, a tracking tab delivers the notification and opens it on click. No new tab is created. Routing and deduplication apply within one browser origin/profile; different browsers and devices are independent.

This is browser-page notification delivery, not server push. The site must remain open and able to receive activity; a closed or suspended browser cannot guarantee immediate reminders. Notifications include the session title, not conversation contents. Controller updates are not required.
