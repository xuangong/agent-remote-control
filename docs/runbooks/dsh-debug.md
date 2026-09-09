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

Tool results use public protocol `1.2.0`. After updating the repository, rerun the guided setup to rebuild and reinstall the DSH Host bundle, and use a Relay and workbench from the same version. Existing processes keep their loaded version until restarted. Expand a tool row in the workbench, or inspect `item.result` with `pnpm bdb timeline AGENT_ID --all --json`, to view the native result body. DSH output is retained as emitted; exit codes embedded in text are not inferred as structured metadata.
