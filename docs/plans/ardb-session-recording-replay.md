# ARDB Session View recording replay

## Scope

Keep independent CLI operations; do not add a REPL. Record authoritative observer state from `ardb server --jsonl`, then render it through the product Session View using `ardb replay FILE --open`. Supply a repository script that produces a shareable demonstration recording through real stdio and public Relay transports.

## Implementation

1. Parse schema 1.1.0 observer records, validate public payloads with the protocol codec, require a baseline and one Agent identity, preserve order and monotonic playback time. Distinguish truncated/legacy files from completed recordings.
2. Use public Replica reducers for snapshots, Timeline pages/replacement, interactions and resource metadata. Advance incrementally; rebuild from the baseline on backwards seeks. Never execute recorded controls or fetch original resources.
3. Serve packaged assets and recording data on a read-only loopback HTTP server, sharing Host/Origin and asset handling with the live debugger. No Adapter, Relay or account dependencies.
4. Reuse LabWorkbench with explicitly read-only input and no operation callbacks. Add a compact playback toolbar with play/pause, speed, seek, step, restart and local JSONL file selection. Do not reproduce browser connection toasts as new failures.
5. Add start/end markers and wait for the observer baseline before announcing the live server. Record a deterministic fixture scenario with independent CLI commands, bounded waits and owned-process cleanup.

## Verification

- Capture actual observer records and compare replayed state after edits, approvals, epoch replacement and backwards seeking.
- Validate pause/speed/end/step behavior and corrupt, partial, unsupported or mixed-session input.
- Test real HTTP read-only routes, Host/Origin rejection, and replay after shutting down the original provider.
- Run the built package in an isolated installation; verify recorded CLI/browser actions in the actual product renderer, read-only controls, no WebSocket/control requests and narrow-screen layout.
- Build, typecheck, package inspection, compatibility update/check, and generate an actual recording for the user.

## Limits

This is state-event playback, not screen video, exact transport replay or native-operation replay. Missing history, attachments and redacted content remain missing and are disclosed. No global installation, merge, push, deployment or release is included.
