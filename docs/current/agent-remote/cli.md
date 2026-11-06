# Command line

`agent-remote-controller` does from a shell what the website does, for people and for agents. The design is in [the session primitives design](../../superpowers/specs/2026-11-04-session-primitives-cli-design.md); agents learn the commands from the `agent-remote` skill.

## Command groups

| Group | What it covers |
|---|---|
| `session` | List, read, inspect, link, create, send, steer, cancel, answer, set, release, hand off and attach sessions; their references. |
| `role` | In a session's shell: the commands of the role it holds (Team member, support coordinator or supporter, TPM, a worker calling for support). |
| `host` | List and read Hosts; providers, workspaces, VS Code tunnel, previews, Controller updates, stopping sessions. |
| `window` | Windows: create, arrange views, name the session that arranges one. |
| `login`, `logout` | The command line's own website sign-in. |
| `api` | Any website request as the signed-in user, for what the groups above do not cover. |
| `--skill` | Prints the `agent-remote` skill. |

The rest manage this computer's Controller and work while the Relay is unreachable: `start`, `stop`, `status`, `foreground`, `pair`, `autostart`, `update`, `diagnostics`; and the native CLIs with the Controller's configuration: `codex` (with `codex daemon`), `claude`, `copilot`, `opencode` (with `opencode server` and `opencode callbacks`).

Replaced commands are gone: `share` (`session list` and `session link --qr`), `claude|copilot|opencode resume` (`session attach`, which also opens Codex sessions), `environment` (`host read`). The provider commands answer `resume` with a pointer to `session attach`, so that it is not sent to the agent as a prompt.

## Conventions

- Every resource command prints one JSON object; a failure prints `{"error":{"code","message"}}` and, for an uncertain change, the operation to query.
- Exit codes: 0 done, 1 failed (see `error.code`), 2 wrong usage, 3 a change may or may not have happened. `window` uses the same codes.
- Changes take `--operation-id`; without one a new ID is made. Repeating a change with the same ID does it once: the Controller hashes the ID into the UUID its operation cache keys by (`operationUuid`).
- A session's address is `<hostId>/<providerId>/<nativeSessionId>`. A session's own shell may say `self`; `local` names this computer's Host, also before the Relay registers it.

## Who asks

Each command resolves its caller once, in this order (`cli-client.ts`):

1. **A session's shell** (`AGENT_REMOTE_SESSION_TOKEN` and `AGENT_REMOTE_SESSION_SOCKET`): the session socket, as that session.
2. **An ordinary terminal** of a computer whose Controller runs: the management socket with the daemon token, as the Host owner.
3. **Otherwise**: the Relay, with the command line's sign-in (`cli-credentials.json` in the state directory, private), as the signed-in user.

The Controller answers session and host commands for its own Host. A command that names another Host, and what only the Relay keeps (`host list`, previews, Controller updates), goes through the Relay with the same command-line sign-in, read by the Controller from its state directory; without it the answer is `signed_out`. The other Host sees its owner: a calling session's `self` in `--from` and `--ref` becomes its address first. Windows, stars and handoffs, which only the website keeps, use the sign-in directly.

Share recipients' sessions are neither listed nor reachable by any caller. A session may not answer its own requests or change its own `approval`, `sandbox` or `permissions` settings (`session_forbidden`): either would grant it what its user did not.

## Sign-in

`agent-remote-controller login [--server URL] [--no-browser]` asks the Relay for a code (`POST /auth/cli/start`), opens `/auth/cli?code=XXXXXXXX`, and polls `POST /auth/cli/token` (202 while pending, 403 refused, 410 expired). The page asks the signed-in user to allow or refuse the code shown in the terminal; allowing needs a recent sign-in on account-backed Relays. On approval the Relay copies the browser's session record into a new one labelled "Command line · <computer>": the same account, grant and lifetime, listed and revocable with browser sessions in Settings. Pending codes live in memory for ten minutes; a Relay restart asks for a new sign-in. `login status` checks it, `logout` ends it at the Relay and deletes the file. `--server` defaults to the Relay the Controller is paired with.

The command line sends its session as a cookie with the Relay's own `origin`, as the page does, so every Relay check that applies to the page applies to it.

## Session commands

