# Start the complete Remote Controller

Use Node 22 or newer and pnpm 10.34.5. From the repository root:

```bash
pnpm start --codex /absolute/path/to/codex --claude /absolute/path/to/claude \
  --dsh /absolute/path/to/dsh
```

When all three executables are on PATH, `pnpm start` is sufficient. If DSH is absent, its existing guided setup attempts to install the exact compatible release locally. For an existing DSH source checkout, replace `--dsh` with `--dsh-repo /absolute/path/to/deepseek-harness`. Add `--build-dsh` only when that checkout needs its official build; this changes its build outputs. The source checkout must be supplied explicitly and is not a hidden repository dependency.

Select providers explicitly to opt into GitHub Copilot through the official Copilot SDK:

```bash
pnpm start --providers copilot --copilot-home /absolute/path/to/copilot-profile
pnpm start --providers codex,claude,copilot,dsh
pnpm start --providers dsh --dsh /absolute/path/to/dsh
```

The default remains `codex,claude,dsh`. `--providers` (JSON `providers`) accepts a comma-separated list with no empty, unknown, or duplicate entries. Unselected providers do not require executables, native registration, or readiness checks. DSH is built/started and its port checked only when selected; DSH-only starts no native Agent Host.

Copilot requires GitHub Copilot CLI 1.0.83 or newer and defaults to the declared official `@github/copilot` package entry after installation/build. `--copilot` (JSON `copilot`, environment `AGENT_HOST_COPILOT`) overrides it; JavaScript entry files are run with Node for version preflight. `--copilot-home` (JSON `copilotHome`, environment `AGENT_HOST_COPILOT_HOME`) sets native `COPILOT_HOME` without changing the parent environment. Authenticate the selected native profile separately. Copilot uses the official SDK transport, not ACP.

The launcher installs missing repository dependencies, runs `pnpm build`, checks compatibility, and runs the compiled `packages/agent-host/dist/cli.js`. This builds the Host and its workspace dependencies for execution from this checkout; it does not create a standalone distributable or publish a package. Web serves its freshly built assets through Vite preview. The local Broker uses the existing Lab server.

By default, Codex and Claude run in one Host with `AGENT_HOST_PROVIDERS=codex,claude`. DSH runs separately with its native Web profile and the freshly built and installed DSH Host bundle. Both Hosts pair automatically with the same Broker using separate temporary keys. Selected Codex, Claude, and Copilot providers share the native Host. There is no generic `dsh` provider registration in that Host.

The launcher prints `Remote Controller: http://127.0.0.1:6175` after selected Host registration, optional DSH Web readiness, and each provider's workspace and catalog APIs respond through the Web proxy. Readiness does not send a model prompt or prove model credentials. Codex and Claude retain their native authentication; a fresh DSH home needs model configuration through the authenticated DSH Web startup link printed during setup.

## Reusable configuration

Copy [controller-start.example.json](controller-start.example.json) to an ignored local file, then edit the executable paths or select `dshRepo` instead of `dsh`:

```bash
mkdir -p .runtime
cp docs/runbooks/controller-start.example.json .runtime/controller.json
pnpm start --config .runtime/controller.json
```

Paths in the JSON file are relative to that file. Paths supplied as CLI arguments are relative to the shell's current directory. Bare executable names are resolved through PATH. CLI options override JSON settings; JSON settings override supported native environment defaults. Unknown fields are rejected. Do not add credentials or pairing keys to this file.

Use `codexHome`, `claudeHome`, `copilotHome`, or `dshHome` to explicitly select native profiles. `AGENT_HOST_CODEX`, `AGENT_HOST_CLAUDE`, `AGENT_REMOTE_CODEX_EXECUTABLE`, `AGENT_REMOTE_CODEX_HOME`, and `AGENT_HOST_CLAUDE_HOME` are supported defaults. Existing native `CODEX_HOME` and `CLAUDE_CONFIG_DIR` remain inherited. The launcher owns its Host state under `stateDir/agent-host`; it does not manage a separate daemon selected by `AGENT_HOST_STATE_DIR`.

## Ports and lifecycle

The default ports are Web `6175`, Broker `5910`, and DSH Web `3081`. Selected ports must be distinct and unused. All listeners bind to loopback. For a second independent environment:

```bash
pnpm start --config .runtime/controller.json \
  --state-dir .runtime/controller-second \
  --web-port 6181 --relay-port 5916 --dsh-port 3086
```

Keep the terminal open. Ctrl+C closes only the launcher's own DSH runtime, native Host sessions, Web, and Broker. A failed build or service exit also cleans up owned processes and exits with an error. Existing services are never killed, adopted, or reused. Do not select a DSH home that another DSH process is already using.

The default state directory is `.runtime/controller`. Homes, native session history, and private startup logs persist. `ready.json` exists only while the environment is ready and includes the controller URL and Host IDs without credentials. The `run.lock/owner.json` file prevents concurrent launchers from using the same state directory. After an ungraceful kill, inspect its PID and any remaining services before manually removing a stale lock; the launcher never guesses that a lock is safe to delete.

Every restart rebuilds the current checkout. To update a running environment, finish active work, press Ctrl+C, and rerun the command. Broker keys are process-local and regenerated. Native history persists, but pending permission callbacks and active turns are not restored by a restart.

Run `pnpm start --help` for all options and `pnpm test:setup` for bounded launcher tests.
