# Agent Remote Lab

`@agent-remote-controller/agent-remote-lab` is a local chat and protocol debugging console. Run its DSH plugin inside DSH Web to use the same native session from both interfaces, then open the Lab to inspect the public protocol and client Replica. The console uses shared React components from `@agent-remote-controller/agent-remote-web`; it is not a Borgee product service or a complete Provider control plane.

For temporary-key pairing, native Host discovery, and real session control, use the [Agent Remote Control guide](../../README.md). The fixture plugin and launch commands below provide additional protocol validation modes.

## Prerequisites

The compatible toolchain is Node `22.23.2` and pnpm `10.34.5`. Use an Agent Remote Control worktree with dependencies installed. Joint debugging supports either an installed DSH release or a DSH source checkout. Both must match `0.1.2-rc.1`; the compatibility manifest pins its native contract to commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`. Other DSH versions are outside this contract. Run the shell snippets in Bash.

```bash
export LAB_ROOT="$(git rev-parse --show-toplevel)"
export LAB_NODE="$(command -v node)"
export LAB_PNPM="$(command -v pnpm)"
test "$("$LAB_NODE" --version)" = 'v22.23.2'
test "$("$LAB_PNPM" --version)" = '10.34.5'
"$LAB_NODE" --version
"$LAB_PNPM" --version
cd "$LAB_ROOT"
"$LAB_PNPM" install --frozen-lockfile --ignore-scripts
```

The manual joint setup uses separate ports from automated tests. Keep all listeners on `127.0.0.1` and use that hostname consistently in the browser; the Relay checks the exact Lab origin.

| Surface | Default URL | Purpose |
|---|---|---|
| DSH Web | `http://127.0.0.1:3081/` | Native chat, provider credentials, and model selection. |
| Agent Remote Relay | `http://127.0.0.1:4919/` | Public protocol and session control, owned by the DSH plugin. |
| Lab | `http://127.0.0.1:5181/` | Chat, Timeline, Trace, and Replica Inspector. |

## Build the debugging plugin

Both host modes use the same local Borgee plugin and isolated runtime directory. Run the following from this repository after installing its dependencies:

```bash
cd "$LAB_ROOT"
umask 077
mkdir -p "$LAB_ROOT/docs/_drafts"
export LAB_RUNTIME="$(mktemp -d "$LAB_ROOT/docs/_drafts/agent-remote-lab.XXXXXX")"
export DSH_HOME="$LAB_RUNTIME/home"
export BORGEE_LIVE_DSH_WORKSPACE="$LAB_RUNTIME/workspace"
mkdir -p "$DSH_HOME" "$BORGEE_LIVE_DSH_WORKSPACE"
printf '%s\n' "$LAB_RUNTIME"

"$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab... run build
"$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab run build:dsh-plugin
export LAB_DSH_PLUGIN="$LAB_ROOT/packages/agent-remote-lab/dist/dsh-plugin/agent-remote-controller-agent-remote-lab-dsh-0.1.0.tgz"
test -f "$LAB_DSH_PLUGIN"
```

The package is `@agent-remote-controller/agent-remote-lab-dsh`. Its declared DSH bundle inserts the Agent Remote plugin into the Web profile, injects `sessionController`, `agentPresets`, `userQuestions`, and `approval`, and selects `runtimeMode: shared-web`. Installing it with `dsh plugin` activates that bundle; no hand-written patch or global configuration change is needed.

This debugging package bundles the standalone adapter and Relay while using the DSH installation's native services. It carries its own compatibility manifest and registers the real DSH Provider only. It does not require a Codex executable. The independent outbound Host bundle uses `@agent-remote-controller/dsh-host` and connects to the workbench broker.

Keep the printed runtime path. Reuse its `home` and `workspace` on subsequent launches; creating a new runtime directory gives you a fresh isolated DSH configuration and session store. Runtime files are local and gitignored.

## Choose the DSH host

Choose one of the following modes, then continue with the common plugin installation and launch commands.

### Installed release

This mode targets the exact `@deepseek-ai/dsh@0.1.2-rc.1` npm package and matching native dependencies, with no DSH source checkout or DSH build. It requires registry metadata and tarballs for that exact native graph. If the configured registry cannot resolve them, use the verified source revision below and record the result as a source build; a source build does not verify the npm installation path.

