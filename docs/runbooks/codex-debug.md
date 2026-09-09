# Codex installation and debugging

The local Codex Provider manages a separate `codex app-server` process for each open session. DSH uses its installed Host plugin; Codex uses JSON-RPC over the CLI's stdin/stdout. Both feed the same Provider SDK, Relay, browser Timeline, and `bdb` debugger.

## Install and launch

Run from the Agent Remote Control repository root with Node 22 or newer. Install the verified CLI locally using the Tencent registry:

```bash
npm install --prefix .runtime/codex --registry=https://mirrors.cloud.tencent.com/npm/ --no-audit --no-fund @openai/codex@0.148.0
.runtime/codex/node_modules/.bin/codex --version
.runtime/codex/node_modules/.bin/codex login
AGENT_REMOTE_CODEX_EXECUTABLE="$PWD/.runtime/codex/node_modules/.bin/codex" pnpm dev
```

The login command is needed only if that native Codex profile is not already authenticated. Existing credentials and model/provider settings remain owned by Codex. The workbench does not copy them into its configuration or generate an API key.

When the model provider in `~/.codex/config.toml` uses `OPENAI_API_KEY`, pass it to the launcher environment. For the local gateway that accepts the placeholder key `test`, launch with:

```bash
OPENAI_API_KEY=test \
AGENT_REMOTE_CODEX_EXECUTABLE="$PWD/.runtime/codex/node_modules/.bin/codex" pnpm dev
```

The child process inherits this key and the native profile's configured base URL. This does not modify the profile or store credentials in the workbench.

Open `http://127.0.0.1:6175`, select **Codex**, choose the working directory, and click **Open session**. A fresh thread has an empty Timeline. Send a message to start its first turn. **Steer**, **Cancel turn**, questions, and tool approvals use the same process and native thread. Planning is available when the CLI reports both planning and normal collaboration modes.

To use a separate profile, create its directory and log in with the same home before launching:

```bash
mkdir -p .runtime/codex-home
CODEX_HOME="$PWD/.runtime/codex-home" .runtime/codex/node_modules/.bin/codex login
AGENT_REMOTE_CODEX_HOME="$PWD/.runtime/codex-home" \
AGENT_REMOTE_CODEX_EXECUTABLE="$PWD/.runtime/codex/node_modules/.bin/codex" \
AGENT_REMOTE_WORKSPACE=/absolute/path/to/workspace \
AGENT_REMOTE_PORT=6013 AGENT_REMOTE_WEB_PORT=6284 pnpm dev
```

## Discover and resume

**Discover sessions** lists up to 500 recent unarchived native threads, ordered by activity, from the selected Codex home. Discovery reads metadata via `thread/list`; subagent threads are excluded. Selecting a row explicitly resumes that original thread via `thread/resume` and reads its history via `thread/read`. Native files are not moved or deleted. New threads stay alive before their first turn because Codex may not persist an empty thread yet.

This is control of processes owned by the workbench. It does not attach stdio to an already-running terminal or Codex desktop process. Avoid simultaneously continuing the same native thread in another application. A browser reconnect reuses the Relay-owned session; closing the server stops its child processes. After a server restart, discover a persisted thread and open it again. Submitted commands are never automatically replayed after an uncertain failure.

## Inspect and troubleshoot

Use the public Agent ID shown in the workbench header:

```bash
pnpm bdb inspect AGENT_ID --json
pnpm bdb timeline AGENT_ID --tail 20 --json
pnpm bdb protocol trace AGENT_ID --jsonl --until idle --timeout 15000
```

For non-default ports, add `--relay http://127.0.0.1:6013 --origin http://127.0.0.1:6284`.

- An old PATH executable: set `AGENT_REMOTE_CODEX_EXECUTABLE` to the isolated installation above. The live launcher accepts 0.148.0 or newer; only the recorded compatibility target is guaranteed by the pinned tests.
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

Use a Host, Relay, debugger, and workbench built from protocol `1.3.0`. MCP requests can display flat typed forms, explicit browser actions, and exact filesystem/network approvals. Tool approvals expose only decisions advertised by Codex. Unsupported form schemas are declined with a visible diagnostic. Sensitive text is hidden in completed history and public traces, but still reaches the requesting native service when submitted.

Native completed images appear through the normal resource renderer. File-backed images require the referenced native file to exist on first read. Parent subagent calls appear as tool summaries; child-session navigation is not available. Browser reload preserves pending interactions while the Host lives, but restarting it does not recover pending native RPCs or synthesized plan approvals. Do not use historical receipts as answers to new requests.
