# pi support audit

This records the first admission of pi on `feat/pi-provider` (based on `d212c184`). It is not a full-parity, deployed or published-release claim. The [baseline](provider-support.md) includes all 40 pi S/I/T/X/C/R/A/H cells.

## Capability record

| Field | Content |
| --- | --- |
| Provider / integration | `pi`; executable Host provider (`packages/agent-provider-pi`, registered by `packages/agent-controller/src/pi.ts`). |
| Revision / compatibility | Branch `feat/pi-provider`. Native CLI pi **0.73.1** (npm `@mariozechner/pi-coding-agent`), driven through `pi --mode rpc` (JSONL over stdio). No SDK. Minimum and verified version are both 0.73.1: pi is pre-1.0 and its RPC protocol changes between releases. |
| Native identity | The session UUID in the header of a JSONL file `$PI_CODING_AGENT_DIR/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` (default `~/.pi/agent`; `PI_CODING_AGENT_SESSION_DIR` overrides the directory). `sessionDir` in the user's `settings.json` is not read, so a profile that sets it is not listed. |
| Capability / descriptor | `sessionExtensions { instructions, tools, toolNamespaces: 'attachment' }`, `sessionAccess.readOnly`, `sessionHostAccess`, `journal.itemIdentity 1`, `behaviour` in `src/behaviour.ts`. Root capabilities: history, send, queue, steer, cancel, session settings, commands, tool approval, resource input. |
| Disposition | Implemented, with the accepted limits below. |

## Native boundary

The adapter starts one pi process per attached session (`--mode rpc --offline`, `PI_SKIP_VERSION_CHECK=1`, so no startup network operation) in the session's workspace. Records are framed by LF only, as `docs/rpc.md` of pi requires. Configuration and sign-in stay in pi's own profile; the adapter never reads or writes credentials. `AGENT_HOST_PI` selects the executable; otherwise it is found on PATH, then in npm and Node-manager global directories (nvm newest first). A JavaScript entry runs under the Controller's Node. `AGENT_HOST_PI_HOME` sets `PI_CODING_AGENT_DIR`.

History does not need a process: it is the active branch of the session file (the leaf is the last entry written). An entry or message role the adapter does not know is one diagnostic and no row.

## Native sharing

pi has no server and no lock. A Remote session is one pi process; a pi terminal may open the same file (`agent-remote-controller pi --session <id>`), but a second process on a session another process writes is accepted and the two fork the history: the reader follows the branch of the last write. The declaration is `concurrency.model fork_on_divergence`, `probe none`, `othersVisible on_reread`. The native check "accepts a second process…" verifies it. Sharing is through the Host protocol only.

## Approval bridge and Host tools

pi has no permission system and no MCP. The adapter loads one extension with `-e` from a private temporary directory it removes with the session; nothing is written under `~/.pi`. The extension hooks `tool_call` and registers the Host's tools. It reaches the adapter through pi's extension UI sub-protocol: `ctx.ui.input` titled `arc.v1` whose placeholder carries one JSON request; the adapter answers on stdin. Dialogs of user-installed extensions (select, confirm, input, editor) are cancelled by the adapter, so they cannot hang pi (native check).

