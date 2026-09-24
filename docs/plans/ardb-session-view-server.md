# ARDB Session View server

ARDB is the headless Session View. `ardb server` adds the same product Timeline and composer as an optional browser presentation of a locally owned Relay session.

## Boundaries

- Existing Provider adapters own native CLI interpretation and controls, including stdio lifetimes. ARDB composes them rather than interpreting native messages itself.
- The existing Relay owns public snapshots, timelines, operation handling and recovery. No debugger-specific conversation protocol or reducer is introduced.
- The browser reuses the product LabWorkbench and useConversationSession hook. Product navigation, accounts, Host management and Tunnel contexts are not mounted.
- Browser and terminal are independent public clients of the same session. Refresh/reconnect only changes subscriptions, never session ownership.
- Assets are built into the debugger package. Runtime operation does not depend on a checkout, a Vite process, or a private lab package.

## Command

`ardb server --provider codex|claude|copilot --cwd PATH [--executable PATH] [--model MODEL] [--reasoning-effort EFFORT] [--port PORT] [--open] [--jsonl]`

Alternatively `--adapter FILE` loads a local ES module exporting `createAdapter()` returning an AgentProviderAdapter, optionally with `dispose()`. This is trusted local development code, not a module supplied by a browser. The server creates one public Agent and reports its URL and ID. A persistence handle can be supplied explicitly for resume. Codex uses its owned private runtime by default; this does not restart a user's shared daemon.

The server binds loopback and checks Host and Origin. It serves packaged assets, the public Relay endpoints and a small session bootstrap response. Standard headless commands work against the reported Relay/Origin. SIGINT/SIGTERM closes subscriptions, the Relay, provider resources and its temporary image store.

## Observability

- A headless subscriber observes authoritative Relay state as JSONL. It does not open a second native subscription or synthesize success from control intents.
- Existing `observe` and `protocol trace` remain independent headless clients.
- Browser protocol metadata is explicitly labeled browser-originated diagnostics, collected via a bounded debug-only side channel. Message payloads and user values are omitted. These records do not replace or drive public protocol delivery; detailed independent client traces retain existing redaction.
- Observability failure must not change the outcome of an Agent operation or silently look like complete recording.

## Validation

1. Real HTTP/WebSocket tests: session creation once; browser/headless state convergence; send, cancel and interaction controls; reconnect without duplicate messages; clean disposal; Origin/Host rejection.
2. Browser tests: actual product Timeline/composer served from package assets, message/control interactions, refresh and network reconnect.
3. Adapter-module tests include a child-process stdio fixture; native adapters retain their separate native compatibility tests.
4. Package build, typecheck, CLI entry/help, compatibility update/check. Do not claim real authenticated native CLI acceptance from fixture tests.

No deploy, release or global installation is part of this change.