Use an isolated installation to pin the CLI and its native dependency graph together. Checking only `dsh --version` is insufficient when transitive dependencies have resolved to newer versions. The preparation command reads published package metadata and writes exact native-version overrides; it does not change a global DSH installation.

```bash
"$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab run prepare:dsh-release "$LAB_RUNTIME/dsh-release"
npm --prefix "$LAB_RUNTIME/dsh-release" install
LAB_DSH_COMMAND=("$LAB_NODE" "$LAB_RUNTIME/dsh-release/node_modules/@deepseek-ai/dsh/lib/bin.js")
test "$("${LAB_DSH_COMMAND[@]}" --version)" = '0.1.2-rc.1'
```

Keep the generated `package-lock.json` with this local runtime; use `npm ci --prefix "$LAB_RUNTIME/dsh-release"` to reproduce the installation. If an existing DSH installation already has the matching native dependency versions, use its absolute executable as `LAB_DSH_COMMAND=("/absolute/path/to/dsh")` instead.

### Source checkout

Use a separate, clean checkout of the pinned DSH revision. The checkout needs its own dependencies and built host, client, and Web assets. Run its build using the package manager declared by that checkout (`pnpm 11.7.0`), independently of this repository's pinned pnpm version.

```bash
export DSH_REPO="/absolute/path/to/deepseek-harness-rc1"
test "$(git -C "$DSH_REPO" rev-parse HEAD)" = 'a66e4702047846cdaa10c66c9d3df3951f5ea70d'
git -C "$DSH_REPO" diff --quiet
git -C "$DSH_REPO" diff --cached --quiet
test "$("$LAB_NODE" -e 'console.log(require(process.argv[1]).version)' "$DSH_REPO/package.json")" = '0.1.2-rc.1'
(
  cd "$DSH_REPO"
  npm exec --yes --package=pnpm@11.7.0 -- pnpm install --frozen-lockfile
  npm exec --yes --package=pnpm@11.7.0 -- pnpm run build:official
)

export TSX_TSCONFIG_PATH="$DSH_REPO/tsconfig.json"
LAB_DSH_TSX_IMPORT="$("$LAB_NODE" --input-type=module -e 'import { createRequire } from "node:module"; console.log(createRequire(process.argv[1]).resolve("tsx/esm"));' "$DSH_REPO/package.json")"
LAB_DSH_COMMAND=("$LAB_NODE" --import "$LAB_DSH_TSX_IMPORT" "$DSH_REPO/apps/cli/src/bin.ts")
test "$("${LAB_DSH_COMMAND[@]}" --version)" = '0.1.2-rc.1'
```

The source command launches the same CLI entry as the checkout's `pnpm dsh` script while preserving the selected working directory. Both modes use the Web profile, install the same debugging bundle, and expose the same shared session behavior.

## Install the plugin and start DSH Web

In the same terminal, install the built package into the isolated Web profile:

```bash
npm exec --yes --package=pnpm@11.7.0 -- "${LAB_DSH_COMMAND[@]}" plugin --profile web add "file:$LAB_DSH_PLUGIN"
```

Then start DSH Web and its Relay plugin:

```bash
export BORGEE_LIVE_DSH_RELAY_PORT=4919
export BORGEE_LIVE_DSH_WEB_PORT=5181
export DSH_TOOLS_MODE=native
unset BORGEE_LIVE_DSH_PLAN_MODE
cd "$BORGEE_LIVE_DSH_WORKSPACE"
"${LAB_DSH_COMMAND[@]}" --profile web --host 127.0.0.1 --port 3081
```

Wait for DSH Web to open and for `Live DSH Agent Remote relay listening on http://127.0.0.1:4919` in the terminal. For a saved native log, append `> "$LAB_RUNTIME/dsh.log" 2>&1` to the launch command and inspect that file from another terminal. DSH owns the plugin lifecycle, so these are one process tree.

## Start the Lab

Open a second terminal in the same repository worktree:

```bash
export LAB_ROOT="$(git rev-parse --show-toplevel)"
cd "$LAB_ROOT/packages/agent-remote-lab"
unset VITE_AGENT_REMOTE_FIXTURE_ENDPOINT
export VITE_AGENT_REMOTE_RELAY_TARGET=http://127.0.0.1:4919
pnpm exec vite --host 127.0.0.1 --port 5181 --strictPort
```

