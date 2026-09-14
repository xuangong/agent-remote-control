# Codex Default question enablement

## Cause and correction

Codex 0.148.0 disables `features.default_mode_request_user_input` by default.
The adapter already mapped native question requests and answers, but omitted
this flag on thread creation and resume. A deterministic local Responses server
emitting the real `request_user_input` tool call reproduced the native error
`request_user_input is unavailable in Default mode` before the fix.

The adapter now supplies the native feature override on both `thread/start`
and `thread/resume`. The existing public Question protocol and renderer handle
answers, resolution, reconnect, and cancellation. No Plan transition is needed.

## Scope and configuration precedence

The initial report proposed enabling only product-owned sessions. The current
Host directory cannot reliably identify historical ownership after a restart:
its catalog resume handle is `{}` for both old product sessions and external CLI
sessions. The implemented product policy enables questions for every root that
the user creates or actively resumes through this provider, including discovered
threads. It does not infer ownership from paths or model settings.

The session override wins over a profile's explicit feature `false`. The profile
file remains unchanged, and other CLI processes retain their own configuration.
Catalog listing and same-runtime child reads receive no separate override.
Sandbox, approval policy, and collaboration mode are independent. This native
feature makes questions available; it does not force a model to invoke them.
Native configuration rejection remains an error, without a silent retry that
would advertise a successfully enabled session. Arbitrary newer runtimes are
not feature-negotiated by this change; the verified target remains 0.148.0.

## Regression evidence

- `default-questions.local.test.ts` runs the real 0.148.0 app-server against a
  loopback Responses fixture, with both an absent and explicitly false profile
  flag. It covers creation, answer delivery, duplicate/late rejection, recovery
  from a catalog-style handle, another answer, pending-question cancellation,
  and subsequent ordinary input. Native questions have `isBlocking: false`;
  approval remains `never`, sandbox remains `readOnly`, and the profile file
  retains its exact original contents.
- Provider contract tests check the native start/resume arguments, subsequent
  Default turn mode, and propagation of native configuration rejection.
- Session tests cover native server-request resolution with both blocking and
  nonblocking questions.
- The standalone Codex fixture now defaults to ordinary mode. Browser tests
  exercise Default and Plan question forms, answer delivery, consecutive turns,
  reconnect, pending-question cancellation, and unchanged mode, on desktop and
  mobile. The full Codex browser suite passed all 12 cases with real app-server,
  Host, Relay and Web. The model endpoint is local and deterministic.

These checks do not establish that a live model will always ask, nor recover
in-flight question callbacks after the native process itself restarts.
