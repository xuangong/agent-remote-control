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
3. In one headless browser context, in one script (see [browser](browser.md)), open
   the site, select that Host and the provider, and create a new session. Take a
   screenshot after each step. The instance workspace — the `State:` directory from
   `status`, plus `/workspace` (`~/.agent-remote-control-dev/instances/<name>/workspace`)
   — is the only workspace the Controller offers; add files there only when the
   test needs them.
4. Send a short prompt whose answer is not in the prompt:
   `Reply with the words LOCAL and OK joined by a hyphen, and nothing else.` The
   page also shows your own message, so the expected answer must not appear in the
   prompt, or the check passes without a model. Assert `LOCAL-OK` only inside the
   assistant's reply, which carries the class `.agent-message-assistant` (the Lab's
   own tests use it; user messages carry `.agent-message-user`):

   ```javascript
   const reply = page.locator('.agent-message-assistant', { hasText: 'LOCAL-OK' });
   try { await reply.first().waitFor({ timeout: 120_000 }); }
   catch (error) { await page.screenshot({ path: '.tmp/local/turn-timeout.png' }); throw error; }
   await page.screenshot({ path: '.tmp/local/reply.png' });
   ```

   If no such reply appears within the two minutes, take the screenshot (the
   snippet does), read `pnpm local controller diagnostics --source controller --limit 60`,
   and note the Model turn as failed in the report, with what both show. Do not resend the
   prompt or retry the turn. If the diagnostics or the page show a provider access
   error (sign-in, quota or model access), it is not a failure: handle it as the
   provider row of [Stop and ask the user](../SKILL.md#stop-and-ask-the-user)
   (stop and ask; the Model turn is not exercised).
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