Open `http://127.0.0.1:5181/` for the Lab and `http://127.0.0.1:3081/` for DSH Web. The Lab proxies `/v1` HTTP and WebSocket traffic to the Relay. It does not start DSH itself. If you choose different ports, keep `BORGEE_LIVE_DSH_WEB_PORT` equal to Vite's port and keep the Vite proxy target equal to `BORGEE_LIVE_DSH_RELAY_PORT`.

## Configure the model and share a session

1. Open DSH Web at `http://127.0.0.1:3081/`. Complete onboarding, then open **Settings → Models**. Configure an existing provider or use **Add provider → Add a custom provider** with your endpoint, supported protocol, model list, and API key. Use a provider that serves `gpt-5.6-luna` for inexpensive interactive validation; the Lab does not supply credentials or model access.
2. Open the Lab at `http://127.0.0.1:5181/`. Under **Session intake**, select **DeepSeek Harness**, choose **Normal chat**, and click **Open session**. Do not choose a Recorded or Codex fixture when checking real model replies.
3. Find that session in DSH Web's session list, normally under **Ungrouped**. The Lab's **Replica Inspector → Provider session** shows its native session ID. The Lab URL uses `?agent=<agent-id>`; DSH Web does not use that URL format.
4. Before sending the first message, select `gpt-5.6-luna` from the model picker in that DSH Web session. Select the reasoning effort there if the provider exposes it. Send a short message from either interface, then confirm that the user message and generated Assistant reply appear in both.
5. Inspect **Replica Inspector → Model** after the next request starts to confirm the effective model. Selecting a model changes native Web state immediately, but the public Snapshot receives the model identifier with the next native request header.

Model credentials and Web defaults belong to the isolated `DSH_HOME` used to launch this host. An existing global DSH login is not automatically copied into it. The Lab has no separate model picker in shared Web mode, and explicit model or reasoning overrides in a Lab creation request are rejected.

Create the shared session from the Lab: the console does not import arbitrary sessions created independently in DSH Web. Both clients observe pending questions and approvals, and either can answer. Avoid submitting the same answer from both interfaces.

## Debugging workflow

| View | What to inspect |
|---|---|
| Conversation | Real messages, rendered Markdown, compact tool activity, questions, approvals, and planning feedback. Expand a tool or completed question to read its details. |
| Trace | Normalized Timeline items, epoch and sequence ranges, merged entries, and resource references. |
| Replica Inspector | Snapshot, effective model, active turn, synchronization cursor, pending live entries and interactions, capabilities, and client diagnostics. |
| Resources | Session-generated resources and their loading or download state. |

Trace and Inspector expose public protocol data and client Replica state. They do not capture Provider-native events, raw WebSocket frames, or process stdout/stderr. Inspect the DSH process log for native launch and authentication failures, and the Lab terminal or browser developer console for frontend failures.

For an interactive smoke check, send a message in each UI, request a read of a known file in the configured workspace, and confirm that both clients see the result. Enable **Planning** on an idle session to exercise plan review; answer a question or approve a plan from one interface and check its resolved state in the other. Tool availability and approval prompts depend on the selected native agent preset and permissions.

The Lab initially loads a small history page. Use **Load earlier activity** to inspect older messages, waiting for each page to finish loading. Scrolling upward preserves your reading position; **Back to latest** resumes following the conversation.

## Restarting and troubleshooting

Keep DSH Web and the Lab running in separate terminals. `Ctrl+C` stops the foreground process in that terminal; stopping DSH also stops its Relay plugin. For persistent local sessions, run each launch command in its own `tmux` session, detach with `Ctrl+B`, then `D`, and stop it later by reattaching and pressing `Ctrl+C`.

Frontend component and CSS edits are served by Vite. If a change touches the compiled DSH adapter, Relay, or Lab plugin, stop the DSH host, rebuild and reinstall the plugin tarball, then launch DSH again using the same runtime directory. Keep its home, workspace, and session files to preserve native history. Browser reload preserves typed Question/Approval history while the host survives; cold host restart does not reconstruct those rich interaction records from native session logs.

