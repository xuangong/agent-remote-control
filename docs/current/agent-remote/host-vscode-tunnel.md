# Host VS Code Tunnel

The Controller owns one VS Code tunnel for its Host. Agent sessions only provide workspace navigation links; creating, closing, or switching a session does not start or stop the tunnel. The owner manages it in the sidebar's VS Code panel. Shared Host viewers cannot read device codes or manage the process.

## Availability

The first Host status request runs a bounded `tunnel --help` capability probe. Missing or non-executable CLIs, unsupported tunnel commands, and unsupported operating systems return an `unavailable` state; Start and workspace links are disabled with a reason. Unavailable results are cached for one minute before another status request retries detection. No tunnel starts during capability detection.

## Process ownership and reclamation

The CLI runs from `AGENT_HOST_STATE_DIR`, with an isolated `vscode-tunnel` CLI data directory and a stable machine name derived from the Host installation ID. The Controller uses `code` on its own PATH. `AGENT_HOST_VSCODE` can explicitly select a local CLI executable. The browser cannot supply executables or arguments.

A small Node supervisor owns the native process group. It monitors the Controller's pipe and IPC channel; EOF triggers cleanup even if the Controller receives SIGKILL. Normal stop, unexpected CLI exit, and Controller loss send SIGTERM to the owned group, then SIGKILL after two seconds to reclaim remaining descendants. The CLI also receives `--parent-process-id` pointing to its supervisor. The process PID in the snapshot identifies the supervisor. Status probes use the same ownership mechanism and a three-second execution deadline.

This implementation supports macOS and Linux process groups. Windows starts are refused because Windows requires a Job Object or equivalent process-tree lifetime mechanism. It does not install a VS Code background service or adopt an existing singleton; an attached-instance report stops the managed client and reports failure. Existing manually managed tunnels are untouched.

Relay disconnection starts a five-minute grace period. Reconnection before the deadline cancels reclamation; connection retries do not extend it. After the deadline the tunnel stops and its authorization code and links are cleared. `AGENT_HOST_VSCODE_DISCONNECT_TIMEOUT_MS` overrides the positive timeout and is retained in private Controller configuration. Browser closure, session switching, and hidden tabs do not count as Relay disconnection. Reconnection after reclamation and Controller restart require an explicit Start action; there is no automatic tunnel restart.

Pending device authorization expires after fifteen minutes and reclaims the process. Raw stdout/stderr are parsed in memory with bounded line buffers and are not persisted or sent to clients. The snapshot carries only recognized authorization fields, machine identity, connection/process status, and controlled diagnostics. Native VS Code owns its CLI cache and account credentials; its macOS keychain credentials may be shared despite the separate CLI data directory.

## Management and client behavior

Owner-authorized `GET /v1/remote/hosts/:hostId/vscode-tunnel`, `POST .../start`, and `POST .../stop` reuse the existing authenticated Host RPC uplink. Start requires `{ "acceptLicense": true }`. Responses are uncached; mutations use existing origin and account checks. No provider events or session timeline messages carry these operations.

The parser accepts split stdout/stderr device-code prompts, ANSI tunnel banners, and the CLI's machine status output. Login links are allowlisted. The Controller checks `code tunnel status --cli-data-dir ...` every five seconds while active, distinguishing a running process from a connected tunnel. A disconnected status clears the old URL while the CLI reconnects.

The visible frontend polls the active Host every two seconds and refreshes on visibility restoration. User mutations supersede older status queries. Host unavailability, request errors, or process exit disable workspace links. The Host panel displays the Host name, authorization code and sign-in link, machine link, process/connection state, and Start/Stop controls. Each session header uses its absolute workspace path to form `https://vscode.dev/tunnel/<machine>/<encoded-path>` and opens VS Code in a new tab.

VS Code's account authorization governs editor access and its own tunnel transports editor traffic. Relay authentication governs management operations. Workspace links are navigation targets, not filesystem isolation; in a sandbox or container, VS Code sees that environment's filesystem. The Controller and its supervised children must run in the same environment. A container PID 1 should reap exited children; process groups do not constrain arbitrary programs deliberately escaping their group.

## Validation and implementation

Tests cover real fixture subprocesses, split output, process-group cleanup after Controller SIGTERM/SIGKILL, stubborn descendants, disconnect grace periods, owner authorization across real HTTP/WebSocket transport, stale frontend responses, and desktop/mobile browser flows. Browser tests simulate Microsoft's device authorization; they do not log in to a real account or modify an existing tunnel.

- `packages/agent-host/src/vscode-tunnel.ts`
- `packages/agent-host/src/vscode-tunnel-supervisor.ts`
- `packages/agent-host/src/vscode-tunnel-output.ts`
- `packages/agent-remote-protocol/src/vscode-tunnel.ts`
- `packages/agent-remote-hosted/src/broker.ts`
- `packages/agent-remote-lab/src/vscode-tunnel.tsx`
- `packages/agent-remote-lab/src/components/HostVscodeTunnel.tsx`

CLI behavior was checked against Microsoft's [Remote Tunnels documentation](https://code.visualstudio.com/docs/remote/tunnels) and the installed version's [tunnel implementation](https://github.com/microsoft/vscode/blob/7debcd0e2acdea1c52de81bf9ee1620444407dda/cli/src/commands/tunnels.rs) and [shutdown signals](https://github.com/microsoft/vscode/blob/7debcd0e2acdea1c52de81bf9ee1620444407dda/cli/src/tunnels/shutdown_signal.rs).
