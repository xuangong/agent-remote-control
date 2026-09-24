# Claude Code installation and debugging

Agent Host runs Claude Code through `@anthropic-ai/claude-agent-sdk` 0.3.247. Each opened session owns a persistent streaming-input Query. The Host retains that Query when the browser disconnects or the pairing uplink is replaced. Claude Code owns authentication, model configuration, project settings, native history, and tool execution.

## Install and launch

Use Node 22 or later. Complete the dependency install and `pnpm build` from the [root setup](../../README.md#run-locally). Select a Claude Code executable at version 2.1.247 or newer. The pinned compatibility target is 2.1.247; newer versions pass the startup check but are not covered by that pinned target.

For an isolated executable installation using the Tencent registry:

```bash
npm install --prefix .runtime/claude --registry=https://mirrors.cloud.tencent.com/npm/ --no-audit --no-fund @anthropic-ai/claude-code@2.1.247
.runtime/claude/node_modules/.bin/claude --version
pnpm dev
```

Configure authentication with the same Claude Code installation and native profile you intend to use. Normal operation honors native user, project, and local settings. The Host inherits the environment needed by that profile, including a custom model endpoint when configured. Do not put credentials in repository files.

Open **Pair Agent Host** in the workbench and generate a temporary key. Start the Host in another terminal:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-generated-key'
export AGENT_HOST_PROVIDERS=claude
export AGENT_HOST_CLAUDE="$PWD/.runtime/claude/node_modules/.bin/claude"
export AGENT_HOST_WORKSPACE=/absolute/path/to/workspace
pnpm agent-remote-controller start
```

Select **Claude Code · <Host name> · Online**, choose the workspace, and open a session. Creation initializes the native session without sending a model prompt. Send a message to begin the first turn.

To advertise Codex and Claude together, set `AGENT_HOST_PROVIDERS=codex,claude` and `AGENT_HOST_CODEX` to a supported Codex executable before starting the Host. An unset provider selection retains the Codex-only default. Empty entries, duplicates, and unknown provider names fail startup. Every selected executable is checked before the Host advertises its providers; an unavailable provider fails the startup rather than silently disappearing.

Use `AGENT_HOST_STATE_DIR` to keep a separate daemon alongside an existing Host. Choose free broker and workbench ports through `AGENT_REMOTE_PORT` and `AGENT_REMOTE_WEB_PORT` when existing listeners are present. Change the provider selection by stopping and restarting that specific Host daemon; `pair` only replaces its uplink.

## Native configuration roots

`AGENT_HOST_CLAUDE_HOME` selects the native Claude configuration root by passing `CLAUDE_CONFIG_DIR` to the Claude processes. If unset, the inherited `CLAUDE_CONFIG_DIR` or native default applies. This does not modify the parent process environment or another provider's configuration.

For a separate profile, create the directory and configure Claude using the same root before launching the Host:

```bash
mkdir -p .runtime/claude-home
CLAUDE_CONFIG_DIR="$PWD/.runtime/claude-home" .runtime/claude/node_modules/.bin/claude
AGENT_HOST_CLAUDE_HOME="$PWD/.runtime/claude-home" pnpm agent-remote-controller start
```

The other Host variables from the launch example must still be set. Native settings and authentication belong in that selected profile. Codex keeps its existing `AGENT_REMOTE_CODEX_HOME`, `AGENT_REMOTE_CODEX_EXECUTABLE`, and `AGENT_REMOTE_WORKSPACE` aliases.

## Discover, resume, and re-pair

The Claude catalog reads native session metadata through the official SDK in a separate process with the selected environment. Choosing an existing session resumes its native identity and projects its persisted history into the shared Timeline. New sessions remain available in the Host directory before their first turn has been persisted. The Host does not attach to a Claude terminal process that is already running.

A browser disconnect leaves the native Query alive. After a backend restart, generate a new temporary pairing key and replace the daemon uplink:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-new-key'
pnpm agent-remote-controller pair
```

Codex and Claude remain isolated even when their native session identifiers collide. Pairing does not recreate their native sessions or resubmit messages. `pnpm agent-remote-controller stop` closes the Host-owned sessions. `pnpm agent-remote-controller foreground` is useful for attached diagnostics, but does not expose daemon management commands.

## Supported controls and diagnosis

The adapter projects messages, streamed assistant text, reasoning, tool calls and results, usage, compaction, and turn outcomes through the existing public protocol. Tool permissions and `AskUserQuestion` appear as interaction cards. Approval offers once, and session scope when native suggestions can be preserved as session-only rules/directories. Native safety checks may still prompt again. Planning can be selected when creating a session and changed through native permission controls; leaving plan mode still requires native tool approval.

Type `/` to discover native skills using the same command menu as Codex. Select a skill, enter its arguments, and send. Discovery reloads the native skill catalog; execution rejects removed skills. Native compact is available when reported by the SDK. Idle model/permission settings are available through shared settings controls; native session-replacement commands are not advertised.

Direct native subagents appear beneath their parent reply and in **Sessions**. Open one to view its independent Timeline, then use **Sessions** to return to the parent. These views are read-only: tool approvals stay in the parent, and there are no independent child send/cancel controls. Closing a child view does not stop native work. Parent turn completion ends foreground observation; background tasks keep their native lifecycle. After resume, SDK-persisted children appear as saved history.

Bounded embedded image resources are readable. Mid-turn steering/queueing remain unsupported. Nested agent output is not shown as root assistant messages. Wait for the current turn or interrupt it before sending another message.

Inspect the public Agent ID from the workbench header:

```bash
pnpm ardb inspect AGENT_ID --json
pnpm ardb timeline AGENT_ID --tail 20 --json
pnpm ardb protocol trace AGENT_ID --jsonl --until idle --timeout 15000
```

For custom ports, pass the matching `--relay` and `--origin` flags. The daemon log is `agent-host.log` under `AGENT_HOST_STATE_DIR`, or `~/.agent-remote-control/agent-host` by default. The active log and three numbered archives retain at most 5 MiB each after successful cleanup. Owned lines are redacted before their 64 KiB limit, allowing at most one bounded line of overshoot until the next owned write or one-second pass. Inherited output has no finite instantaneous overshoot bound; cleanup retains only the latest 5 MiB from an oversized active file. Inherited bytes appended after the retained tail is captured and before the active inode is truncated can also be lost even when archive creation succeeds.

If startup rejects the executable, run its `--version` command and set `AGENT_HOST_CLAUDE` explicitly. If authentication, model access, or catalog discovery fails, inspect the selected native profile and environment. The workbench does not substitute credentials or silently switch profiles. A pending permission request belongs to the live Query; restarting the Host does not revive the original native permission callback.

## Run the native regression suites

The root tests enforce per-test and process deadlines. Build first, then select both pinned native executables:

```bash
pnpm build
BORGEE_CODEX_TEST_EXECUTABLE=/absolute/path/to/codex-0.148.0 \
AGENT_CLAUDE_TEST_EXECUTABLE=/absolute/path/to/claude-2.1.247 \
pnpm test
pnpm test:conformance
pnpm compatibility:check
```

On Node 22.23.2, add `NODE_OPTIONS=--no-experimental-webstorage` to the test process if Node's experimental global storage shadows jsdom storage. This is a test-environment setting, not a Host runtime requirement. Use the repository's pnpm 10.34.5; a newer globally installed pnpm can reject the existing package-manager lock entry.

The Claude native test uses an isolated configuration root and a local deterministic Messages endpoint. It verifies real process startup, streaming, tool approval/execution, persistence/resume, and interruption without contacting a live model service. The browser Host-provider test separately exercises both providers on desktop and mobile with deterministic runtime fixtures over real uplinks.

The `claude-discovery.spec.ts` browser suite exercises the real Claude adapter and Host with deterministic native Query fixtures, covering skill invocation, isolated child history, read-only controls, and returning to the parent on desktop/mobile. Native CLI acceptance is tested separately against the loopback Messages service.

## Managed terminal takeover and ARDB

Use the same selected profile and configured executable as the Controller:

```bash
agent-remote-controller claude resume NATIVE_SESSION_ID
# Explicitly interrupt the current managed owner and take over:
agent-remote-controller claude resume NATIVE_SESSION_ID --take-over
```

The wrapper forwards native arguments and supports `resume --last`, but only an explicit ID participates in ownership. Claude has no public external lock probe: a directly launched native terminal or a picker/continue-selected session cannot be protected by ARC's lease. Browser-to-browser takeover only transfers connection control. Browser/CLI takeover waits for actual old-process exit; uncertain release refuses the new writer.

Run an isolated live/debug/replay Session View with the existing ARDB server:

```bash
pnpm ardb server --provider claude --executable /absolute/path/to/claude \
  --cwd /absolute/path/to/workspace --open
```

The overlay offers recording/export and replay; CLI `observe`, `send`, `cancel`, `settings list/set` and `interaction list/respond` use its Relay URL and public Agent ID. See the [normalized inventory](../current/agent-remote/claude-normalized-events.md) for native limits.

For the focused native suite, build first and explicitly select the pinned executable. pnpm can resolve a different `claude` than the interactive shell:

```bash
AGENT_CLAUDE_TEST_EXECUTABLE=/absolute/path/to/claude-2.1.247 \
NODE_OPTIONS=--no-experimental-webstorage pnpm test:claude
```
