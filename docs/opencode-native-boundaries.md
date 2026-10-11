# OpenCode native execution boundaries

The current adapter targets OpenCode **2.0.25 or newer within 2.x** and uses `@opencode/client`. The native regression fixture is pinned to **2.0.25**. These findings describe that native contract; they do not establish behavior for another major version or every model provider. The former 1.x legacy/durable split is not part of the current adapter.

## Reproduce the execution boundary

The tests create temporary HOME and XDG directories, a project, a loopback OpenCode server, and a deterministic loopback model server. Only fixture credentials are passed to the native child. Cleanup stops only the fixture's processes and removes their temporary data. They do not use an existing server or a personal model account.

Run with both the test deadline and an outer process deadline:

```sh
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode python3 -c 'import subprocess; subprocess.run(["node", "--test", "--test-timeout=95000", "scripts/opencode-native-boundaries.test.mjs"], timeout=105, check=True)'
```

The executable variable is mandatory; otherwise the native test is skipped. The test checks the exact native fixture version. Native HTTP requests and model/tool gates have bounded waits. The related `opencode-native-steer.test.mjs` and `opencode-native.test.mjs` cover adapter operations against the same native runtime.

## Admission, execution and message history are distinct facts

The 2.x execution path uses `POST /api/session/{id}/prompt`. Its inbox records accepted input; `GET /api/session/{id}/message` returns executed conversation records. A successful prompt acknowledgement proves admission, not that a model step has started.

The direct native boundary test verifies:

- With `resume: false`, a prompt enters the inbox without entering executed message history or calling the model.
- A prompt ID retains its first admitted payload. Repeating that ID with different text does not replace the original input. Reusing it for another native session is rejected with HTTP 409.
- Interrupting an idle session returns `interrupted: false` and preserves its inbox. Interruption does not mean queued input was cancelled.
- Pending inbox input survives a server restart without starting a model request. Explicitly resubmitting its same ID with `resume: true` executes the original input once.
- The delivered input uses the admitted prompt ID in executed user-message history. An already executed ID is not queued again by a later duplicate submission.
- Executed message IDs and the terminal outcome survive another restart.

ARC keeps its public process-local operation settlement boundary separate from this native identity behavior. It does not claim that an in-memory Host operation cache survives a restart. It does not automatically resubmit an operation whose execution outcome is unknown.

For an ordinary input with a lost acknowledgement, the adapter reads bounded native message history in its authoritative sequence. The exact input ID and content followed immediately by an assistant record can establish that execution started. Any intervening input, control change, synthetic context, compaction or idle record makes this inference unavailable. Timestamps and IDs never replace native sequence order. This proves ordinary input execution, not the system instructions or complete settings used during that execution.

Inline image readback additionally requires unchanged MIME type, bytes, filename and attachment annotations. Native image resizing or transcoding can prevent that exact match; a lost acknowledgement then remains unknown rather than being inferred from similar content.

OpenCode 2.0.25 does not persist the experimental session event log by default. Its public message history cannot prove the complete historical system-instruction selection required by ARC's prepared-input contract: an instruction can be changed and restored while leaving the same current configuration and message history. Therefore the adapter explicitly reports native evidence as unavailable and rejects Handoff preparation before creating or sending anything. It does not advertise a configured capability that only produces unknown results. An additional reviewed native recording mechanism would be needed before enabling that contract; ordinary sessions, callbacks and native prompt-edit forks remain available.

Ordinary session opening does not create an evidence-profile observer or read ancestor sessions for this unavailable capability. Its own child-session listing remains part of ordinary session observation, and lost-acknowledgement recovery reads native history independently of Handoff evidence.

## History pagination uses opaque cursors

The native message cursor includes ordering. The native boundary test reads all executed records with `limit=1`, follows opaque cursors without omissions or duplicates, and verifies that supplying `order` alongside a cursor is rejected with HTTP 400. The adapter supplies ordering only on the first page, preserves the native sequence across pages and does not derive a cursor from a message ID. Message timestamps can run backwards across control and model-step records; re-sorting them would change causality.

## Busy input follows the native execution loop

`delivery: "steer"` can admit follow-up input while the current model or native tool is active. It does not interrupt that in-flight work. The native busy-input test holds each boundary, admits a follow-up, then verifies that subsequent model input preserves the original conversation and completed tool output.

The adapter uses this native operation directly. It never cancels and resends to simulate steer. An uncertain admission retains its local reservation until native evidence or a definitive native result settles it. Unrelated busy/error events cannot prove that a particular input was accepted or executed.

## Host callbacks require trusted native invocation context

ARC installs a small explicit OpenCode 2.x plugin. Its `setup(context)` registers tools through `context.tool.transform`; tool execution receives the native `sessionID`. Callback setup writes a plugin directory containing `server.js` and `package.json`, because the 2.x native loader ignores configured local plugin files.

The plugin-to-Host loopback channel is independently authenticated. Host grants are bound to the native session ID supplied by execution, not an ID selected in model arguments. Unregistered sessions cannot discover or invoke callbacks. The Host rechecks source workspace access on every read. A transport connection ID or shared MCP registration would not by itself establish this conversation identity.

Ordinary OpenCode sessions share a native server that may be externally supervised or managed by Controller. Callback installation remains explicit and does not automatically restart that server. Ask/source references require the plugin to report readiness for the configured native endpoint and directory. Native questions and permissions use their own APIs and do not depend on the callback plugin. See [callback setup](opencode-callbacks.md).

## Prompt edit uses an independent native fork

The native fork operation copies the prefix strictly before the selected message. The real native fixture confirms that the fork excludes the selected second prompt, leaves the source history unchanged and preserves workspace file contents. ARC does not call native revert on the source to implement prompt editing.

The adapter validates that the selected record is the first user prompt of a turn, and checks activity, pending inbox input and interactions before forking. A mid-turn steer, unsupported input binding, active native revert or native child conversation is not an editable prompt. Native fork reconstructs selections at its boundary; the resulting snapshot is authoritative.

These semantics provide an independent conversation branch. They do not provide an atomic lock against another native client changing the source between validation and fork, nor a workspace rollback.
