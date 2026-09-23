# Codex daemon lifecycle diagnostics

The Controller records lifecycle evidence without owning, restarting, or probing native sessions. It does not change restart policy or inject credentials into an already running process.

## Inspect a Host

```sh
agent-remote-controller diagnostics --source daemon --since 2026-09-23T03:40:00Z --limit 100
agent-remote-controller diagnostics --paths
```

The Host state directory contains `codex-daemon.log`. It uses the existing bounded diagnostic rotation (5 MiB and three archives). Lifecycle CLI commands append to the same journal even if the Controller is stopped. Website restart operations retain their operation ID through the CLI invocation. A started command without a completion record is an unknown outcome, not proof of failure.

The Controller checks local daemon PID records every 30 seconds and during native initialization/unavailability diagnostics. Only changed PID records trigger process/environment inspection and a snapshot. POSIX process inspection checks PID plus start time before and after inspection. Key values and complete command lines are never written; `OPENAI_API_KEY`, `CODEX_GATEWAY_API_KEY`, and `LC_ALL` are reported as presence states. Windows records the managed native PID; reading its environment is unsupported and reported as unknown. Custom sockets and private sessions are not monitored as the default shared daemon.

## Native lifecycle journal

Native Codex instrumentation is a separate change and must be built into Codex to produce `CODEX_HOME/app-server-daemon/lifecycle.jsonl`. Updating only the Controller does not enable native events on older Codex builds. The Controller remains compatible when this journal is absent.

The native journal is bounded to 1 MiB per file plus three archives. It records:

- Explicit lifecycle commands and automatic updater restart decisions.
- Spawn intent and result, including the spawning PID and target PID.
- Graceful stop requests, grace-period expiration, force termination, and stop completion.
- App-server/updater startup environment presence, process instance, and version.
- Received shutdown signal and the number of running assistant turns and connections.

A signal recipient does not identify the sender through the existing Tokio signal API. It records `sender_unknown`. The manager's send-side event identifies known senders; missing evidence must not be interpreted as proof that an updater, user, or Controller sent a signal. Unexpected termination before a record can be written (for example SIGKILL) is observable only from the sending side or subsequent process replacement. Journal writes are best effort and never block lifecycle actions waiting for another journal writer.

The Controller imports only allowlisted fields. Native event timestamps are preserved separately from the import time. Local read offsets survive Controller restarts and follow rotation; an interrupted import may repeat the last batch. Journal I/O errors do not prevent native commands or Host startup.

## Correlate an incident

Match the old daemon PID/start time, a stop request's target PID and sender PID, its grace/force phases, and the subsequent spawn/start events. Compare the launching process's environment presence with the new daemon's startup environment. An updater missing a key is a risk, but only a matching restart/send/spawn chain attributes an incident to that updater.

These records contain process metadata, not conversation contents. There is no new server API, public protocol field, automatic retry, or daemon restart behavior.
