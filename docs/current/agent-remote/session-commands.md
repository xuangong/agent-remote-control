# Session commands

Agents in sessions the Controller manages can list and read the Host's other sessions from their own shell, with `agent-remote-controller session`. The design and the later milestones (send, create, groups, other Hosts) are in [the session primitives design](../../superpowers/specs/2026-11-04-session-primitives-cli-design.md).

## Commands

```sh
agent-remote-controller session read self
agent-remote-controller session list [--provider P] [--limit 1..50] [--cursor C]
agent-remote-controller session read <hostId>/<providerId>/<nativeSessionId> [--limit 1..10] [--cursor C]
                                     [--search TEXT] [--turn TURN_ID] [--text-offset N]
agent-remote-controller session ref list
agent-remote-controller session ref add <hostId>/<providerId>/<nativeSessionId>
agent-remote-controller session ref remove <hostId>/<providerId>/<nativeSessionId>
```

Every command prints one JSON object. `list` merges the enabled providers' catalogs, newest first; `state` comes from the open session when the Controller holds it, otherwise from the catalog. `read` uses the provider's native history (`readSessionHistory`), with the paging of `read_source_session`: newest first, at most 10 entries per page, long entries continued with `--turn` and `--text-offset`. A provider whose catalog fails is named in `unavailableProviders` instead of failing the listing.

Errors print `{"error":{"code","message"}}` and exit with: `invalid_request` 2, `no_session_identity` 3, `controller_unreachable` 4, `session_forbidden` 5, `session_not_found` 6, `unsupported_configuration` 7, others 1.

## References

A session references other sessions of its Host: the source a Side or Ask was opened from, and sessions added by the user or by the agent with `session ref add`. `ref list`, and `read` for a session that has references, report `refs: [{ address, providerId, title?, origin: "source" | "added", addedAt? }]`, the source first. References only name sessions: what a session may read is decided by `read`.

The Controller keeps added references and a revision per session in `session-refs.json` in its state directory (the 4096 most recently changed sessions, at most 32 references each). The revision counts every change, including the removal and return of the source. Removing the source keeps the reader's grant record but marks it removed: `read_source_session` refuses to read until the source is added back. The tool stays declared in a running native process, so the website tells the agent about the change with its next message (see [web](web.md)).

Pages use the same references through `GET /v1/remote/hosts/:hostId/session/refs?providerId&nativeSessionId` and `POST` with `{ providerId, nativeSessionId, action: "add" | "remove", target: { providerId, nativeSessionId } }`; both return `{ revision, refs }`. The Relay allows them for the Host owner and for users the session is shared with.

Claude Code sessions with a credential run `session read`, `session list` and `session ref list` without asking; adding and removing references asks like other commands.

Until the Relay registers the Host, addresses use `local` as the Host. Both `local` and the registered Host id are accepted.

## Identity

The Controller gives every Claude Code and Codex session it creates or resumes two variables:

- `AGENT_REMOTE_SESSION_TOKEN`: a random credential for that native session.
- `AGENT_REMOTE_SESSION_SOCKET`: the session socket, `$TMPDIR/arc-sessions-<state scope>.sock` with symbolic links resolved (a named pipe on Windows).

Credentials are kept in `session-callers.json` in the Controller state directory, one per native session (the newest 4096), and survive Controller restarts, because a shared Codex daemon keeps loaded threads with their environment while the Controller restarts. A created session's credential is bound to its native identity once creation returns. Credentials are never written into persistence handles, session creation records or Codex rollouts.

The session socket is separate from the management socket: it accepts only session commands, and the management token never reaches a session.

Sessions the Controller did not start or resume, such as a native terminal session or a thread another Codex client loaded, have no credential and get `no_session_identity`. Prompt-edit forks and native-prefix successors get theirs on their next attachment. Copilot and OpenCode run one native process for all their sessions, so they get none.

## Sandboxes

| Provider | How commands reach the socket |
|---|---|
| Claude Code | `sandbox.network.allowUnixSockets` as a flag setting, merged with the Controller's or the user's sandbox; it neither enables nor disables one. Applies in every permission mode, including YOLO. Verified on macOS; on Linux the sandbox may still block the socket. |
| Codex, read-only sessions | A thread permission profile replaces the `sandbox` parameter: `agent-remote`, extending `:read-only`, with the managed network proxy and only the session socket allowed. Direct connections stay denied and the proxy allows no domain. Codex 0.166.0 or newer on macOS; elsewhere the read-only sandbox is unchanged and the socket unreachable. |
| Codex, other sessions | The user's own configuration decides. With `:danger-full-access` the socket is reachable; with a sandbox, the command fails with `controller_unreachable` until the agent reruns it with approved escalation. |

The variables reach Codex commands through `shell_environment_policy.set`, which Codex applies after its default exclusions.

## Share recipients

The Relay adds `shared: true` to the creation and attachment requests of a share recipient's sessions. The Controller then records the session in `session-callers.json`, revokes its credential, issues it none afterwards, and hides it: `list` omits it and `read` answers `session_not_found`. Sessions a recipient created before Relays sent the flag are marked the next time the recipient opens them. Controllers older than this feature ignore the flag.

## Authorization

A command is answered only for a credential the Controller issued and that is not a share recipient's. It reads the Host owner's sessions of enabled providers on this Host; other Hosts get `session_forbidden`. On a Host with a workspace execution policy, catalogs list only allowed workspaces, so `list` and `read` follow the same rule; the caller can always read itself.

## Skill

The Controller package contains the `agent-remote-sessions` skill in the Claude Code plugin layout (`dist/skills/agent-remote`, from `packages/agent-host/skills`).

- Claude Code sessions with a credential load it as a local SDK plugin: `agent-remote:agent-remote-sessions`.
- Codex has no per-thread skills. The first time the Controller creates or resumes a Codex session with a credential, the Codex adapter writes `$CODEX_HOME/skills/agent-remote-sessions/SKILL.md` if that Codex home exists and the file differs. Codex caches its skill list, so the adapter then makes Codex read its skills again once per workspace before the thread starts. The user's own Codex sessions see the skill too; it tells them it works only where `AGENT_REMOTE_SESSION_TOKEN` is set.

## Diagnostics

The Controller log records `session_calls_unavailable` when the credential store or the socket cannot be prepared (sessions then run without credentials), and `codex_skills_unavailable` when the Codex skill cannot be written. Requests themselves are not logged.
