# Real session test loop

Use this when a change affects sessions, or when asked for a complete local test.
Repeat it after every fix: change, `up`, check, until the check passes.

1. `pnpm local up`; see [lifecycle](lifecycle.md) for the check before a restart and
   the long timeout. Continue only when the status it prints shows a running build
   equal to your checkout commit, `local user: signed in` and `uplink registered`.
   Do not call `status` again: `up` already did. If `up` fails, follow
   [lifecycle](lifecycle.md#when-something-fails).
2. `agent-remote-controller-dev host providers`: the provider you will test
   (Claude Code or Codex) is `enabled`. A missing or unavailable provider is a stop
   condition: see [Stop and ask the user](../SKILL.md#stop-and-ask-the-user). Never
   start the daemon.
3. Run one turn through the [command line](cli.md), from the checkout root:

   ```bash
   node .agents/skills/prepare-arc-local/scripts/cli-turn.mjs claude   # or codex
   ```

   It creates a session in the instance workspace, the only workspace the
   Controller offers, asks for `LOCAL-OK` and checks the reply. Drive further
   turns with `--session <address> "<prompt>"`, and read the history with
   `agent-remote-controller-dev session read <address>`. Add files to the
   instance workspace (`workspace/` in the `State:` directory from `status`) only
   when the test needs them.

   If the script reports a timeout or a failed session, read
   `agent-remote-controller-dev diagnostics --source controller --limit 60` and
   note the Model turn as failed in the report with what it shows. Do not resend
   the prompt or retry the turn. If it shows a provider access error (sign-in, quota or model
   access), it is not a failure: handle it as the provider row of
   [Stop and ask the user](../SKILL.md#stop-and-ask-the-user) (stop and ask; the
   Model turn is not exercised).
   A Codex session stays loaded in the user's shared Codex daemon with its MCP
   servers; release each one you created when the test no longer needs it
   ([Release your Codex sessions](../SKILL.md#safety-rules)).
4. When the change shows in the page, open the session there:
   `session link <address>` gives its URL for `pnpm local screenshot` (see
   [command line](cli.md#see-it-in-the-page)); read the image. When the change is in
   the page's own way of creating or sending, run the turn through the page
   instead:

   ```bash
   node .agents/skills/prepare-arc-local/scripts/session-turn.mjs "Claude Code"   # or Codex
   ```

   In one headless context it selects the `Dev · …` Host, adds an empty view,
   opens a new session there, sends the `LOCAL-OK` prompt and waits up to two
   minutes for the reply in an assistant message (`.agent-message-assistant`) of
   that view only. It saves `session-created.png` and `turn-reply.png` (or
   `turn-timeout.png`) under `.tmp/local/`; read them. The reply screenshot is
   taken as soon as the reply appears, so its composer may still show
   `Working`; the reply in the view is the evidence.

   When you write your own page steps (see [browser](browser.md)), keep that
   script's two safeguards. A Window can hold several views, and another view may
   already show the same text, so pin the view you created by its `data-view-id`
   and scope every locator to it; a locator filtered on state you are about to
   change (such as "no messages yet") stops matching once you act. And the
   expected answer must not appear in the prompt, or your own message satisfies
   the check.
5. Exercise the behaviour under change through the page controls — Window, Bot
   mode, Side, Team, references and so on — with a screenshot of each state your conclusion
   rests on and a DOM assertion for each text or state change. Command line
   calls may prepare the state and read the result; they do not replace the page
   control under test.
6. Report per [verification](verification.md). Leave your session idle; do not
   archive or remove sessions you did not create. Test sessions stay in the
   shared native histories and appear in the user's own Controller.

Provider sign-in and model access come from the shared native profile. A turn that
fails because the provider has no access (sign-in, quota or model access) is a
provider result, not an instance failure, and a stop condition: see
[Stop and ask the user](../SKILL.md#stop-and-ask-the-user).