| Symptom | Check |
|---|---|
| `Recorded reply` instead of generated text | Select **DeepSeek Harness** and confirm the Lab points to the joint Relay, not the Recorded test server. |
| No providers, connection retries, or a rejected WebSocket | Check the DSH plugin startup log, Relay port, Vite proxy target, and exact Lab origin. `localhost` and `127.0.0.1` are different origins. |
| DSH Web opens but the Lab cannot connect | DSH Web can run without the Relay plugin. Confirm the log contains `Live DSH Agent Remote relay listening` and inspect plugin startup errors. |
| No model reply or an authentication error | Configure **Settings → Models** in this DSH host, select the model in the shared session, and read the DSH process log. |
| `Shared DSH Web mode requires...` | Load the plugin in the `web` profile with `sessionController`, `agentPresets`, `userQuestions`, and `approval` injected. The headless profile does not provide them. |
| Compatibility implementation digest mismatch | The manifest and scoped Borgee source bytes differ. Use the matching checkout and manifest; do not bypass this check or substitute another DSH release. |
| Port already in use | Stop the process you own or choose free ports. Update the Relay port, allowed Lab origin port, Vite proxy target, and browser URL together. |
| Planning is disabled | Wait for the active turn and pending interactions to finish; the Provider must also advertise native planning support. |

## Automated verification