```sh
session list [--host H] [--provider P] [--limit 1..50] [--cursor C]
session read <address> [--limit 0..10] [--cursor C] [--search TEXT] [--turn TURN_ID] [--text-offset N]
session inspect <address>
session link <address> [--qr]
session create --provider P [--host H] [--cwd DIR] [--model M] [--effort E] [--planning]
               [--from ADDRESS [--context]] [--ref ADDRESS]... [--message TEXT | --file PATH]
session send <address> (TEXT | --file PATH) [--steer]
session cancel <address>
session answer <address> <request-id> --response JSON
session set <address> [--setting ID=VALUE]... [--planning true|false] [--title TEXT] [--star true|false]
session release <address>
session handoff <address> [--to PROVIDER]
session attach <address> [--take-over]
session ref list [--session ADDRESS]
session ref add|remove <address> [--session ADDRESS]
```

All of them except `attach`, `handoff` and `--star` run on the Host in one handler, `handleSessionRequest` (`session-routes.ts`), which both local sockets and the Relay route reach:

- `list` merges the enabled providers' catalogs, newest first; a provider whose catalog fails is named in `unavailableProviders`. `state` comes from the open session when the Controller holds it.
- `read` pages the provider's native history: newest first, at most 10 entries, long entries continued with `--turn` and `--text-offset`. `--limit 0` describes the session without reading history.
- `create` uses the Host's own creation path (operation cache, workspace policy). `--from` makes the source a reference the agent hears about with its first input; `--context` quotes the source's recent conversation into the first message.
- `send`, `steer`, `cancel`, `answer`, `set` take a lease on the session and run as operations of scope `host:cli`, with the same receipts as the website's.
- `release` lets the Controller close an idle session's native process when nothing else needs it.
- `link` prints the website link that opens the session; `--qr` also draws it on stderr.

`attach` runs the session's native CLI in this terminal: `claude --resume` and `copilot --resume=` with their profile leases (`--take-over` interrupts a client that holds the session), `codex resume` through the shared daemon, and OpenCode's TUI attached to its server. A `local/...` address needs no Controller; any other is checked to be this computer's. `handoff` drives the website's Handoff through the Relay (`describe`, `prepare`, `status` until ready, `commit`); repeating it with the same `--operation-id` continues the same handoff. `--star` adds or removes the session in the user's favorites (`/v1/stars`).

### References

A session references other sessions of its Host: the source a Side or Ask was opened from, and sessions added by the user or by an agent. References are an attribute of every session, kept by the Host whatever created the session: `ref list`, and `list` and `read` for each session, report `refs: [{ address, providerId, title?, origin: "source" | "added", addedAt? }]`, the source first, and `referencedBy` for the sessions that reference it. On a Host with a workspace policy, the source of a session outside the allowed workspaces is neither reported nor changed.

The Controller keeps references, a revision and the revision last delivered per session in `session-refs.json` (the 4096 most recently changed sessions, at most 32 references each). A source a provider recorded before is adopted the first time the session is read. Removing the source keeps the provider's grant record but marks it removed, so `read_source_session` refuses until the source is added back.

The Host tells the agent: when a session's revision is newer than the one it last delivered, the session's next input (from a page, a command, a Team message) ends with a `<session-references revision="N">` note listing the current references, before any quotes. Controllers declare this as `referenceNotes`; for older ones the page adds the note.

Pages use the same references through `GET /v1/remote/hosts/:hostId/session/refs?providerId&nativeSessionId` and `POST` with `{ providerId, nativeSessionId, action, target }`, for the Host owner and for a share recipient who may open both sessions.

## Role commands

```sh
role list
role <command> [--OPTION VALUE]... [--input JSON | --input-file PATH|-]
```

A role command runs one of the tools of the role the calling session holds, with the tool's own handler and JSON schema check (`role-routes.ts`): the Team tools of a member or Leader, a support coordinator's and supporter's tools, a TPM's tools, or, for a session without a role, the worker's Call For Support tools while they are enabled. Commands are the tool names in kebab-case; options are the input's fields in kebab-case, repeated for arrays and JSON for objects. Only a session's own shell has a role.

The tools are still given to the sessions as before. Commands alone would ask Codex sessions in the user's own sandbox to approve every call, since their sandbox blocks the session socket until a command runs outside it; the tools run in the Controller and need no approval.

## Host commands

```sh
host list
host read [--host H]
host providers [--host H]
host providers set <provider> --enabled true|false [--host H]
host workspaces [--host H] [--provider P] [--path DIR]
host workspaces create <parent-dir> <name> [--host H] [--provider P]
host tunnel [status | start --accept-license | stop] [--host H]
host previews [--host H]
host previews renew|remove <preview-id> [--host H]
host update [--host H] [--version X.Y.Z]
host stop-sessions [--host H]
```