- **Approvals.** In ask mode a tool call becomes a typed `tool_approval`: allow once, allow for the session (that tool name until the session closes), deny with a message, or cancel (which also aborts the run). In YOLO every call is answered at once with no interaction. Approvals are live-only items.
- **Host tools.** Tools of `toolNamespaces` are named `<namespace>__<tool>` (a bot's `message` is `agent_remote__message`), flat `tools` keep their name. Arguments are validated by the SDK binding before the Host callback runs; the tools run without a prompt. Namespaces are fixed while attached (`attachment`).
- **Environment and skills.** `hostAccess.environment` is given to pi's process; `hostAccess.skills` is passed as `--skill <dir>/skills`.

## YOLO, permission mode and read-only

A new session of the Host owner starts in YOLO (no approval); a share recipient's keeps asking and needs a recent sign-in to change it. The mode is the setting `tool_approval_mode` (`ask` or `allow`), and the Host's `SessionPermissionModeStore` keeps the last confirmed value so a reopened session keeps it. A read-only session runs pi with `--tools read,grep,find,ls` plus its Host tools, so no write tool exists, and its permission setting is immutable. A Host that locks permissions keeps its own policy.

## Accepted losses and gaps

- A session never answered has no file, so it cannot be reopened after its process ends. The adapter fails explicitly (`native_session_unavailable`) rather than open a new identity under the old id; the Host's creations store is deliberately not used.
- Image input is not sent and images are not shown (pi accepts them): a candidate gap. Resource input is sent as `<agent-resource>` text references. `readResource` is unavailable.
- No planning, questions, plans, forms, permission requests, external actions, todos or children: pi has none.
- Edit and write results are pi's own diff text, not normalized `file_changes`. Compaction shows completed entries only and cannot be started from the adapter.
- Native prefix (prompt edit) and quiescent succession are unsupported; the Host reports succession unsupported for pi.
- No usage-limit signal (`limits.signal none`): pi retries provider errors itself, and a provider error arrives as a failed turn with its message.
- Typed failures: `native_exited`, `native_resume_timeout`, `native_request_timeout`, `native_session_unavailable`, `native_runtime_unavailable`.

## Item identity

Keys come from the message timestamp pi keeps live and in the file: `user:<ts>`, `assistant:<ts>:<i>`, `reasoning:<ts>:<i>`, `tool:<callId>`, `error:<ts>`, `compaction:<firstKeptEntryId>`. Interactions are live-only (`interaction:<id>`).

## Rows

| Row | Degree | Native mapping, exposed path and loss |
| --- | --- | --- |
| S1 | S | `pi --mode rpc` started in the Host-selected workspace; native id is the session UUID from `get_state.sessionId`. |
| S2 | P | Catalog and history read the JSONL session files; resume starts pi with `--session <file>`. A session that never got an answer has no file and cannot be reopened (`native_session_unavailable`). |
| S3 | N | pi has no server or lock; a Remote session is one pi process. A pi terminal may open the same file (`agent-remote-controller pi --session <id>`), but two writers fork the history. |
| S4 | S | One pi process per attached session, stopped on dispose or release; catalog and history reads need no process. |
| S5 | C | Model and thinking level are applied after start (`set_model`, `set_thinking_level`) from the models pi lists; planning is N. |
| I1 | S | RPC `prompt`; acceptance is the command response. |
| I2 | S | `prompt` with `streamingBehavior: steer`; reported queued when a run is known to be active, unknown while a just-sent prompt has not started. |
| I3 | S | `prompt` with `streamingBehavior: followUp` for `delivery: next_turn`. |
| I4 | S | RPC `abort`; pending approvals resolve as cancel. |
| I5 | S | A response with `success: false` is a rejection with no effect; a timeout is reported as unknown and never retried. |
| T1 | S | History is the active branch of the session file (leaf = last entry written), then one boundary; live and file name each item by the same key. |
| T2 | S | User text, text and thinking blocks, tool calls and results, errors and turn outcomes from the stop reason of the last answer. |
| T3 | P | Bounded text results, exit code and truncation when pi reports them. Edit and write results are pi text, not normalized file diffs. |
| T4 | P | Completed compactions live and from the file; no in-progress item. No todo list in pi. |
| T5 | S | Session tokens, cache and cost, and current context fill, from `get_session_stats` after each run. |
| T6 | P | Title is the `/name` name, else the first prompt. Rename uses `set_session_name` when loaded and appends a `session_info` entry otherwise. |
| X1 | N | pi has no question tool. |
| X2 | S | Approval bridge: a `tool_call` hook of the adapter's extension asks the adapter, which raises a typed `tool_approval` (once, session scope by tool name, deny, cancel). |
| X3 | N | pi has no plan mode. |
| X4 | N | No forms; dialogs of user-installed extensions are cancelled. |
| X5 | N | No filesystem or network grants in pi. |
| X6 | N | No external action requests in pi. |
| X7 | P | Requests are validated against the pending one and stale answers rejected. Approvals are live-only (not in the session file); their receipts are lost after a restart. |
| C1 | S | `get_available_models` lists models as `provider/id`; thinking level choices depend on the model's `reasoning` flag. |
| C2 | S | Setting `tool_approval_mode` (ask or allow), kept by the Host between attachments; immutable for read-only sessions. |
| C3 | P | `get_commands`: extension commands, prompt templates and skills run as `/name args` prompts. |
| C4 | P | Skills appear as `skill:<name>` commands; invocation is pi's own expansion. |
| C5 | N | No documentation locator is exposed. |
| C6 | P | Prompt templates are listed as prompt commands; compaction cannot be started from the adapter. |
| R1 | N | No session-owned resource reads (`readResource` is false); images are not sent or shown yet. |
| R2 | P | Resource input is sent as `<agent-resource>` text references the Host owns; tool output is bounded by the shared limit. |
| A1 | N | pi has no native subagents. |
| A2 | N | No children. |
| A3 | N | No children. |
| A4 | N | No children. |
| A5 | N | No children; the root owns its process. |
| A6 | N | No native orchestration. |
| H1 | S | Provider-neutral Host/Relay recovery; the adapter holds no connection state beyond its process. |
| H2 | P | A restarted Controller reopens a saved session from its file; the permission mode returns from the Host store; pending approvals and a never-answered session are lost. |
| H3 | S | Handles are validated per provider and id; one process per session; dispose stops only that process and removes its private work directory. |

## Verification record (2026-11-26)

- `pnpm test:unit agent-provider-pi`: 6 files, **68 passed** (mock data; a fake of pi behind the native port `PiLauncher`).
- `pnpm test:native:pi` (real pi 0.73.1, temporary profile, scripted loopback OpenAI-compatible model; nothing signs in): 3 files, **25 passed**: `tests/native-assumptions.local.test.ts` (9), `tests/native.local.test.ts` (8), `tests/journal-recording.local.test.ts` (8, the recorder compared with the eight committed recordings).
- A fixture proves the adapter's use of pi's protocol; it does not prove an online model workflow.
- Not verified: online model workflows, a deployed Relay with a pi Host, Windows (the process port and framing are platform neutral but nothing ran there), pi versions other than 0.73.1, a profile whose `settings.json` sets `sessionDir`, and image input.
