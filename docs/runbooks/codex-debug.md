# Codex installation and debugging

The independent Agent Host manages a separate `codex app-server` process for each open root session tree. DSH uses its installed Host plugin; Codex uses JSON-RPC over the CLI's stdin/stdout. Both feed the same Provider SDK, Relay, browser Timeline, and `bdb` debugger.

## Install and launch

Run from the Agent Remote Control repository root with Node 22 or newer. Complete the repository dependency install and `pnpm build` from the [root setup](../../README.md#run-locally) before invoking Agent Host commands. Install the verified CLI locally using the Tencent registry:

```bash
npm install --prefix .runtime/codex --registry=https://mirrors.cloud.tencent.com/npm/ --no-audit --no-fund @openai/codex@0.148.0
.runtime/codex/node_modules/.bin/codex --version
.runtime/codex/node_modules/.bin/codex login
pnpm dev
```

The login command is needed only if that native Codex profile is not already authenticated. Existing credentials and model/provider settings remain owned by Codex. The workbench does not copy them into its configuration or generate an API key.

In the browser, open **Pair Agent Host** and generate a key. Start the Host in another terminal. When the model provider in `~/.codex/config.toml` uses `OPENAI_API_KEY`, pass it to this Host environment:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-generated-key'
export AGENT_HOST_CODEX="$PWD/.runtime/codex/node_modules/.bin/codex"
export AGENT_HOST_WORKSPACE=/absolute/path/to/workspace
OPENAI_API_KEY=test pnpm agent-remote-controller start
```

The Codex child inherits this key and the native profile's configured base URL. The broker never stores it. This does not modify the profile or store credentials in the workbench.

Open `http://127.0.0.1:6175`, select **Codex · <Host name> · Online**, choose the working directory, and click **Open session**. A fresh thread has an empty Timeline. Send a message to start its first turn. **Send message** also supplements a running turn; **Interrupt**, questions, and tool approvals use the same process and native thread. Planning is available when the CLI reports both planning and normal collaboration modes.

To use a separate profile, create its directory and log in with the same home before launching:

```bash
mkdir -p .runtime/codex-home
CODEX_HOME="$PWD/.runtime/codex-home" .runtime/codex/node_modules/.bin/codex login
AGENT_REMOTE_CODEX_HOME="$PWD/.runtime/codex-home" \
AGENT_HOST_CODEX="$PWD/.runtime/codex/node_modules/.bin/codex" \
AGENT_HOST_WORKSPACE=/absolute/path/to/workspace \
pnpm agent-remote-controller start
```

## Discover and resume

**Discover sessions** lists up to 500 recent unarchived native threads, ordered by activity, from the selected Codex home. Root discovery reads metadata via `thread/list`; subagent threads are excluded from that root catalog. The console groups runtime-discovered children below their parents and keeps the known relationships while navigating between chats. Selecting a row explicitly resumes that original thread via `thread/resume` and reads its history via `thread/read`. Native files are not moved or deleted. New threads stay alive before their first turn because Codex may not persist an empty thread yet.

This is control of processes owned by Agent Host. It does not attach stdio to an already-running terminal or Codex desktop process. Avoid simultaneously continuing the same native thread in another application. A browser reconnect reuses the Host-owned native session. Stopping the Host closes its app-server children. `pnpm agent-remote-controller start` creates the managed daemon and management socket. `pnpm agent-remote-controller foreground` is only for attached debugging and cannot accept a later daemon `pair` command. Restarting only the backend invalidates its process-local pairing key but does not stop a managed Host: generate another key and run `pnpm agent-remote-controller pair` with the new `AGENT_HOST_SERVER` and `AGENT_HOST_REMOTE_KEY`. The Host replaces its uplink without recreating native sessions. Submitted commands and unknown creation outcomes are never automatically replayed.

The managed daemon appends startup, runtime, and native Codex diagnostics to `~/.agent-remote-control/agent-host/agent-host.log`, or `agent-host.log` under `AGENT_HOST_STATE_DIR` when that override is set. The active file and three numbered archives are owner-readable and retain at most 5 MiB each after successful cleanup. Owned diagnostic lines are redacted before their 64 KiB limit is applied, so one line can exceed the active threshold by at most 64 KiB until the next owned write or one-second polling pass. Cleanup preserves the active inode; direct inherited output has no finite instantaneous overshoot bound and is reduced on the next pass, which archives its latest 5 MiB and discards earlier excess. Inherited bytes appended after the retained tail is captured and before the active inode is truncated can also be lost even when archive creation succeeds.

## Inspect and troubleshoot

Use the public Agent ID shown in the workbench header:

```bash
pnpm bdb inspect AGENT_ID --json
pnpm bdb timeline AGENT_ID --tail 20 --json
pnpm bdb protocol trace AGENT_ID --jsonl --until idle --timeout 15000
```

For non-default ports, add `--relay http://127.0.0.1:6013 --origin http://127.0.0.1:6284`.

- An old PATH executable: set `AGENT_REMOTE_CODEX_EXECUTABLE` to the isolated installation above. The live launcher accepts 0.148.0 or newer; only the recorded compatibility target is guaranteed by the pinned tests.
- A missing working directory: historical sessions can reference removed worktrees. The launcher reports the missing directory explicitly. Restore that workspace or choose an existing directory for the new session; the Provider does not silently change projects. A raw `spawn ... codex ENOENT` can also mean the requested working directory is absent even when the executable exists.
- Authentication or model errors: use the same native Codex home to configure/login, then retry deliberately. The workbench retains the native failure.
- Process exit: the Provider fails the observation stream and includes a bounded stderr tail in diagnostics. Other local Codex processes remain running.
- Native image-view and generated-image resources are supported; general filesystem reads and remote image URL fetching are unavailable. Native logs stay native; public Trace shows normalized events and `bdb protocol trace` shows public Remote frames.

The implementation follows the process and history approach used by Paseo's `codex-app-server-agent.ts` and `codex/app-server-transport.ts`. Runtime code has no dependency on a Paseo checkout.

## Run regression tests

Select the pinned native executable explicitly so tests do not use an older system installation:

```bash
BORGEE_CODEX_TEST_EXECUTABLE="$PWD/.runtime/codex/node_modules/.bin/codex" pnpm test
BORGEE_CODEX_TEST_EXECUTABLE="$PWD/.runtime/codex/node_modules/.bin/codex" \
AGENT_REMOTE_TEST_RELAY_PORT=6014 AGENT_REMOTE_TEST_WEB_PORT=6285 \
pnpm test:e2e e2e/codex.spec.ts --timeout=180000
```

The browser regression runs the real app-server against a local model-response fixture and covers questions, consecutive turns, and paginated history on desktop and mobile. It does not require a model API key. Use a live conversation and `bdb` to verify the configured model gateway separately.

## Tool output

Expand a completed command row to inspect its combined output, exit code, and duration. Failed commands retain their output too. `pnpm bdb timeline AGENT_ID --all --json` exposes the same `item.result`. Results appear when the native tool item completes; incremental command output is not currently streamed. Long output is a bounded preview with an explicit truncation notice.

New sessions use Codex paginated history to preserve tool output across process restarts. Imported legacy sessions may lack historical command records in `thread/read`; create a new session when validating durable tool results.

## Forms, approvals, and images

Use a Host, Relay, debugger, and workbench built from protocol `1.5.0`. MCP requests can display flat typed forms, explicit browser actions, and exact filesystem/network approvals. Tool approvals expose only decisions advertised by Codex. Unsupported form schemas are declined with a visible diagnostic. Sensitive text is hidden in completed history and public traces, but still reaches the requesting native service when submitted.

Native completed images appear through the normal resource renderer. File-backed images require the referenced native file to exist on first read. Parent subagent calls appear as tool summaries. Loaded native children also appear below the originating parent reply and open their own chat on the same runtime. Browser reload preserves pending interactions while the Host lives, but restarting it does not recover pending native RPCs or synthesized plan approvals. Do not use historical receipts as answers to new requests.

## Chat session controls

Build the Provider, Relay, debugger, and workbench from the same unshipped protocol `1.5.0` checkout. Type `/` to fetch the current Provider directory. Codex exposes `/model`, `/permissions`, and `/compact`, enabled skills for the current working directory, and custom prompts from its configured home. Opening the menu and executing an entry each refresh native availability, so removing or disabling a skill makes an old selection fail explicitly. The toolbar still provides current session facts and model/permission shortcuts.

`/model` opens a model question, then the selected model's available reasoning efforts. `/permissions` opens approval-policy or sandbox questions constrained by native requirements. Submit or dismiss these through the ordinary interaction cards. The initial command response may only indicate that a menu opened; continue until the remaining questions are resolved. Selection requires a connected idle session without competing interactions. Values change after native confirmation; rejection retains the current setting and permits retry. Model changes preserve Planning. `/compact` invokes native thread compaction.

Place a custom prompt such as `review.md` in `CODEX_HOME/prompts` to discover `/prompts:review`. The Provider environment override selects this home before process `CODEX_HOME` or the `~/.codex` default. Use optional `description` and `argument-hint` frontmatter and `$ARGUMENTS` in the body for raw arguments. Named, positional, escaped-dollar, and braced placeholders are explicitly unsupported; passing arguments to a prompt without `$ARGUMENTS` also fails. Files must be top-level regular Markdown files no larger than 256 KiB; symlinks are ignored and scans are bounded to 1,024 entries. Skills execute native skill input with their argument text. The directory does not claim terminal scraping or every Codex TUI command.

For command acceptance, exercise directory loading, a model-to-effort interaction, permission selection, and a skill or prompt on desktop and mobile; include browser reload, Working elapsed time, and native interrupt. The fixture model-response stream is deterministic, so actual gateway behavior still needs a live session. These are validation steps, not a claim that the new command flow has passed browser or live-runtime acceptance.

While Codex is Working, type a correction and press Enter. The input should be accepted into the active native turn, and elapsed time should continue. This adapter does not expose a next-turn queue button. An uncertain send failure must preserve the draft without automatically retrying it.


## Verify a native child chat

Use the real local Provider with the pinned Codex executable and a configured model endpoint. Ask the parent to create two native subagents with distinct tasks and wait for them. Check that the child rows appear before either child page is opened, remain in creation order as their statuses change, and navigate to distinct transcripts. Return to the parent and confirm its draft is retained. A child that forbids native direct input must show a disabled composer rather than silently creating a new session.

The existing debugger can inspect relationships and child activity without a new protocol: `pnpm bdb inspect <parent-agent-id> --relay <relay-url> --json` includes `agent.runtimeInfo.childSessions`. Once a child is attached in the console, use its Remote Agent ID with `inspect`, `timeline`, `observe`, `interaction list`, and `interaction respond`. These target the child's ordinary session wire. Do not use `session resume` as a substitute for attaching a still-running native child.

Repeat with a child awaiting a native question or approval before opening its chat; its parent row must indicate waiting, and the child must show the actual pending request. Closing or switching a browser view must not terminate the native task. Historical creation metadata and live control availability are distinct; native instances outside the held app-server are not assumed controllable.

If native text changes during its initial history read, the Provider retries the conflicting snapshot read a bounded number of times. Continued contention leaves the child listed and returns an explicit retry error when opening it. Retry opening that child; do not create or resume another native session. Model and permission values may initially be unavailable because native `thread/read` omits them; parent settings are not assumed to apply to the child.
