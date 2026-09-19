# Guided DSH debugging

Run `node scripts/dsh-debug.mjs` from the Agent Remote Control checkout. Node.js 22 or newer and npm are required. The script installs its own pinned pnpm under `.runtime/dsh-debug/tools`; a global pnpm or DSH installation is optional. `pnpm debug:dsh` is an equivalent shortcut when pnpm is already available.

## First run

The wizard asks for a DSH source directory when no installed `dsh` is available, then a DSH home, workspace, and Web port. It displays the selected paths and asks before setup. A source checkout needs version `0.1.2-rc.1`; the pinned native contract is commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`.

```bash
node scripts/dsh-debug.mjs \
  --dsh-repo /absolute/path/to/deepseek-harness \
  --workspace /absolute/path/to/your/project
```

If that checkout has not been fully built, select the build option in the wizard or add `--build-dsh`. This installs missing source dependencies with the checkout's declared pnpm version and runs `build:official` in that checkout. An existing dependency installation is reused. It can take several minutes and changes its build outputs. Avoid rebuilding a checkout that serves another running DSH environment.

```bash
node scripts/dsh-debug.mjs --yes \
  --dsh-repo /absolute/path/to/deepseek-harness \
  --build-dsh \
  --workspace /absolute/path/to/your/project
```

For an installed compatible CLI, use `--dsh /absolute/path/to/dsh`. If neither a CLI nor a source directory is supplied, setup attempts the exact npm release with the existing release-graph preparation tool. A registry that lacks that release cannot supply this mode; setup stops with instructions to select an installed CLI or source checkout. It never substitutes another DSH version.

## What setup does

1. Checks the workspace and DSH Web port, then selects the compatible runtime and package manager.
2. Installs missing workbench dependencies and builds missing Relay artifacts.
3. Reuses the configured workbench and Relay, or starts them on free local ports.
4. Builds the Host archive and installs it with `dsh plugin --profile web add file:<archive>` into the selected home.
5. Requests a temporary pairing key and passes it to the DSH process through its environment.
6. Waits for registration, checks the Host workspace API and DSH Web, then prints the workbench address and Provider label.

The default registry is `https://mirrors.cloud.tencent.com/npm/`. Override it with `--registry URL`. Registry settings apply to child processes; setup does not rewrite global npm configuration.

## Use the environment

Open the printed workbench address, select `DSH · DSH Debug · Online` under **Session intake → Provider**, choose a workspace, then click **Open session**. The default isolated home has its own session history and model settings. Use the authenticated `dsh web:` URL printed by DSH to configure model credentials when needed; a bare Web URL may require authentication.

Setup does not submit a model request. Once credentials are configured, send a short message from the workbench and inspect the resulting conversation, Trace, and Replica Inspector.

Keep the terminal open. Ctrl+C stops DSH and any workbench processes started by this script. A workbench that was already running remains running. DSH home files, session history, and logs remain available for the next run. Rerun the same command without `--build-dsh` after a successful source build. The Host archive is rebuilt and reinstalled each time so adapter changes reach the next process.

## Paths and ports

| Option | Default | Purpose |
| --- | --- | --- |
| `--state-dir` | `.runtime/dsh-debug` | Local tool downloads, logs, and last-run summary |
| `--home` | `<state-dir>/home` | Persistent isolated DSH home using the `web` profile |
| `--workspace` | Invoking directory | Native workspace for new sessions |
| `--server-url` | `http://127.0.0.1:5910` | Relay and pairing API |
| `--console-url` | `http://127.0.0.1:6175` | Workbench UI |
| `--dsh-port` | `3081` | DSH Web |
| `--name` | `DSH Debug` | Registered Host display name |

For a fully separate test environment:

```bash
node scripts/dsh-debug.mjs --yes \
  --dsh-repo /absolute/path/to/deepseek-harness \
  --server-url http://127.0.0.1:6012 \
  --console-url http://127.0.0.1:6283 \
  --dsh-port 3182 \
  --state-dir /absolute/path/to/separate-debug-state
```

