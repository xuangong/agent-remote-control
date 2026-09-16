# Borgee Codex app-server Provider

This package adapts the native `codex app-server` JSON-RPC protocol to `@agent-remote-controller/agent-provider-sdk`. It owns transport lifecycle, session creation and resume, native event projection, typed interaction mapping, and Provider history/live handoff.

| Capability | Support |
|---|---|
| Create, resume, and read thread history | Supported |
| Assistant and reasoning streaming | Supported |
| Command, file-change, MCP, and Web-search timeline items | Supported |
| Todo, lifecycle, and usage updates | Supported |
| Questions | Supported with strict question IDs, explicit answers, and sensitive receipts |
| Command and file-change approval | Native decisions, cancellation, session scopes, and explicit policy amendments |
| MCP form and URL elicitation | Flat typed forms and explicit HTTP(S) action acknowledgment |
| Granular permission approval | Whole-request filesystem/network grants, with turn or session scope |
| Parent-session subagent activity | Native tool rows with bounded results and direct-child relationship summaries |
| Independent child sessions | Same-runtime navigation, history and interactions; direct controls require native `canAcceptDirectInput`; saved children are read-only |
| Planning and plan approval | Supported when native collaboration modes are available |
| Steer and cancel | Supported with the active native turn ID |
| Provider command directory | Native enabled skills and custom prompts, plus model, permissions, and compact adapters |
| Native session discovery | Supported through paged `thread/list` metadata |
| Native image viewing and generation | Assistant Markdown backed by opaque session resource references |
| Resource reads | Only local files or embedded raster bytes explicitly referenced by native image items |

The compatibility target verified by local process tests is `codex-cli 0.148.0`. Native `item/started` and `item/completed` notifications are authoritative; deprecated `codex/event/item_started` and `codex/event/item_completed` mirrors are intentionally ignored to avoid duplicate Timeline meaning.

Set `BORGEE_CODEX_TEST_EXECUTABLE` to select the exact Codex executable used by both the local process version check and the provider process. Without the override, the test and provider both resolve `codex` from `PATH`.

The default standalone workbench registers this Provider alongside Recorded and paired DSH Hosts. See the [Codex runbook](../../docs/runbooks/codex-debug.md) for a real CLI installation, native login, session import, and process ownership.

Each opened root owns one `codex app-server` process. Its native child session views share that runtime and do not spawn another process. JSONL on stdin/stdout carries commands, notifications, and approval responses. A bounded stderr tail is included in unexpected-process-exit diagnostics. History comes from `thread/read`; no terminal scraping or file-log polling is required. Closing the session disposes its owned child without terminating other Codex installations.

Native `imageView` and `imageGeneration` completions share one image registry across history and live projection. The adapter preserves native `path`, `savedPath`, and result-file references, resolves relative paths against the session working directory, and supports embedded base64 or raster data URLs. Public Markdown contains opaque `codex-image` locators; the reader rejects arbitrary path requests and never fetches remote URLs. PNG, JPEG, GIF, and WebP signatures are checked before serving bytes. Each image is limited to 16 MiB, with separate 64 MiB budgets for registered embedded data and materialized bytes. The first read result is retained until disposal, including unavailable outcomes, so changing a file cannot change an already materialized replay resource. Missing, failed, unsupported, or oversized images remain explicit unavailable references or diagnostics.

MCP `form` and `openai/form` schemas accept a bounded flat object: text, finite numbers and integers, booleans, single-select enums, and multiselect enums. String length/format, numeric bounds, array bounds, defaults, and titled/legacy enum labels are preserved. Nested objects, arbitrary schema constraints, invalid defaults, and unsafe URLs are declined with a visible diagnostic. Sensitive defaults are declined instead of publishing them. Form responses and secret question text reach only the native request; resolved observations redact sensitive values.

Permission approval shows every native read, write, deny, and network grant, including glob scan depth and symbolic paths. The adapter retains the native permission object privately and returns only that request after explicit approval; clients cannot supply a replacement grant. Unsupported permission structures receive an empty grant and a visible diagnostic. Command choices follow `availableDecisions`; opaque policy IDs identify exact native amendment objects.

Pending RPC interactions recover while this Provider session remains alive. Native request resolution, interrupted turns, process termination, and disposal clear transient requests without synthesizing input or sending duplicate native responses. A native resolution notification does not include another client's answer: its remote receipt records dismissal/cancellation, and permission closure explicitly states that this remote client granted nothing.

Plan review is synthesized from completed plan items and is process-local. Persistence handles store session configuration, not reviewed-plan decisions; restarting the Provider restores native conversation history but does not reconstruct a pending plan review or distinguish an already reviewed plan. No durable plan-review parity is claimed.

The command directory refreshes enabled skills through `skills/list` with `forceReload` and the session working directory. Execution refreshes the directory again and rejects removed commands. Skills retain their native name/path input and pass arguments unchanged to `turn/start`. The model command opens a model question followed by the selected model’s reasoning efforts; permissions opens approval-policy or sandbox choices. These controls wait for native setting confirmation and preserve Planning. Compact calls `thread/compact/start`. Commands require an idle session and serialize against pending interactions, message submission, and setting changes.

Custom prompts are top-level Markdown files in `CODEX_HOME/prompts`, using the Provider environment override before the process environment or `~/.codex` default. Discovery ignores symlinks and files above 256 KiB, validates names, and limits directory scans to 1,024 entries. Prompt frontmatter supplies `description` and `argument-hint`. Expansion preserves raw `$ARGUMENTS`; named, positional, escaped-dollar, and braced placeholders fail explicitly. Arguments for a prompt without `$ARGUMENTS` are rejected. The input hint names this grammar limit. This directory is adapter-owned native discovery, not terminal menu scraping; additional TUI commands and goal controls are not exposed.

See the [Provider support baseline](../../docs/current/agent-remote/provider-support.md) for per-endpoint support, conditional child controls and explicit degradation boundaries.

## Questions in ordinary sessions

The adapter enables `features.default_mode_request_user_input` through the native
`config` argument on `thread/start` and `thread/resume`. Ordinary Default sessions
can ask structured questions without entering Plan. Claude and Copilot use their
native question callbacks for the same ordinary-session experience; supported
question shapes remain provider-specific.

This is a session runtime policy: it also applies when the user opens a discovered
CLI thread or resumes an old handle after a Host restart. The directory has no
reliable historical ownership marker, so it does not guess ownership from `cwd`,
model, or the presence of a persistence handle. The override takes precedence over
an explicit `false` in the selected profile for this runtime. No profile file is
written. Listing threads, reading history, and opening an existing same-runtime
child do not issue a separate feature override. Approval policy, sandbox and
collaboration mode remain independent.

Native Default questions have `isBlocking: false`; they still need an explicit
answer or cancellation. Request identity, response validation, cancellation and
late-answer rejection use the existing Question lifecycle. A feature being
available does not force the model to ask. The verified native target is Codex
0.148.0; a native configuration error is surfaced rather than retried without the
feature. This adapter does not add a feature-negotiation API for arbitrary Codex
versions or recover pending callbacks across process restarts.
