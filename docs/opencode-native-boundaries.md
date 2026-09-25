# OpenCode native execution boundaries

Verified against native OpenCode **1.18.18**. These findings describe the server contract; they do not establish complete provider parity.

## Reproduce the execution boundary

The test uses raw native HTTP APIs. No package build, personal model account, existing server, or adapter-generated fixture is involved. It creates a temporary HOME and XDG directories, a project, a loopback OpenCode server, and a deterministic loopback model server. Only fixture credentials are passed to the child. Cleanup stops only the child and fixture servers and removes their temporary data.

Run with both an outer process deadline and the test's built-in deadline:

```sh
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode python3 -c 'import subprocess; subprocess.run(["node", "--test", "scripts/opencode-native-boundaries.test.mjs"], timeout=90, check=True)'
```

The executable variable is mandatory; otherwise the native test is skipped. The test asserts version 1.18.18 so a changed upstream contract requires deliberate revalidation. Each HTTP request is bounded, the test has a 75-second deadline, and its native child has a separate 70-second watchdog.

## Legacy and durable execution do not share conversation history

The established execution path uses `POST /session/{id}/message`, `POST /session/{id}/prompt_async`, and `GET /session/{id}/message`. Durable execution uses `POST /api/session/{id}/prompt`, `GET /api/session/{id}/context`, and `GET /api/session/{id}/history`.

A shared session ID does not make these paths interchangeable. The reproducible test:

1. Stores `LEGACY_ORIGINAL_CONTEXT` through the legacy prompt endpoint with `noReply: true`.
2. Sends `DURABLE_FIRST_INPUT` through the durable endpoint and observes an actual model HTTP request.
3. Holds that model response open, admits a second durable prompt with `delivery: "steer"`, then releases the first response.
4. Verifies the second model request follows the first assistant response and contains the second durable prompt.
5. Verifies neither model request includes `LEGACY_ORIGINAL_CONTEXT`; legacy history still contains only that original message, while durable context contains its separate user and assistant messages.

The durable event stream uses `session.next.*` events. Its model configuration reads `providers` with provider API definitions and integration availability; the legacy path reads `provider` with AI SDK options. The fixture configures both explicitly.

Native durable admission has a real follow-up scheduling mechanism. A busy `steer` is consumed after the active model step; it does not interrupt that in-flight model request. See [durable prompt admission](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/core/src/session.ts#L360-L385) and [the run coordinator](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/core/src/session/run-coordinator.ts#L54-L103). The tested `/api/session/{id}/wait` endpoint returns HTTP 503, while `/interrupt` returns 204.

Consequently, replacing a legacy send or steer operation with a durable prompt would lose the visible conversation's context. Durable execution requires a separate migration of history, event projection, models, tools, permissions, and recovery. The provider keeps legacy execution: native `prompt_async` accepts immediate follow-up input during work. It does not advertise a separate next-turn queue.

## Legacy busy input preserves the original context

`scripts/opencode-native-steer.test.mjs` uses the same isolated runtime with a held model response and a gated native shell command. It verifies that legacy `prompt_async` accepts follow-up input during both steps and that the subsequent model request retains the original history and tool result. It then repeats the model case through the built adapter's `steer` method and checks one native user echo and a stable normalized turn identity.

An immediate follow-up does not interrupt the active model or tool request. OpenCode consumes it in its native loop. The adapter never cancels and resends to simulate steer, and never crosses into durable history. An ambiguous acknowledgement keeps its admission reservation until matching native evidence or explicit cancellation resolves it; unrelated busy/error events and earlier cancellation acknowledgements cannot release a newer reservation.

## MCP callbacks lack a native conversation identity

This is a **source-verified boundary**, not a claim made by the execution test above.

The native MCP call adapter sends the tool name and model-supplied arguments. It does not attach the calling OpenCode session ID or tool-call ID to the MCP request. See [`McpCatalog.convertTool`](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/mcp/catalog.ts#L43-L70). Remote MCP HTTP headers are established on the shared client, not selected for each conversation; see [remote client setup](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/mcp/index.ts#L238-L285). An MCP transport session identifier is not an OpenCode conversation identifier.

Registering a global MCP tool with a source-specific bearer token would therefore identify the registration, not the native conversation invoking it. Asking the model to provide `sessionID` does not establish a trusted identity. Disabling a tool in some managed prompts cannot isolate other native clients of the same shared server.

A safe Host callback implementation needs an explicitly installed native plugin or another native extension that supplies trusted invocation context. The [native tool dispatch](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/tools.ts#L390-L423) has that session context before it calls MCP. The explicit ARC plugin integration follows these constraints:

- Authenticate the plugin-to-Host connection independently of model arguments.
- Bind each callback registration to the native session ID supplied by native execution.
- Reject unregistered sessions and recheck source workspace access on every read.
- Restore or revoke grants on resume, disconnect, and close, and report unavailable callbacks clearly.

The bridge uses native `context.sessionID`, a private process-local authenticated loopback endpoint, and per-session callback bindings. The adapter connects to an independently managed server and never silently modifies its plugins or restarts it. Ask/source references become available only after explicit plugin setup and capability detection. Reads remain dynamic, enforce the current source workspace policy, and do not replace history with a prompt snapshot. See [callback setup](opencode-callbacks.md). Native questions and permission approvals use their existing native APIs independently of this plugin.

## Prompt edit uses an independent native fork

The legacy [fork implementation](https://github.com/anomalyco/opencode/blob/v1.18.18/packages/opencode/src/session/session.ts#L693-L733) copies messages strictly before the selected message ID into a new session. It does not revert workspace files. A missing message ID instead falls back to copying all history, so the adapter validates the selected user message before requesting the fork. It does not call native revert on the source.

These semantics support an independent prompt-edit branch. They do not make native revert interchangeable with prompt editing, or provide an atomic lock against another native client changing the source during validation and fork.