One implementation, `runHostRequest` (`host-command.ts`), runs over either the Controller's own routes (`/remote/<path>`) or the Relay's (`/v1/remote/hosts/<id>/<path>`), which apply the website's checks. `host read` describes this Host from the Controller (identity, providers, environment, Controller version and update state) and another from the Relay's Host list. `providers set` writes at the revision it just read. `list`, `previews` and `update` go to the Relay: it keeps the Host list, preview registrations and the Controller release.

## Window commands

`window` acts as the signed-in user on `/v1/windows` in the user's namespace. `create` makes an empty Window; `manager ID --session JSON | --clear` names the session that arranges it. The private manager grants, their files and `AGENT_WINDOW_*` variables, and the Relay's bearer route are gone. See [Window agent operations](../../guides/window-agent-operations.md).

## The Relay route

`POST /v1/remote/hosts/:hostId/session/call` with `{ request }` forwards a session command to the Host's `POST /remote/session/call`, for the Host owner only, and only to Controllers whose providers declare `sessionCommands` (older ones close their uplink on an unknown route). Changing `approval`, `sandbox` or `permissions` settings needs a recent sign-in, as in the website. Deploy the website before Controllers that declare it: older Relays reject the declaration.

## Session credentials

The Controller gives every Claude Code and Codex session it creates or resumes two variables:

- `AGENT_REMOTE_SESSION_TOKEN`: a random credential for that native session.
- `AGENT_REMOTE_SESSION_SOCKET`: the session socket, `$TMPDIR/arc-sessions-<state scope>.sock` with symbolic links resolved (a named pipe on Windows).

Credentials are kept in `session-callers.json` in the Controller state directory, one per native session (the newest 4096), and survive Controller restarts, because a shared Codex daemon keeps loaded threads with their environment while the Controller restarts. A created session's credential is bound to its native identity once creation returns. Credentials are never written into persistence handles, session creation records or Codex rollouts.

The session socket is separate from the management socket: the management token never reaches a session.

Sessions the Controller did not start or resume, such as a native terminal session or a thread another Codex client loaded, have no credential and get `no_session_identity`. Prompt-edit forks and native-prefix successors get theirs on their next attachment. Copilot and OpenCode run one native process for all their sessions, so they get none.

### Sandboxes

| Provider | How commands reach the socket |
|---|---|
| Claude Code | `sandbox.network.allowUnixSockets` as a flag setting, merged with the Controller's or the user's sandbox; it neither enables nor disables one. Applies in every permission mode, including YOLO. Verified on macOS; on Linux the sandbox may still block the socket. |
| Codex, read-only sessions | A thread permission profile replaces the `sandbox` parameter: `agent-remote`, extending `:read-only`, with the managed network proxy and only the session socket allowed. Codex 0.166.0 or newer on macOS; elsewhere the read-only sandbox is unchanged and the socket unreachable. |
| Codex, other sessions | The user's own configuration decides. With `:danger-full-access` the socket is reachable; with a sandbox, the command fails with `controller_unreachable` until the agent reruns it with approved escalation. |

The variables reach Codex commands through `shell_environment_policy.set`, which Codex applies after its default exclusions. Claude Code sessions with a credential run these without asking: `session read`, `session list`, `session ref list`, `session inspect`, `host read`, `host list`, and `role` commands, which are the tools they run without asking too.

### Share recipients

The Relay adds `shared: true` to the creation and attachment requests of a share recipient's sessions. The Controller then records the session in `session-callers.json`, revokes its credential, issues it none afterwards, and hides it from every command.

## Skill

The Controller package contains the `agent-remote` skill in the Claude Code plugin layout (`dist/skills/agent-remote`, from `packages/agent-host/skills`). `--skill` prints it.

- Claude Code sessions with a credential load it as a local SDK plugin: `agent-remote:agent-remote`.
- Codex has no per-thread skills. The first time the Controller creates or resumes a Codex session with a credential, the Codex adapter writes `$CODEX_HOME/skills/agent-remote/SKILL.md` if that Codex home exists and the file differs, and removes the skill it replaced, `agent-remote-sessions`, if the Controller wrote it. Codex caches its skill list, so the adapter then makes Codex read its skills again once per workspace. The user's own Codex sessions see the skill too.

## Diagnostics

The Controller log records `session_calls_unavailable` when the credential store or the socket cannot be prepared (sessions then run without credentials), and `codex_skills_unavailable` when the Codex skill cannot be written. Commands themselves are not logged.
