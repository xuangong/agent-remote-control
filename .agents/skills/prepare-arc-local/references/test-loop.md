# Real session test loop

Use this when a change affects sessions, or when asked for a complete local test.

1. `pnpm local up`; see [lifecycle](lifecycle.md) for the check before a restart and
   the long timeout. Continue only when the status it prints shows a running build
   equal to your checkout commit, `local user: signed in` and `uplink registered`.
   Do not call `status` again: `up` already did. If `up` fails, follow
   [lifecycle](lifecycle.md#when-something-fails).
2. `pnpm --silent local api v1/remote/hosts`: the `Dev · <checkout directory name>`
   Host is online and lists the provider you will test (Claude Code or Codex). A
   missing provider is a stop condition: see
   [Stop and ask the user](../SKILL.md#stop-and-ask-the-user). Never start the
   daemon.
3. Run one turn with the tested script, from the checkout root:

   ```bash
   node .agents/skills/prepare-arc-local/scripts/session-turn.mjs "Claude Code"   # or Codex
   ```

   In one headless context it selects the `Dev · …` Host, adds an empty view,
   opens a new session there with the chosen provider, sends
   `Reply with the words LOCAL and OK joined by a hyphen, and nothing else.` and
   waits up to two minutes for `LOCAL-OK` in an assistant message
   (`.agent-message-assistant`) of that view only. It saves
   `session-created.png` and `turn-reply.png` (or `turn-timeout.png`) under
   `.tmp/local/`; read them. The session runs in the instance workspace
   (`workspace/` in the `State:` directory from `status`), the only workspace the
   Controller offers; add files there only when the test needs them.

   If the script reports a timeout, it has already saved the screenshot: read it
   and `pnpm local controller diagnostics --source controller --limit 60`, and note
   the Model turn as failed in the report with what both show. Do not resend the
   prompt or retry the turn. If either shows a provider access error (sign-in,
   quota or model access), it is not a failure: handle it as the provider row of
   [Stop and ask the user](../SKILL.md#stop-and-ask-the-user) (stop and ask; the
   Model turn is not exercised).
4. When you write your own steps (see [browser](browser.md)), keep the script's two
   safeguards. A Window can hold several views, and another view may already show
   the same text, so pin the view you created by its `data-view-id` and scope every
   locator to it; a locator filtered on state you are about to change (such as "no
   messages yet") stops matching once you act. And the expected answer must not
   appear in the prompt, or your own message satisfies the check.
5. Exercise the behaviour under change through the page controls — Window, Side,
   Team, references and so on — with a screenshot of each state your conclusion
   rests on and a DOM assertion for each text or state change.
6. Report per [verification](verification.md). Leave your session idle; do not
   archive or remove sessions you did not create. Test sessions stay in the
   shared native histories and appear in the user's own Controller.

Provider sign-in and model access come from the shared native profile. A turn that
fails because the provider has no access (sign-in, quota or model access) is a
provider result, not an instance failure, and a stop condition: see
[Stop and ask the user](../SKILL.md#stop-and-ask-the-user).
