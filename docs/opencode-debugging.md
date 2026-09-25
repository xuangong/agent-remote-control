# OpenCode debugger scenario

`node scripts/opencode-debug-scenario.mjs` creates a real OpenCode 1.18.18 server, a real ARDB Live/Replay workspace, and an independent headless Remote client. The only simulated boundary is an OpenAI-compatible HTTP model endpoint. It returns deterministic text and tool requests; OpenCode performs the tools, permission prompts, questions, history persistence, and compaction itself.

The fixture uses a temporary Git project and isolated `HOME`/XDG directories. It does not need model credentials or an account. Native OpenCode connects only to the configured local model provider. Existing OpenCode servers and developer projects are not modified. All listeners use available loopback ports.

## Prepare

Build the current workspace, including the ARDB web assets, before running the scenario. Do not build while another test is reading generated `dist` files.

```sh
pnpm build
opencode --version # Expected: 1.18.18
node scripts/opencode-debug-scenario.mjs --executable /opt/homebrew/bin/opencode
```

The default executable is `AGENT_OPENCODE_TEST_EXECUTABLE`, falling back to `opencode` on `PATH`. The script checks the native version before creating the fixture. It imports the already built adapter and debugger; it does not build the workspace. It installs the pinned native plugin SDK into isolated temporary storage for OpenCode plugin initialization. Set `AGENT_OPENCODE_TEST_REGISTRY` to an accessible npm registry, or `AGENT_OPENCODE_TEST_PLUGIN_PREFIX` to a prepared isolated prefix containing that SDK; no global installation or personal npm configuration is changed.

## Inspect the actual Session View

```sh
node scripts/opencode-debug-scenario.mjs --executable /opt/homebrew/bin/opencode --keep
```

Open the loopback URL printed in `debugger_ready`. Enter the Live workspace and inspect the same session used by the independent headless client. The automated scenario produces:

- Streamed assistant text and native shell output (`ARC_SHELL_OK`).
- A native read followed by an edit from `"before"` to `"after"`, rendered as structured file changes.
- Native permission approvals and a native question, answered through the Remote client.
- Model variant and permission-setting changes.
- The `arc-debug` skill in the command catalog and native compaction.
- Dynamic Host source reads after the source history changes, using the actual native plugin and the existing Ask tool contract.
- Steer through the Remote channel during a held native model request, preserving context and producing one native echo.

After `scenario_complete`, type `ARC_DEBUG_QUESTION` in the Live composer to leave a real native question for manual browser interaction. Answering it produces `ARC_QUESTION_COMPLETE`. Ordinary text gets a deterministic assistant response. Do not repeat `ARC_DEBUG_SCENARIO` within the same session: its single edit expects the initial file contents.

The default keep duration is 30 minutes; `--hold-ms` changes it, up to 12 hours. `--keep` also retains a failed scene for diagnosis when startup reached ARDB. `Ctrl+C` stops only this script's services and removes its temporary project. The automated scenario itself has a 180-second deadline. Startup, HTTP operations, native tools, and client readiness have additional bounded waits.

## Recording and evidence

Each run writes a unique path under `.tmp/opencode-debug/`:

- `*.jsonl`: exported by the real ARDB `/__ardb/recording/start`, `/stop`, and `/export` API.
- `*.jsonl.evidence.json`: actual checks, native session identity, model requests, interactions, and parsed recording metrics.
- `*.jsonl.native.log`: bounded stdout/stderr from this run's native server.

Use `--output /absolute/path/session.jsonl` to select a recording path. Files are created exclusively; existing recordings are never overwritten. The recording is parsed using ARDB's real recording parser, including its baseline and closing-marker checks. The fixture does not construct synthetic JSONL events.

From the same ARDB workspace, select Replay and open the printed recording path. Its Session View is reconstructed by the normal replay player. The recording is stopped after the automated checks, so later manual browser actions are outside that recording; start another capture in the Live UI to record them.

All checks, including settings, skill catalog, dynamic callbacks, steer and compaction, must pass or the command exits unsuccessfully. The fixture also rejects unexpected Remote disconnects and any model-handler failure, even if a native retry later succeeds. Connection handshake/status evidence omits control tokens. Interaction automation waits for synchronization before answering a restored pending request. Missing capabilities are a regression for this pinned fixture; an older adapter build cannot silently pass. Read the evidence file before reporting a complete validation. A failed run writes diagnostics, exports the actual partial capture when available, and cleans up its services. The evidence marks it as a failure; the recording never implies that its checks passed.

## Automated browser and CLI round trip

After the scenario prints `scenario_complete`, use its URL and agent ID:

```sh
python3 -c 'import subprocess; subprocess.run(["node", "scripts/opencode-debug-browser.mjs", "--url", "http://127.0.0.1:PORT", "--agent-id", "AGENT_ID"], timeout=110, check=True)'
```

This uses the repository's Playwright dependency and installed Chromium. It only accepts loopback URLs, checks the OpenCode provider and fixture marker before sending input, and runs with a 90-second browser deadline plus bounded operations. Run it once on a fresh kept scenario. The scenario's previous capture must already have been exported: this test starts a new capture through the actual UI.

It fills the product composer, answers the resulting native question in the browser, and verifies that an independent headless observer sees both operations. It then runs the actual `ardb send` CLI and checks the message in the browser, exports JSONL through the UI, opens that server-side file in Replay, seeks to the end and verifies both outcomes. Desktop and 402px mobile screenshots plus machine-readable evidence are saved in a unique `.tmp/opencode-debug/browser-*` directory.

The browser check also guards against an unresolved compaction row remaining after completion and checks mobile horizontal overflow and uncaught page errors. It closes its own browser and observer; the native fixture and ARDB server stay available until the scenario's keep deadline.

## Findings from this workflow

The real native-to-Remote-to-View path caught an empty model-variant option rejected by the public protocol, even though the native settings operation succeeded. The fix uses a nonempty default option and a null unselected value, with public schema checks. Browser inspection then exposed duplicate loading/completed compaction rows; the fix aligns live and historical projection without changing the public schema. Both are covered by the repeatable acceptance path above.

These checks establish adapter/protocol/rendering behavior against the isolated deterministic model transport. They do not establish commercial model quality or remove the [native integration boundaries](opencode-native-boundaries.md).

## Reuse this pattern for another provider

Keep the same product Session View and Remote client. Replace only the native fixture, adapter configuration, and deterministic model conversation; do not add provider-specific UI to make a test pass.

1. Start the actual native runtime with isolated data and register it through ARDB.
2. Attach an independent observer before input. Record from the real capture endpoint.
3. Send through both the browser composer and the ARDB CLI. Assert the native echo, normalized events, interaction responses, and final idle state from the observer.
4. Export the capture, open it using the server file picker, and replay through the product renderer. Check terminal tool and compaction states as well as message text.
5. For each discovered failure, add a focused adapter or projector regression and rerun the same native/browser path.

This workflow separates native behavior, protocol delivery, and rendering evidence. A successful deterministic model run does not prove behavior absent from the native protocol. Keep explicit capability gaps and native boundary probes beside the scenario.

The final review also added transport regressions for input admission between HTTP acknowledgement and the native busy event, missed-busy completion recovery, unknown outcomes, and interaction receipts across older history pages. Native tools with incomplete pending arguments must remain valid public observations; detail specializes only when its required fields exist. The real transport scenario guards against invalid tool details disconnecting the browser. Those race and pagination tests complement the recorded happy path; a recording alone cannot establish them.
