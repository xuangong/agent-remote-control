# OpenCode Host callbacks and Ask

Ordinary OpenCode sessions only require an independently managed native server. Host callback tools and Ask source references additionally require the bundled ARC native plugin. The Controller never modifies global OpenCode configuration or restarts that server.

## Explicit setup

Use the installed Controller command and a new private directory:

```sh
agent-remote-controller opencode callbacks setup "$HOME/.agent-remote-control/opencode-callbacks"
```

The command creates `arc-bridge-plugin.mjs` and `opencode-arc.json`, then prints `nativeConfigPath` and `configPath`. It rejects an existing target directory without replacing any files. The plugin is bundled inside the Controller package and does not reference the source checkout. Keep this directory private to the local user.

When starting your native server, select that additional configuration explicitly:

```sh
OPENCODE_CONFIG="$HOME/.agent-remote-control/opencode-callbacks/opencode-arc.json" \
  opencode serve --hostname 127.0.0.1 --port 4096
```

An already running server needs an operator-controlled restart to load its plugin. OpenCode may install its own plugin SDK on first load, so allow its initial dependency setup to finish. The ARC plugin itself bundles its schema dependency.

Configure the Controller to use the same native endpoint and rendezvous path:

```sh
export AGENT_HOST_PROVIDERS=opencode
export AGENT_HOST_OPENCODE_URL=http://127.0.0.1:4096
export AGENT_HOST_OPENCODE_CALLBACK_CONFIG="$HOME/.agent-remote-control/opencode-callbacks/callback.json"
agent-remote-controller foreground
```

Use the normal Controller pairing configuration. Native Basic authentication, if enabled, still uses `AGENT_HOST_OPENCODE_USERNAME` and `AGENT_HOST_OPENCODE_PASSWORD`. No bridge credential belongs in these commands or OpenCode configuration. The Controller writes its random process credential to `callback.json` with mode `0600`; it does not put the credential in session persistence, Remote messages, or logs. Accepted callback configuration paths are retained for later Controller starts.

The callback endpoint supports a trusted, local HTTP native server. Use exactly the same loopback hostname and port in the native server and Controller settings. `localhost` and `127.0.0.1` are different identities for this explicit configuration. One live Controller owns a rendezvous file; a competing owner is rejected. Multiple Controllers can still use ordinary shared OpenCode sessions, but the configured callback plugin has one callback owner.

## Runtime behavior

The plugin exposes two fixed tools, `arc_host_discover` and `arc_host_invoke`. Discovery returns only callbacks granted to the executing native session. Invocation uses `context.sessionID` supplied by OpenCode, never a session identifier selected in model arguments. Unbound sessions cannot discover or execute Host callbacks, including native children unless the Host explicitly binds them.

Each invocation rereads the private rendezvous file. A small heartbeat lets a restarted Controller verify plugin availability for the native server and directory. The Controller also checks the native tool registry before advertising Ask support. Callback tools added to a session become available without restarting OpenCode. Missing or disconnected plugin support produces an explicit failure for callback sessions; ordinary sessions remain usable.

Ask grants persist independently of native prompt text and are scoped to OpenCode and its server endpoint. The Host checks source access when creating an Ask, when restoring it, and before every source read. `read_source_session` has a fixed source, searches visible user and final assistant messages chronologically, reads newest entries first, and includes tool results when reading turn context. It excludes reasoning and binary data. Pages contain at most ten entries and 6,000 characters per entry; `textOffset` continues long entries. Native history scans have a bounded page and time budget and fail explicitly if that budget is exceeded.

Active Ask sessions require their Controller and cannot be released by idle-session cleanup. Closing a bound session revokes its callbacks; old session cleanup cannot remove a newer binding. Editing an earlier prompt in an Ask is rejected because the branch would otherwise lose its source grant.

The bridge caps input at 64 KiB, output at 128 KiB, and callback response time at ten seconds. Model-supplied arguments must pass the actual callback JSON Schema before execution. These checks protect against model-selected source/session substitution. They do not establish a security boundary against another process running as the same local operating-system user or against the explicitly trusted native server.

## Isolated native verification

Build the provider and run the dedicated native test with explicit deadlines:

```sh
pnpm --filter @orchardworks/agent-provider-opencode build
AGENT_OPENCODE_TEST_EXECUTABLE=/absolute/path/to/opencode \
  node --test --test-timeout=15000 scripts/opencode-native-callbacks.test.mjs
```

The test creates isolated native data/config directories and a deterministic local model server. Its preparatory dependency install has a 120-second deadline; the behavior test has a 15-second deadline. Set `AGENT_OPENCODE_TEST_REGISTRY` when the default npm registry is inaccessible, or `AGENT_OPENCODE_TEST_PLUGIN_PREFIX` to copy an already installed test-only `@opencode-ai/plugin@1.18.18` prefix. Neither setting reads personal OpenCode credentials. An outer process deadline should cover setup and the test, for example 150 seconds on the first run and 30 seconds when using a prepared prefix.
