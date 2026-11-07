# Driving the instance from the command line

`agent-remote-controller-dev` is the Controller command line built from a
checkout, run against that checkout's instance (see
[the development command](../SKILL.md#the-development-command-and-the-test-directory)
for how it is installed and how it chooses the instance). Its Controller answers
`session` and `host` commands through its management socket, as the Host owner,
and `up` signs its command line in as the local user, so `window`, `api` and
`host list` work through the instance's site. None of these calls sign in, so
they may be repeated and polled. This is the fastest closed loop: change the
code, `pnpm local up`, drive a real session and read its history, then look at
the page.

```bash
agent-remote-controller-dev --build-info
agent-remote-controller-dev session list
agent-remote-controller-dev session create --provider claude --message "…"
agent-remote-controller-dev session read <address> --limit 2
agent-remote-controller-dev session send <address> "…"
agent-remote-controller-dev session link <address>
agent-remote-controller-dev host providers
agent-remote-controller-dev window list
agent-remote-controller-dev api GET /v1/remote/hosts
agent-remote-controller-dev --skill
```

Every command prints one JSON object. Exit codes: 0 done, 1 failed (see
`error.code`), 2 wrong usage, 3 a change may or may not have happened (inspect
before you repeat it with the same `--operation-id`). A session's address is
`<hostId>/<providerId>/<nativeSessionId>`; the instance has one Host,
`Dev · <checkout directory name>`. `--skill` prints the `agent-remote` skill that
this checkout's Controller gives its sessions: read it for every command and
option instead of guessing. When `agent-remote-controller-dev` is not found,
`pnpm local controller <args>` runs the same command from the checkout.

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

## Commands the sessions run

When the change is in the command line or in what sessions do with it (the
`agent-remote` skill, `role` commands, references), ask a test session to run the
command itself: in the instance's sessions `agent-remote-controller` is the
development command for that instance. For example, a session's own
`agent-remote-controller session read self --limit 0` answers with `"self": true`,
and `agent-remote-controller --build-info` names the instance. A session's
sandbox may hide the process state there (`"state": "unknown"`); the build fields
still come from the run.

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
`agent-remote-controller-dev login`. Without the sign-in, `session` and `host`
commands still work; `window`, `api`, `host list`, `session handoff` and
`--star` do not.

## What the instance refuses

- `start`, `stop`, `foreground`, `pair`, `autostart` and the native CLIs: the
  runner owns the Controller, and the native CLIs act on the shared profiles.
- `update` and `host update`: run `pnpm local up`.
- `session attach`, which can take a session over from its other clients.
- `host tunnel start|stop`: the VS Code tunnel is shared with the user's own
  Controller.
- `login` with options.
