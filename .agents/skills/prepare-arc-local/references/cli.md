# Driving the instance from the command line

`pnpm local controller` runs this checkout's `agent-remote-controller` against the
instance. Its Controller answers `session` and `host` commands through its
management socket, as the Host owner, and `up` signs its command line in as the
local user, so `window`, `api` and `host list` work through the instance's site.
None of these calls sign in, so they may be repeated and polled. This is the
fastest closed loop: change the code, `pnpm local up`, drive a real session and
read its history, then look at the page.

```bash
pnpm --silent local controller session list
pnpm --silent local controller session create --provider claude --message "…"
pnpm --silent local controller session read <address> --limit 2
pnpm --silent local controller session send <address> "…"
pnpm --silent local controller session link <address>
pnpm --silent local controller host providers
pnpm --silent local controller window list
pnpm --silent local controller api GET /v1/remote/hosts
pnpm --silent local controller --skill
```

Every command prints one JSON object. Exit codes: 0 done, 1 failed (see
`error.code`), 2 wrong usage, 3 a change may or may not have happened (inspect
before you repeat it with the same `--operation-id`). A session's address is
`<hostId>/<providerId>/<nativeSessionId>`; the instance has one Host,
`Dev · <checkout directory name>`. `--skill` prints the `agent-remote` skill that
this checkout's Controller gives its sessions: read it for every command and
option instead of guessing.

Sessions start only in the instance workspace; a `--cwd` elsewhere is refused.
Operate only sessions you created ([Own sessions only](../SKILL.md#safety-rules)).
`host stop-sessions` stops every session of the instance, so check first as
[before a restart](lifecycle.md#before-restarting-a-running-instance).

## One model turn

```bash
node .agents/skills/prepare-arc-local/scripts/cli-turn.mjs claude        # or codex
node .agents/skills/prepare-arc-local/scripts/cli-turn.mjs --session <address> "<prompt>"
```

Without a prompt, the script creates a session that is asked for `LOCAL-OK`,
waits up to two minutes for the reply and checks it. With `--session` it sends
the next turn of that session. It prints `{"address", "state", "reply"}`, and
stops with an error when the session waits for an answer (`session inspect`
shows the request, `session answer` gives it) or fails. A new session has no
history until its first turn is written; until then `session read` answers
`history_unavailable`, which the script waits out.

## See it in the page

`session link <address>` prints the session's page URL. Pass its path and query
to a screenshot, then read the image:

```bash
pnpm local screenshot '/?host=…&provider=…&session=…' --out .tmp/local/session.png --wait-for '.agent-message-assistant'
```

To place a session in a Window, `window list` gives the Window ID, then
`window view create <window-id> --session '{"hostId":"…","providerId":"…","nativeSessionId":"…","title":"…"}'`.
For page controls, use [browser](browser.md).

## Sign-in

`up` signs the command line in with the product's own `login`, allowing its code
as the local user (one sign-in, only when it is signed out). The sign-in is kept
in the instance's `controller/` state and survives restarts; `status` shows
`command line: signed in`. When it shows `signed out`, run
`pnpm local controller login`. Without the sign-in, `session` and `host` commands
still work; `window`, `api`, `host list`, `session handoff` and `--star` do not.

## What the instance refuses

- `start`, `stop`, `foreground`, `pair`, `autostart`, `update` and the native CLIs:
  the runner owns the Controller, and the native CLIs act on the shared profiles.
- `session attach`, which can take a session over from its other clients.
- `host update` (run `pnpm local up`) and `host tunnel start|stop` (the VS Code
  tunnel is shared with the user's own Controller).
- `login` with options. `role` is not offered: only a session's own shell holds
  a role.

`pnpm local controller` drops the calling shell's session variables, so even in
a session's shell it addresses the instance. The global `agent-remote-controller`
acts on the user's own Controller and Hosts (in a session's shell, as that
session): never use it for the instance.