Logs are owner-readable and contain child startup diagnostics. Pairing keys are redacted and are absent from `last-run.json`. DSH may print an authenticated Web startup URL, so treat the log as private. Restarting a Relay discards its in-memory keys; rerunning setup requests a fresh one.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Pinned release cannot be installed | Supply a compatible `--dsh` or `--dsh-repo`; do not switch to an arbitrary release. |
| Missing `lib/client.js`, frontend assets, or Typert modules | Rebuild the selected source with `--build-dsh`. A partial host build is insufficient for DSH Web. |
| Port occupied | Choose another DSH port or another pair of Relay/workbench origins. Existing listeners are never killed. |
| DSH Host never becomes online | Inspect the printed log path for plugin loading or uplink errors. Verify that the Relay origin is reachable from DSH. |
| Host online but model requests fail | Configure credentials and model selection inside DSH using its authenticated startup URL. |
| No previous sessions in the directory | The default home is isolated. Use `--home` to deliberately choose an existing DSH home, with no other DSH process using it. |

Run `pnpm test:setup` for bounded helper and CLI workflow tests. The CLI workflow test uses a simulated native runtime with real subprocesses and HTTP boundaries; it does not prove a native DSH build or model execution.

## Tool output protocol compatibility

The current checkout uses unshipped public protocol `1.5.0`, including tool results and Provider commands. After updating the repository, rerun the guided setup to rebuild and reinstall the DSH Host bundle, and use a Relay and workbench from the same version. Existing processes keep their loaded version until restarted. Expand a tool row in the workbench, or inspect `item.result` with `pnpm bdb timeline AGENT_ID --all --json`, to view the native result body. DSH output is retained as emitted; exit codes embedded in text are not inferred as structured metadata.

## Chat session controls

Rebuild the Host, Relay, and console from the same unshipped protocol `1.5.0` checkout, then type `/` to read the selected agent's current native command registry. The directory is fetched on demand and execution revalidates the selected entry; names, descriptions, argument hints, availability, and results come from installed DSH services. Registered commands execute through DSH's command service without submitting a synthetic model prompt. Missing services or removed commands remain explicit unavailable states.

A registered native `/model` command takes precedence. If it is absent and the native session controller supports selection, the adapter offers a model question. This native selection applies to the current session and saves the default for future sessions; the menu states that scope. Registered `/permission` without arguments can open the installed permission-preset question; selecting a preset invokes that same native command. Use the names actually returned by the directory, and follow any subsequent ordinary question/form cards until they finish. An initial command result is not confirmation that a multi-step menu is complete. The toolbar keeps current session facts and setting shortcuts available independently.

Validate a refreshed directory, one native registered command and its result text, model selection, permission selection, and cancellation of a pending command with the intended DSH installation. The setup tests and simulated runtime do not establish acceptance of these command flows against a real native DSH process.

While DSH is running, ordinary Send supplements the current work through native steering. Use **Queue for next turn** for a separate follow-up; DSH owns the Inbox and when it consumes that message. The action appears only while busy and with native queue capability. A native command currently executing keeps message submission unavailable.

## Repeatable native delivery verification

The delivery browser suite launches the pinned DSH source CLI in its headless profile with a temporary home and workspace. The real Agent Loop, Inbox, read tool, adapter, Relay, and browser run normally. A test LLM adapter supplies controlled responses without external credentials; it does not implement message dispatch or queuing. No Codex executable is required for this suite.

After `pnpm build`, choose two unused ports and run:

```bash
DSH_REPO=/absolute/path/to/deepseek-harness \
AGENT_REMOTE_DSH_DELIVERY_FIXTURE=1 \
AGENT_REMOTE_DSH_DELIVERY_EVIDENCE="$(mktemp -t dsh-delivery)" \
AGENT_REMOTE_TEST_RELAY_PORT=6351 \
AGENT_REMOTE_TEST_WEB_PORT=6352 \
pnpm test:e2e dsh-delivery.spec.ts
```

Set `AGENT_REMOTE_TEST_BROWSER` to an installed Chromium executable when Playwright browsers are unavailable. On macOS, Google Chrome is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

Desktop and mobile tests verify idle sending, busy immediate delivery at a step boundary within the same native turn, explicit delivery in the next native turn, a real read-tool result, elapsed time restored after reload, native interruption, and preservation of an unsent draft. Assertions inspect native Inbox insertion targets, consumed user-message source and turn boundaries, and the messages actually received by the LLM adapter. Screenshots and native JSON evidence are attached to Playwright results. The launcher cleans up only its own processes, temporary home, workspace, and plugin build; the evidence file remains available.

This suite exercises the standalone native plugin composition. Installing and pairing the Web Host, selecting models through the native Web controller, and calling a real model endpoint remain separate guided-setup acceptance paths.
