# Borgee Codex app-server Provider

This package adapts the native `codex app-server` JSON-RPC protocol to `@borgee/agent-provider-sdk`. It owns transport lifecycle, session creation and resume, native event projection, typed interaction mapping, and Provider history/live handoff.

| Capability | Support |
|---|---|
| Create, resume, and read thread history | Supported |
| Assistant and reasoning streaming | Supported |
| Command, file-change, MCP, and Web-search timeline items | Supported |
| Todo, lifecycle, and usage updates | Supported |
| Questions | Supported with strict question IDs and explicit answers |
| Command and file-change approval | Supported |
| Planning and plan approval | Supported when native collaboration modes are available |
| Steer and cancel | Supported with the active native turn ID |
| Native session discovery | Supported through paged `thread/list` metadata |
| Resource reads | Unsupported; `readResource` is not advertised or implemented |

The compatibility target verified by local process tests is `codex-cli 0.148.0`. Native `item/started` and `item/completed` notifications are authoritative; deprecated `codex/event/item_started` and `codex/event/item_completed` mirrors are intentionally ignored to avoid duplicate Timeline meaning.

Set `BORGEE_CODEX_TEST_EXECUTABLE` to select the exact Codex executable used by both the local process version check and the provider process. Without the override, the test and provider both resolve `codex` from `PATH`.

The default standalone workbench registers this Provider alongside Recorded and paired DSH Hosts. See the [Codex runbook](../../docs/runbooks/codex-debug.md) for a real CLI installation, native login, session import, and process ownership.

Each open session owns one `codex app-server` child. JSONL on stdin/stdout carries commands, notifications, and approval responses. A bounded stderr tail is included in unexpected-process-exit diagnostics. History comes from `thread/read`; no terminal scraping or file-log polling is required. Closing the session disposes its owned child without terminating other Codex installations.
