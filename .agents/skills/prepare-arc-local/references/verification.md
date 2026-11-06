# Verification layers

Report each layer as verified, failed or not exercised, with what you observed.
A lower layer passing says nothing about a higher one.

| Layer | Evidence |
| --- | --- |
| Build | `up` finished after your last edit, and `status` shows a running build commit equal to the checkout commit, with its dirty state. |
| Site | `status` reports `running` and `local user: signed in`. |
| Controller | `status` reports `uplink registered`; `pnpm --silent local api v1/remote/hosts` lists a Host named `Dev · <checkout directory name>` with `"online": true` and the expected `providers`. |
| Page | A headless screenshot of the signed-in page taken after the change, which you opened and read, showing the changed UI. See [browser](browser.md). |
| Feature | The changed behaviour exercised through real page controls, with a read screenshot of each state the conclusion rests on and a DOM assertion for each text or state change. |
| Model turn | A session created in the instance workspace completes a real reply. See [test loop](test-loop.md). |

The Build, Site and Controller rows come from one `status` and one `api` call;
the [sign-in budget](../SKILL.md#machine-use-and-the-sign-in-budget) makes
repeating them a cost. An HTTP response, a screenshot or a registered Controller
is not evidence that a model turn works. An API write is not evidence that a page
control works.

## Screenshot evidence

A saved file is not evidence. For every screenshot you cite:

- Open it (read the image file) and say what it shows. Cite the path only with
  that description.
- When the claim is a text or state change, also assert it in the script through
  the DOM, by role or visible text, for example
  `await page.getByRole('button', { name: 'New session' }).waitFor()`. The
  screenshot shows the state; the assertion proves it.

## Providers and layers that cannot run

Claude Code and Codex are covered end to end; Codex needs the user's running
Codex daemon, which the instance never starts. Any other provider is not:
OpenCode may be unavailable because its server credentials belong to the user's
Controller, and its Ask callbacks go through the shared server. Say what you
exercised for such a provider and do not claim end-to-end coverage. See
[Shared native profiles](../../../../docs/local-development.md#shared-native-profiles).

If a layer cannot run, report it as not exercised with the reason instead of
substituting a weaker check. The conditions in
[Stop and ask the user](../SKILL.md#stop-and-ask-the-user) need the user first.
