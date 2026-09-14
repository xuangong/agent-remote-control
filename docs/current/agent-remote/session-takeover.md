# Session activity and takeover

## Activity contract

Codex, Claude Code, and Copilot use the same catalog activity labels:

| Wire state | Label | Meaning |
| --- | --- | --- |
| `running` | Working | The observed native runtime reports ongoing work. |
| `waiting` | Waiting | The observed native runtime is waiting for user input or approval. |
| `idle` | Idle | The observed native runtime explicitly reports idle. |
| `unknown` | Unknown | Current activity cannot be established. The session can still be opened. |
| `unavailable` | Unavailable | This catalog entry cannot currently be opened. |

The catalog is a snapshot, not a continuous activity subscription. A catalog's
`updatedAt` describes the persisted session metadata; it is not the timestamp of
a live activity check. Retained pagination views may contain older state. Never
use a catalog snapshot as authorization to interrupt an original client.

Claude SDK `listSessions` and Copilot SDK `listSessions` expose persisted metadata
without live activity. Their discovered sessions therefore use `unknown`.
Codex `notLoaded` means the querying app-server does not own that thread; another
process may still be working on it. Missing or unrecognized native states also
map to `unknown`. Host-owned sessions overlay this metadata with their native
runtime state. Closed or initializing handles do not imply idle.

## Confirmation design

The intended takeover flow is shared across the three providers:

1. Establish an actual ownership conflict. Reuse an existing Host binding when
   one exists; do not mistake an additional browser for another native writer.
2. Obtain a fresh, provider-specific preview of the original owner, activity,
   affected sessions, and available release operation.
3. Show Working, Waiting, Idle, or Unknown for each affected session, together
   with the activity observation time when there is a trustworthy observation.
   Unknown includes an explanation that work may still be running.
4. Ask the user to confirm the exact impact. Working or Waiting changes the
   warning, not the permission to silently interrupt. Idle still requires consent.
5. Revalidate ownership, activity, impact, and authorization before release. A
   changed owner, changed activity, expanded impact, or expired preview requires
   a refreshed preview and confirmation.
6. Release the original owner, verify release, and resume the original native
   session identity. Never delete a live writer lock or silently fork history.

Release must be Host-owner-only and explicitly enabled by local Host policy.
Shared Host access does not grant control over unrelated local clients. Preview
tokens must be short-lived, single-use, scoped to the Host/provider/session and
the inspected owner identity. Browser requests must not supply a PID or path to
terminate. Reconnect invalidates previews. An ambiguous release result must not
automatically repeat termination.

## Verified native boundaries

Inspected installed SDKs: Claude Agent SDK 0.3.247 and Copilot SDK 1.0.11;
Copilot CLI 1.0.83. Codex native writer behavior was checked against 0.153.4 and
the local Codex source.

| Provider | Current activity source for an owned session | Release boundary |
| --- | --- | --- |
| Codex | Native runtime notifications and thread state | `thread/unsubscribe` applies to the calling connection; it is not a verified cross-process takeover operation. An external writer can continue holding its OS lock while idle. |
| Claude Code | Query stream and interaction state | `Query.close()` closes the query owned by that SDK client. No verified operation in the currently integrated client discovers and closes an arbitrary external CLI owner. Persisted catalog metadata does not expose its activity. |
| Copilot CLI | Session stream and `metadata.isProcessing()` for the connected runtime | `CopilotSession.disconnect()` releases the session through the connected server. `sessions.open(kind: attach)` addresses an already-active in-process session. These do not establish control over an arbitrary external CLI server. |

The same UI does not imply identical native ownership semantics. Do not invent
Codex-style writer conflicts for Claude or Copilot without native evidence.
An SDK-owned release method is not evidence of cross-process release support.

Terminating an external owner process would be an OS workaround, not a native
SDK feature. One process may host several sessions. An open file descriptor
alone does not prove lock ownership, and process liveness does not establish
Working or Idle. Process-level takeover requires a separately selected product
policy and a reliable identity/impact implementation before it can be enabled.

## Delivery state

Implemented: accurate catalog activity labels and unknown-state propagation
through providers, Host, Relay, and the session directory UI.

Pending: takeover preview, confirmation tickets, original-owner release, and
fresh activity revalidation at confirmation. No process termination or native
takeover operation is introduced by the catalog activity change.
