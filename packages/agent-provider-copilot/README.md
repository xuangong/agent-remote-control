# GitHub Copilot provider

This package adapts the official `@github/copilot-sdk` 1.0.11 to the standalone Provider SDK. It owns an official Copilot CLI process over SDK stdio, with normal installed dependencies and no Borgee service or private runtime transport dependency.

The default executable is the public `copilot` bin declared by the pinned `@github/copilot` 1.0.83 package. It is resolved through Node package resolution because SDK 1.0.11's default optional platform-package lookup does not resolve under this workspace's pnpm dependency layout. `executable` explicitly overrides this path. Authentication uses the native CLI environment; this package does not persist tokens.

## Supported behavior

- Create, native discovery, disconnect/resume, durable history followed by one history boundary, deduplicated live events, streamed text, reasoning, tools and usage.
- Immediate or queued root input, steering and main-turn interrupt. One foreground turn spans all native model steps and completes at `assistant.idle`; assistant idle does not disconnect the native session or terminate background tasks. Child completion follows native task idle snapshots, including repeated follow-up rounds.
- Permission events expose one-time allow/deny through public pending-permission RPC. Questions preserve native choices and freeform constraints. Native request IDs and event agent identities own prompt retirement and main-versus-child cancellation; callback session IDs are never interpreted as child identities. Responses are validated against the actual pending request.
- Native session model choices and native user-invocable enabled skills. Skill invocation resolves its canonical slash command through public `commands.invoke` and sends the returned agent prompt with its native display text. Documentation reads are restricted to paths returned by the native skill directory.
- Parent-owned child task directory, filtered paginated child event-log history, live child routing, repeated task input and task cancellation. Disposing a child view does not cancel the task or disconnect the parent. Children are never resumed as independent root sessions.

## Question callback limitation

SDK 1.0.11 requires `onUserInputRequest` to enable `ask_user`, but its callback omits native request and agent IDs. The adapter pairs a callback only when exactly one unbound `user_input.requested` event has the same complete question/choice/freeform payload. Different questions may run concurrently. Concurrent identical unbound questions fail explicitly with a visible error and terminal prompt receipts; the adapter never guesses FIFO ownership or invents an answer. Native completion events retire matching prompts, including responses or cancellations from another native client.

## Experimental native interfaces

`session.rpc.model`, `skills`, `commands`, `tasks`, `interruptMainTurn`, and `eventLog` are public **experimental** SDK APIs. Model and command controls are advertised only when their native directory calls succeed. Unavailable child event-log history fails explicitly; there is no filesystem or private RPC fallback. Copilot CLI 1.0.39 lacks `session.eventLog.read`; use the pinned runtime for full child views.

Workspace skill directories come from public native `client.rpc.skills.getDiscoveryPaths`; the returned canonical directories are supplied to session creation/resume. The adapter lists only enabled user-invocable skills the session actually loads; it does not scan hardcoded paths or infer global commands. Native model catalog availability depends on authentication. Planning, permission-mode settings, independent child settings, arbitrary file reads, and child-view interaction ownership are not advertised.

`CopilotAgentProviderOptions` accepts `executable`, `env`, `requestTimeoutMs`, and `onDiagnostic`. `nativeSessionConfig.provider`, `nativeSessionConfig.skillDirectories`, and `useLoggedInUser` support explicit official SDK BYOK configuration and isolated local transport verification. Provider credentials are never copied into persistence handles. Dispose the provider to stop its owned runtime process.

## Verification

Behavior tests cover projection, native history/live overlap, lifecycle, validated callbacks, native controls, child ownership and repeated input. Each test has a 10-second deadline; callers must also impose an outer process deadline (root test commands provide it). Typecheck/build validate the exact SDK types. Real runtime/authenticated-provider verification is a separate integration check; mocked behavior tests do not establish account availability.
