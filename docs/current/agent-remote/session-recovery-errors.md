# Session connection diagnostics

A registered Controller uplink confirms transport availability, not that a native session is ready. Opening a session can include native runtime initialization, resume, and history loading. The session catalog can be available while an open request is still pending.

## Error boundaries

HTTP failures retain `code`, `error`, and an optional `requestId`. The Relay assigns an uplink request ID, the Controller records it locally, and timeout or attach failure responses return it to the browser. This is additive HTTP metadata; Remote wire versions, replay rules, and session identities are unchanged.

| Code | What is known | Next step |
| --- | --- | --- |
| `host_offline` | The Relay cannot use the Controller uplink, or it disconnected during the request. | Wait for reconnection, then reopen the existing session. |
| `session_attach_wait_timeout` | The browser's 15-second restoration wait expired. | Automatic restoration retries the same native identity. |
| `session_attach_timeout` | The Relay's Host RPC deadline expired while attaching. Native work may still be running. | Wait briefly and reopen the same session. |
| `host_read_timeout` | A read request did not return before the Relay deadline. | Retry the read. |
| `host_timeout` | Another operation did not return before the Relay deadline; its outcome is uncertain. | Check the session before retrying. Preserve the operation identity. |
| `native_runtime_unavailable` | The adapter could not establish or retain its native connection. | Check the daemon and the Controller's configured local socket. |
| `native_resume_timeout` | The native resume request reached its own deadline. | Inspect Controller diagnostics and reopen the session. |
| `native_history_timeout` | The native history request reached its own deadline. | Inspect Controller diagnostics and reopen the session. |
| `native_request_timeout` | Another native initialization or catalog request reached its deadline. | Inspect Controller diagnostics. |
| `session_in_use` | The adapter confirmed a native ownership conflict. | Close the other native client before reopening. |
| `local_execution_policy` | Local workspace policy rejected access. | Check local Controller workspace settings. |
| `session_attach_failed` | The Host returned an unclassified failure while opening. | Inspect Controller diagnostics; refresh and reopen the session. |
| `session_binding_unavailable` | The URL has no accessible Relay binding. This does not establish that the native session was deleted. | Reopen from the Host session list; check Host access if it is missing. |
| `route_not_found` | No matching HTTP route exists. | Check the URL and client/Relay compatibility. |

Missing and inaccessible session bindings have identical responses. Unknown native error messages are not forwarded during attach or recovery; recognized adapter errors use fixed public descriptions. Older Hosts with unclassified failures fall back to `session_attach_failed`. The workbench interprets legacy `host_timeout` in the context of an existing-session open only; mutation uncertainty remains unchanged.

## Workbench behavior

Opening and unconfirmed wait deadlines appear as status messages. Confirmed native failures appear as alerts, even when automatic restoration will retry. Connection details disclose the code, HTTP status, and request ID when available. Browser wait deadlines cannot include an ID that the browser never received. Successful restoration clears the notice; changing selection prevents an obsolete response from attaching the previous session.

A wait deadline does not prove the native session failed, and never proves that native work is still running. `rpc_cancel` suppresses a late RPC response; it does not abort the Controller's native opening. The Controller reuses an in-flight opening or an existing native binding. Retrying attachment does not recreate a session or replay user messages.

## Notification presentation

Global notifications supplement feedback at the action's source. Desktop notifications appear at the bottom right; compact layouts use the bottom of the visible viewport, above the on-screen keyboard. Up to three recent notices are shown. The toast has an explicit close control, supports Escape while focused, and shows a countdown: 6 seconds for status, 10 seconds for errors. Hover, keyboard focus, or a hidden document pause auto-dismissal. The countdown is hidden from assistive technology so it does not repeatedly interrupt announcements; notifications use a polite live region and never take focus when appearing. Reduced-motion preferences disable the entrance animation.

A repeated failure from the same source updates one notification. An unchanged polling error does not restart the countdown or reappear after dismissal. Resolving the underlying failure removes its toast. Dismissing a notification never clears the error at its source, pending messages, drafts, operation identity, or uncertain-outcome warning. Field-level validation and retry controls stay beside their fields or actions.

The App routes session open/recovery, Host management, provider/session/workspace catalogs, preview and VS Code connection errors, runtime reconnection, and conversation action failures through the same notification layer. Embedded controls retain their local inline feedback when used outside this App.

## Controller logs

The Controller state directory's `agent-host.log` includes:

- `host_request_started` and `host_request_completed`: request ID, operation category, elapsed milliseconds, final HTTP status and error code, timestamp, and PID.
- `codex_request`: native connection ID, native request ID, phase (`initialize`, `catalog`, `resume`, or `history`), outcome, and elapsed milliseconds. Native IDs are distinct from Relay request IDs; use the Host request interval to inspect native phases.

These new records exclude pairing keys, request bodies, conversation content, socket paths, native session IDs, and arbitrary native error text. Log callbacks cannot change request outcomes. A start record without a matching completion means completion has not been recorded; it is not proof of a live process or an ongoing native operation.
