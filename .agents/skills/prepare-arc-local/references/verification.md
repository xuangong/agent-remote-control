# Verification layers

Report each layer as verified, failed or not exercised, with what you observed.
A lower layer passing says nothing about a higher one.

| Layer | Evidence |
| --- | --- |
| Build | `up` finished after your last edit, and `status` shows a running build commit equal to the checkout commit, with its dirty state. |
| Site | `status` reports `running` and `local user: signed in`. |
| Controller | `status` reports `uplink registered`; `pnpm --silent local api v1/remote/hosts` lists a Host named `Dev · <checkout directory name>` with `"online": true` and the expected `providers`. |
| Page | A headless screenshot of the signed-in page taken after the change, showing the changed UI. See [browser](browser.md). |
| Feature | The changed behaviour exercised through real page controls, with screenshots of each state the conclusion rests on. |
| Model turn | A session created in the instance workspace completes a real reply. See [test loop](test-loop.md). |

The Build, Site and Controller rows come from one `status` and one `api` call;
the sign-in limit makes repeating them a cost. An HTTP response, a screenshot or a
registered Controller is not evidence that a model turn works. An API write is not
evidence that a page control works.

Claude Code and Codex are covered end to end; Codex needs the user's running
Codex daemon, which the instance never starts. Any other provider is not:
OpenCode may be unavailable because its server credentials belong to the user's
Controller, and its Ask callbacks go through the shared server. Say what you
exercised for such a provider and do not claim end-to-end coverage. See
[Shared native profiles](../../../../docs/local-development.md#shared-native-profiles).

If a layer cannot run — no provider access, a sandbox refusal, no running Codex
daemon — say which layer and why instead of substituting a weaker check.
