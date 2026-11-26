# pi provider

This package adapts the `pi` coding agent CLI (`@mariozechner/pi-coding-agent`, verified on 0.73.1) to the standalone Provider SDK. It starts one `pi --mode rpc` process per attached session and speaks pi's documented JSONL protocol over stdin and stdout. There is no pi library dependency, no Borgee service and no credential in this package: pi reads its own profile (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), models and keys.

The pi executable is found through `resolvePiExecutable`: an explicit path, then `PATH`, then the places npm and Node managers install global commands (nvm versions newest first), because a login service does not inherit the shell's `PATH`. A JavaScript entry runs under the current Node. The Controller names it with `AGENT_HOST_PI` and the profile with `AGENT_HOST_PI_HOME`.

## What it does

- Create and resume. A session's id is pi's session UUID. Its history is read from pi's session file (`<profile>/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`), along the branch of the last entry written, followed by one history boundary; live events follow. Items are named by the message timestamp pi keeps live and in the file, so a reread names the same items (`itemIdentity`, the journal capability).
- Input. Idle input starts a run; input during a run is pi's steering message (or its follow-up queue for `next_turn`). Input is acknowledged when pi accepts it; a command that times out is reported, never retried. Cancel is pi's `abort`.
- Approvals and Host tools. pi has no permission system and no MCP, so every pi process loads a small extension that ships inside this package (`src/bridge-extension.ts`). It runs from a private temporary directory the session removes; nothing is written under `~/.pi`. The extension asks the adapter before each tool call and registers the Host's tools, over pi's extension UI sub-protocol (an `input` dialog titled `arc.v1`). The adapter maps an approval to the public `tool_approval` interaction (allow once, allow the tool for the session, deny with a message, cancel the run). A Host-owned session starts in YOLO (no approval) and keeps the mode its owner last confirmed; a share recipient's session asks. Host tools of a namespace are named `<namespace>__<tool>`.
- Settings: model (`provider/id` from pi's registry), thinking level for reasoning models, and the tool approval mode. Commands: pi's extension commands, prompt templates and skills, run as `/name args`.
- Read-only sessions start pi with only `read,grep,find,ls` and the Host's tools.
- Usage: session tokens, cost and the current context fill, from `get_session_stats` after each run.

## What it does not do

pi has no questions, plans, forms, subagents or todo list, and the adapter reads no resources and sends no images. A session that never received an answer has no file and cannot be reopened (the error is typed `native_session_unavailable`; no new identity is created under the old id). pi has no lock: a second process on the same session file is accepted and the two fork the history. Two `pi` processes on one file are therefore the person's choice, never the Host's. See the [pi audit](../../docs/current/agent-remote/pi-support-audit.md).

## Tests

- `pnpm test:unit agent-provider-pi` runs the unit tests on a fake of the CLI behind the adapter's native port (`src/test-utils/fake-pi.ts`).
- `pnpm test:native:pi` runs the real CLI against a scripted model on loopback in a temporary profile: the native assumption checks, the journal recordings (`RECORD_JOURNAL_FIXTURES=1` records them again) and the adapter over the process. It needs pi 0.73.1 (`AGENT_PI_TEST_EXECUTABLE` selects it).