Use the bounded commands in the [root verification guide](../../README.md#development-and-verification). Browser tests use Relay `5910` and Vite `6175` by default; override their ports for concurrent runs. The standalone live DSH fixture also reserves its configured control and bridge ports. Keep these ports free. The Playwright launcher owns these processes and removes its temporary workspace and plugin output on exit.

### Recorded verification

The Recorded Provider is deterministic. It proves the public Snapshot/Timeline path, typed interactions, Timeline replacement, resource state, reader shutdown, full reload, and byte-identical resource download without requiring a native Provider process.

```bash
cd "$LAB_ROOT"
env -u DSH_REPO -u BORGEE_CODEX_TEST_EXECUTABLE /usr/bin/perl -e 'alarm 240; exec @ARGV' "$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab exec playwright test e2e/recorded.spec.ts --project=chromium-desktop --project=chromium-mobile --timeout=120000
```

### Node and Go Relay conformance

After the workspace dependency installation and Agent Remote package builds, run this from the repository root with the configured Go toolchain available:

```bash
pnpm --filter @agent-remote-controller/agent-remote-lab run test:conformance
```

The launcher creates an isolated Go product host and one recorded runtime. Production Web clients compare the direct Node HTTP/WebSocket route with the same runtime reached through the outbound plugin uplink and authenticated Go routes. The scenarios cover creation, Snapshot and Timeline paging, message/control acknowledgements, Question and plan responses, resource bytes and replacement, browser recovery, and uplink recovery with concurrent browser streams and no command replay.

The check uses random ports, a private temporary credential manifest, and a temporary test store; it requires no running DSH or Lab service. The launcher enforces a 240-second deadline, Go uses `-timeout=180s`, and Vitest uses a 20-second test timeout. It closes the host and removes its temporary files. Ordinary package test commands skip this cross-process suite; this command supplies the manifest that enables it. Browser rendering and live model output require their separate verification flows.

Open the test-owned UI at `http://127.0.0.1:6175` only while the command runs. The expected browser-visible baseline is a ready connection, rendered Timeline, visible question/approval forms, resource status, and an empty console/page-error collection (`e2e/recorded.spec.ts:4-62`).

### Codex app-server verification

This path starts the real local Codex app-server inside an independent Agent Host process and points it at a deterministic local Responses fixture. The Lab backend remains a separate process and does not construct Codex. The checks prove the Provider boundary, native question/answer correlation, continuation, reload, single-copy replay, and Host re-pairing after a backend restart while preserving the native and Remote Agent identities. They do not prove authenticated model output or arbitrary tool execution.

```bash
cd "$LAB_ROOT"
export BORGEE_CODEX_TEST_EXECUTABLE="$(command -v codex)"
test -n "$BORGEE_CODEX_TEST_EXECUTABLE" && test "${BORGEE_CODEX_TEST_EXECUTABLE#/}" != "$BORGEE_CODEX_TEST_EXECUTABLE"
"$BORGEE_CODEX_TEST_EXECUTABLE" --version
env -u DSH_REPO /usr/bin/perl -e 'alarm 240; exec @ARGV' "$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab exec playwright test e2e/codex.spec.ts --project=chromium-desktop --project=chromium-mobile --timeout=180000
```

The executable check must print `codex-cli 0.148.0`; a suffix such as `nightly` is intentionally rejected by the Lab before the Provider is built (`src/server/codex.ts:30-49`). The visible flow selects `Codex (fixture)`, answers the rendered question, observes its continuation, reloads, and asserts one copy of the transcript (`e2e/codex.spec.ts:9-35`).

### Standalone DSH source-fixture verification

This optional automated path requires a separate clean DSH source checkout at `@deepseek-ai/dsh-agent 0.1.2-rc.1`, commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`. It is separate from the installed-release joint setup above. The launcher builds the actual DSH plugin, validates `compatibility.json` before its build and Cordis launch, and runs the real Cordis Provider through the public Relay and browser. Set `DSH_REPO` to the compatible detached worktree. The command also starts the Codex fixture because this live composition registers both adapters in one Relay.

```bash
cd "$LAB_ROOT"
export DSH_REPO="/absolute/path/to/deepseek-harness-rc1"
export BORGEE_LIVE_DSH_NODE="$LAB_NODE"
export BORGEE_LIVE_DSH_PNPM="$LAB_PNPM"
export BORGEE_LIVE_DSH_GIT="$(command -v git)"
export BORGEE_CODEX_TEST_EXECUTABLE="$(command -v codex)"
test -f "$DSH_REPO/package.json"
test "$("$LAB_NODE" -e 'console.log(require(process.argv[1]).version)' "$DSH_REPO/package.json")" = '0.1.2-rc.1'
test "$(git -C "$DSH_REPO" rev-parse HEAD)" = 'a66e4702047846cdaa10c66c9d3df3951f5ea70d'
"$BORGEE_CODEX_TEST_EXECUTABLE" --version
/usr/bin/perl -e 'alarm 600; exec @ARGV' "$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab exec playwright test e2e/live-dsh.spec.ts --project=chromium-desktop --project=chromium-mobile --timeout=360000
```

The live desktop scenario exercises visible plan approval, file read, todo projection, a session-owned generated write, tool approval, Provider resource-reader shutdown, reload, older history, and byte-identical download (`e2e/live-dsh.spec.ts:14-77`). The live patch composes the native `ask_user_question` tool, and the Provider maps its question service into public Question requests (`live-dsh.patch.yml`, `packages/agent-provider-dsh/src/runtime.ts`).

The session Planning control is available only when native support is discovered, and switching requires an idle session without pending interactions. DSH delegates planning to its native plan-mode service; Codex discovers a plan/default collaboration pair and sends the chosen mode on native turns. Approving a Codex plan starts one implementation turn; rejecting with feedback starts one revision turn in planning mode. Planning does not change sandbox or tool-approval policy.

## Advanced host composition

The installed debugging bundle already configures shared Web mode. For developers composing the compiled source-host plugin directly, `live-plugin.ts` accepts `runtimeMode: shared-web` when the host injects `sessionController`, `agentPresets`, `userQuestions`, and `approval`. The default mode is `standalone`; the ordinary source-fixture browser launcher keeps that mode. A custom source host adds this configuration to its own isolated Web composition:

```yaml
- insert:
    - id: borgee-agent-remote-live
      name: /absolute/path/to/compiled/live-plugin.js
      inject: [sessionController, agentPresets, userQuestions, approval]
      config:
        runtimeMode: shared-web
```

Create the DSH session in the Lab, then select that same native session in DSH Web. Both clients observe its messages and pending questions or approvals, and either client can answer. The Lab does not import arbitrary sessions created in DSH Web. Shared setup mounts the native default preset for a new session and restores its recorded preset on resume; it does not require a second global plan-mode service.

Choose the model and reasoning effort in DSH Web. Shared mode rejects explicit Lab creation overrides and installs the host's default model selection during native Agent setup, before mounting the preset. Web model selection also updates that isolated host's default selection according to native Web behavior. The Lab's `Snapshot.runtimeInfo.model` reflects the effective model after the next native request header, not immediately after selecting an option. Only the safe model identifier enters the public runtime update; native request configuration, headers, and system prompts remain private.

The shared interaction adapter observes the Web host's native interaction services and accepted responses. Its typed resolution history survives a Lab reload while this host remains alive. Model selection and preset composition complete in native Agent setup before the Relay receives a new or resumed session. Stopping the live plugin closes its Relay sessions before releasing the shared adapter (`src/server/live-plugin.ts`).

## Failure and recovery semantics

An attached WebSocket does not resolve or subscribe to its Agent until exact protocol negotiation succeeds. After negotiation, the Relay subscribes before reading the Snapshot baseline; manager events that race Snapshot delivery or Timeline-subscription acknowledgement are retained only in bounded handoff queues, and overflow removes the listener and closes the connection (`packages/agent-remote-relay/src/session-wire.ts:40-69`, `packages/agent-remote-relay/src/session-wire.ts:85-115`, `packages/agent-remote-relay/src/session-wire.ts:217-267`, `packages/agent-remote-relay/src/transport/websocket-stream.ts:105-139`).

Unexpected Codex app-server termination and DSH native sequence discontinuity fail the Provider observation iterator, allowing the Manager to publish failed runtime state instead of leaving the Agent idle. A failed Web Timeline catch-up records a recoverable diagnostic and reconnects through a generation guard; explicit client stop retires that generation before the queued restart can run (`packages/agent-provider-codex/src/session.ts:316-330`, `packages/agent-provider-dsh/src/live-session.ts:228-276`, `packages/agent-remote-relay/src/agent-manager.ts:250-312`, `packages/agent-remote-web/src/client/remote-session-client.ts:197-250`).

Resolved Question and Approval records remain available to browser reload while the Relay/Provider process survives. Native process restart does not reconstruct their typed request/response history from DSH or Codex session logs; this Lab does not provide a persistent interaction journal.

## Safety and capability boundary

The Relay and Vite listener bind to loopback. The Lab WebSocket authorizer accepts only loopback traffic with the exact Lab origin and grants only attach/read-resource actions (`src/server/local-authorizer.ts:7-22`). The DSH launcher validates absolute executable/checkout paths and creates plugin output plus session persistence below its own temporary directories (`scripts/run-live-dsh.sh:7-75`, `scripts/run-live-dsh.sh:127-205`). Do not use the Lab as a network service, credential discovery tool, or product authorization substitute.

The DSH resource reader authorizes only a successful write from the current session, and the Relay persists the acquired bytes in its injected validation store. It does not grant arbitrary workspace file, directory, absolute path, traversal, URL, or symlink access (`packages/agent-provider-dsh/src/generated-resource.ts:36-108`, `packages/agent-remote-relay/src/resources/resource-store.ts:24-94`). The in-memory store demonstrates post-reader-stop and reload behavior; it is not a product blob-store, retention, garbage-collection, or secrecy-policy implementation.

The compatibility manifest is authoritative for this Lab's explicit degradations. The protocol Snapshot does not yet carry recognized native session titles. Known injected plugin, skill-catalog, and workspace agent-instructions messages are consumed without entering the Timeline; unknown injected sources stay visibly diagnostic and never render as human-authored messages. DSH log-only request context, preset selection, step, inbox, and approval-audit records likewise do not become Timeline errors; request headers project only the effective model identifier into runtime state. Codex steer and cancel target the active native turn; generated-resource reading is unsupported. Codex thread-name metadata and command terminal-interaction activity are consumed without Timeline items because the public Snapshot and normalized tool detail cannot carry them (`compatibility.json:28-94`). General model/configuration control, attention, Provider subagents, Terminal, file transfer, voice, dictation, generic command ledger, and automatic multi-version downgrade are not delivered by this Lab.

For DSH generated-resource hydration, N historical writes currently cause O(N²) native-history scanning/reconstruction. This is a standalone validation limit, not a production-ready long-history design; treat unbounded histories as unsupported until an indexed or one-pass bounded-metadata implementation replaces it (`packages/agent-provider-dsh/src/generated-resource.ts:36-74`).

## Focused local checks

These commands validate the Lab documentation's launch assumptions without running a live model path.

```bash
cd "$LAB_ROOT"
/usr/bin/perl -e 'alarm 180; exec @ARGV' "$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab exec vitest run src/server/compatibility.test.ts src/server/live-launcher.test.ts --testTimeout=10000
/usr/bin/perl -e 'alarm 180; exec @ARGV' "$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab run typecheck
/usr/bin/perl -e 'alarm 180; exec @ARGV' "$LAB_PNPM" --filter @agent-remote-controller/agent-remote-lab run build
```
