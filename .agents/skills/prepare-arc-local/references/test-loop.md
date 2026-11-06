# Real session test loop

Use this when a change affects sessions, or when asked for a complete local test.

1. `pnpm local up`. Continue only when the status it prints shows a running build
   equal to your checkout commit, `local user: signed in` and
   `uplink registered`. Do not call `status` again: `up` already did.
2. `pnpm --silent local api v1/remote/hosts`: the `Dev · <checkout directory name>`
   Host is online and lists the provider you will test (Claude Code or Codex). A
   missing provider is not installed or detected on this Mac, or Codex has no
   running daemon; report that. Never start the daemon.
3. In a headless browser (see [browser](browser.md)), open the site, select that
   Host and the provider, and create a new session. The instance workspace —
   the `State:` directory from `status`, plus `/workspace`
   (`~/.agent-remote-control-dev/instances/<name>/workspace`) — is the only
   workspace the Controller offers; add files there only when the test needs them.
4. Send a short prompt with a recognisable answer, such as
   `Reply with the word LOCAL-OK and nothing else.` Wait for the reply in the page
   with a bounded wait of two minutes and take a screenshot.
5. Exercise the behaviour under change through the page controls — Window, Side,
   Team, references and so on — and take a screenshot of each state your
   conclusion rests on.
6. Report per [verification](verification.md). Leave your session idle; do not
   archive or remove sessions you did not create. Test sessions stay in the
   shared native histories and appear in the user's own Controller.

Do steps 3 to 5 in one browser context, in one script when you can.

Provider sign-in and model access come from the shared native profile. A failed
turn caused by provider access is a provider result, not an instance failure;
report it as such.
