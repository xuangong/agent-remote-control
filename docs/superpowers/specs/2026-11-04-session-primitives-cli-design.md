# Session primitives in the Controller CLI

Status: proposed on 2026-11-04. Implemented on 2026-11-07, see [command line](../../current/agent-remote/cli.md): identity, discovery and read; send, create, answer and settings; other Hosts through the Relay with the command line's own sign-in; role commands for Team, support and TPM roles. Role tools are still given to sessions, because a Codex session in the user's own sandbox cannot reach the session socket without approval. The feasibility spike ran on 2026-11-04 (see [Evidence](#evidence)).

## Problem

Every way sessions cooperate today ships its own tools, bound into a session when it attaches: Team (`team.ts`), Call For Support (`call-for-support-worker.ts`, namespace `agent_remote`), TPM (`tpm.ts`), and Sides and Asks (`read_source_session` in `session-reference.ts`). Each mode decides how its tools reach each provider (dynamic tools, MCP servers, tool namespaces, `creation` / `attachment` / `live` timing), and a session opened before a mode existed lacks that mode's tools until it is reattached. Adding a mode means adding tools to every provider path again.

Agents already have a universal tool: their shell. A small set of commands in the existing `agent-remote-controller` CLI, taught by a skill, gives every Controller-managed session the same capabilities without per-provider tool plumbing, and lets new modes be written as skills instead of code.

## Model

Two nouns and six verbs.

- **Session**: a native session on some Host, addressed as `<hostId>/<providerId>/<nativeSessionId>`, or `self` for the calling session.
- **Group**: a named set of sessions with a free-text label the platform does not interpret (for example `team:release`, `support:review`). Membership records whether the group *created* the session or the session *joined*.

| Verb | Sessions | Groups |
|---|---|---|
| `list` | sessions visible to the caller | groups the caller belongs to |
| `read` | header and history of one session | members and recent messages of one group |
| `create` | a new session (provider, model, workspace, access) | a new group |
| `close` | release a created session | release the group's created members; joined members only leave |
| `send` | a message, delivered between turns with a receipt | a message to every member |
| `add` / `remove` | — | membership |

A **mode** is a group, a skill (the playbook the agent follows), a policy template (what the commands may do inside that group: providers, models, workspaces, access, counts, usage) and optionally a website view. Handoff is not a group: it continues a session's identity on another session (`session-succession.ts`), and stays as it is.

How the existing modes map:

| Mode | Group | Policy template | What disappears |
|---|---|---|---|
| Side / Ask | one source session, one created reader | reader may `read` its source only | `read_source_session` |
| Team | members joined or created by the user | members `send` to each other, `read` each other | Team delivery tools |
| Call For Support | worker, coordinator, supporters | coordinator `create`s supporters within the mandate; worker `send`s calls and `read`s reports | `agent_remote` namespace |
| TPM | main session, TPM | TPM `read`s the main session and `send`s reviews | TPM tools |

The Relay keeps enforcing policy; a skill only explains it.

## Identity and transport

A session proves who it is with a credential the Controller gives it when it starts or resumes the session:

- `AGENT_REMOTE_SESSION_TOKEN`: a random 256-bit token, one per native session.
- `AGENT_REMOTE_SESSION_SOCKET`: the Controller's session socket (a named pipe on Windows).

The CLI reads both, sends one JSON request per connection, and prints JSON. The session socket is separate from the management socket in `cli.ts`, so a session never sees the daemon token, and the session socket accepts only session commands.

Tokens are kept in the Controller's state directory and stay valid across Controller restarts: a shared Codex daemon keeps loaded threads, with their environment, while the Controller restarts, and resuming such a thread does not apply new configuration. The socket path is stable for the same reason: it is derived from the state directory, not the process.

A session created by the Controller has no native identity before creation (Codex assigns thread ids). Its token is issued before creation and bound to the native identity once the session returns.

### Reaching the socket from a sandbox

Each provider needs three things: the environment reaches shell commands, the shell may connect to one Unix socket, and the CLI runs.

| Provider | Environment | Socket |
|---|---|---|
| Claude Code | per-session `env` of the SDK `query` | `sandbox.network.allowUnixSockets: [<real path>]` as a flag setting. Flag settings merge with the user's and the Controller's sandbox: they neither enable nor disable a sandbox. |
| Codex | thread configuration `shell_environment_policy.set.<NAME>` on `thread/start` and `thread/resume` | Where the Controller imposes the sandbox (restricted Host, read-only sessions), a permission profile replaces the `sandbox` parameter: `permissions.agent-remote = { extends = ":workspace" or ":read-only", network = { enabled = true, unix_sockets = { "<path>" = "allow" } } }`, `default_permissions = "agent-remote"` and `features.network_proxy = true`. Where the user's own configuration decides the sandbox (trusted shared Codex, the default), nothing changes: commands in a sandboxed user configuration need the user's approval to escalate. |
| Copilot, OpenCode | one runtime process serves every session, so a per-session environment is impossible | unsupported in milestone 1 |

Codex details, from the spike:

- With network disabled, Seatbelt denies `connect()` to every Unix socket. The only per-path allowance reachable from `thread/start` is the managed network proxy's `unix_sockets`, which requires network to be enabled in the profile. With `features.network_proxy`, enabled network means: direct connections are still denied, and HTTP and SOCKS traffic goes through a local proxy that allows no domain. So the profile adds exactly one socket. Without the feature, an enabled network is the whole internet; the Controller therefore only uses the profile on Codex versions it verified (0.166.0 or newer, macOS).
- The `sandbox` parameter wins over `default_permissions`, so the profile is only effective without it.
- The thread reports `sandboxPolicy.networkAccess: true` and about 30 proxy variables in the shell environment; the session settings describe network as blocked except the Controller socket.
- Configuration overrides are not written to the rollout or state databases; a thread resumed later without them falls back to the user's defaults.
- Variables set this way survive Codex's default exclusion of names containing `TOKEN`.

Claude details: the sandbox matches the real path (`/private/tmp/...`, not `/tmp/...`), so the Controller resolves the socket directory before passing it.

## Authorization (milestone 1)

- The caller must present a token the Controller issued, for a session on this Host that was not created by a share recipient.
- Targets are this Host's sessions, through providers that are enabled, excluding sessions created by share recipients.
- Read access covers every such session of the Host owner. The Host owner already reaches them in the website; the CLI gives the owner's agents the same view on the owner's own machine. On a Host with a workspace execution policy (`execution-policy.ts`), reading follows the same rule as opening: only sessions in allowed workspaces.

### Share recipients

A share recipient creates sessions on the owner's Host through the Relay and sees only those sessions. Their sessions must neither use the CLI nor be visible through it.

- The Relay adds `shared: true` to the `/remote/create` and `/remote/attach` requests it forwards for a share recipient's session (`broker.ts`, `mutate` and `recoverBinding`). Old Controllers ignore the field.
- The Controller records those native sessions in its state directory, revokes their tokens, issues them none afterwards, and hides them from `list` and `read`.
- Sessions a recipient created before this change are marked the next time the recipient opens them. Until then they are visible to the owner's agents, which the owner can see anyway.
- The website must be deployed before a Controller relies on the flag.

## Command grammar (milestone 1)

```
agent-remote-controller session list [--provider P] [--limit N] [--cursor C]
agent-remote-controller session read <address|self> [--limit N] [--cursor C] [--search Q] [--turn T] [--text-offset N]
```

`list` prints `{ sessions: [{ address, providerId, title, cwd, updatedAt, state, self? }], nextCursor? }`, newest first, at most 50 per page. `state` is `running`, `waiting`, `idle`, `failed` or `unknown`; `self: true` marks the caller.

`read` prints `{ session: { address, providerId, title, cwd, model, state, self? }, entries, nextCursor? }`. Entries follow `read_source_session`: newest first when reading, chronological when searching, at most 10 per page and 6000 characters per entry, continued with `--text-offset`. `read self` replaces a `whoami`.

Errors print `{ error: { code, message } }` and exit non-zero:

| Code | Exit | Meaning |
|---|---|---|
| `no_session_identity` | 3 | not a Controller-managed session, an unsupported provider, or a revoked token |
| `controller_unreachable` | 4 | the socket cannot be reached: the Controller is stopped, or a sandbox blocks the socket |
| `session_forbidden` | 5 | the target is outside the caller's access |
| `session_not_found` | 6 | no such session on this Host |
| `invalid_request` | 2 | malformed arguments |
| `history_unavailable` | 1 | the provider could not read the session's history |

## Skill

One `SKILL.md`, packaged with the Controller in Claude Code's plugin layout (`skills/agent-remote/` with `.claude-plugin/plugin.json` and `skills/agent-remote-sessions/SKILL.md`):

- Claude Code receives it per session as a local SDK plugin, only for sessions that also receive a token.
- Codex has no per-thread skill mechanism; the Codex adapter installs `$CODEX_HOME/skills/agent-remote-sessions/SKILL.md` when it first starts a session with a credential, then makes Codex reload its skill list (Codex caches it: a skill added while it runs stays invisible until `skills/list` with `forceReload`). The skill tells the agent that the commands work only in Controller-managed sessions, recognizable by `AGENT_REMOTE_SESSION_TOKEN`.
- Copilot and OpenCode get no skill in milestone 1.

## Milestones

1. **Identity, discovery, read** on the session's own Host: tokens, the session socket, `session list`, `session read`, the share-recipient flag, the skill, Claude and Codex.
2. **Send, create, close**: `session send` with receipts and delivery between turns, reusing Team delivery; `session create` and `session close` within a policy.
3. **Groups**: `group list|read|create|close|add|remove`, labels, created and joined members, stored as Relay records.
4. **Across Hosts and modes**: list, read and send through the Relay to other Hosts of the account; Team, Call For Support, TPM and Side rewritten as skills plus policy templates; their tools retired.

## Limitations of milestone 1

- Sessions the Controller did not start or resume (a native terminal session, a thread loaded by another Codex client) have no token until the Controller resumes them.
- Forks for prompt edits and native-prefix successors receive a token on their next attachment, not at creation.
- Codex sessions sandboxed by the user's own configuration reach the socket only through an approved escalation.
- Sandboxed Codex sessions on Linux and Windows are not verified and get no socket allowance. Claude Code's `allowUnixSockets` was verified on macOS only; on Linux its sandbox may still block the socket.

## Evidence

Codex 0.166.0 (macOS, Seatbelt), a fixture model issuing shell commands through a real `codex app-server`:

| Configuration | Socket | Internet through proxy | Direct internet | Workspace write | Variable |
|---|---|---|---|---|---|
| `sandbox: workspace-write` | EPERM | blocked | blocked | yes | yes |
| profile `:workspace` + socket + `network_proxy` | connected | denied by proxy | blocked | yes | yes |
| `sandbox: read-only` | EPERM | blocked | blocked | denied | yes |
| profile `:read-only` + socket + `network_proxy` | connected | denied by proxy | blocked | denied | yes |
| profile and `sandbox: workspace-write` together | EPERM | blocked | blocked | yes | yes |
| started plain, resumed with the profile | connected | denied by proxy | blocked | yes | yes |
| started with the profile, resumed plain | EPERM (user default) | blocked | blocked | per default | no |

`codex sandbox` checks: `network.allow_unix_sockets` alone has no effect; a profile with network enabled but without `network_proxy` allows the socket and the whole internet.

Claude Code 2.1.247 with Agent SDK 0.3.247, a fixture model issuing Bash commands:

| Sandbox | Socket (`/tmp` path) | Socket (real path) | Variable |
|---|---|---|---|
| restricted (Controller) | EPERM | connected | yes |
| read-only (Controller) | EPERM | connected | yes |
| YOLO (none) | connected | connected | yes |
| the user's own sandbox, flag with only `network` | — | connected, sandbox still enforced | yes |
| no sandbox, flag with only `network` | — | connected, no sandbox enabled | yes |
