# Bots step 10: bots that know their Hosts

Decided with the owner on 2026-11-25. Bots on a team may not care where each of them runs, but it matters: which CLIs a Host has,
how loaded it is, and which folder a bot works in. A bot chooses, guided by what the Hosts report.

## Decisions

1. **Process resources on request.** A Host's status, read on request as today (no periodic report, no history), also lists what
   its Controller runs: each session's native process tree (CPU and memory), the Controller itself, the Codex daemon, OpenCode and
   MCP servers. Owner only, as machine figures are today.
2. **A folder, chosen or created.** No project identity (no git remote matching). When a bot creates a bot on a Host, it picks
   one of that Host's folders or creates a new folder under one of its workspaces; the bot keeps a team's folders aligned by their
   names and purpose.
3. **The bot chooses the Host.** Guidance, not a rule: the base instructions say how to choose, and the choice and its reason go
   on the board item it serves.

## 10a. Process resources in the Host status

- `HostStatus` gains `processes`: at most 32 entries `{ kind: session | controller | daemon | server, label, providerId?, session?,
  cpu (0..1 of one core summed over the tree), memory bytes (resident) }`, sorted by memory. Read with the status, never stored.
- The Controller reads its children's process trees on macOS, Linux and Windows (one `ps`/`wmic`-equivalent call per read,
  bounded time); a platform it cannot read leaves `processes` out.
- The page's Host details list the top entries ("what uses this machine"); shared viewers see none, as for machine figures.

### 10a as built

- `HostStatus.processes` (protocol `host-status.ts`): at most 32 `{ kind, label, providerId?, cpu, memory }`, largest memory first (the order is part of
  `isHostStatus`). `cpu` is cores' worth summed over the tree (1 is one full core, so it may exceed 1), not a 0..1 share. `session` is left out:
  the Controller does not know which process belongs to which session, so a tree is named by its command (`claude`, `codex`, `opencode`).
- Controller `host-processes.ts`: one bounded (5 s) `ps -axo pid=,ppid=,pcpu=,rss=,command=` on macOS and Linux, one PowerShell call on Windows (CIM
  process list joined with the per-process performance counters); any other platform, or a failure, leaves `processes` out. The Controller itself is
  one entry; each direct child is a tree summed with its descendants. Kind: Codex `app-server` is a daemon, MCP and `opencode serve` are servers, the rest sessions.
  A daemon that detached from the Controller (parent is not the Controller) is not listed.
- Relay: unchanged, `ownerOnlyHostStatus` already drops everything but the session counts for a shared viewer.
- Page: each online owner card lists the top 5 under "What uses this machine" (label, kind, CPU %, memory in MB or GB); no list for a shared viewer.

## 10b. Hosts and folders for bots

- `list_hosts` (bot tool): each Host of the account the bot's owner may use: name, online, providers, CPU usage and cores, memory
  used and total, sessions running, and its workspaces (roots) with their top folders (bounded, as the page's folder picker reads
  them).
- `create_bot` gains `host` (a Host from `list_hosts`) and `cwd` (an existing folder there) or `new_folder` (a name created under one
  of that Host's workspaces, through the existing folder creation path). Default: the chief's Host and working directory, as today.
- Board: the item a bot is created for records `host` and folder in its links; the person sees where each bot works.
- Base instructions (one short paragraph): stay on your Host unless the work needs a CLI it lacks or it is loaded (memory nearly
  full, CPU busy); then pick a Host from `list_hosts` that has the CLI and room, and a folder there that belongs to the same work, or
  create one; say why on the item.

## Tests

- Unit: the process reader on each platform with stubbed command output; `HostStatus` schema and owner-only filtering; `list_hosts`
  shape and limits; `create_bot` with `host` and `cwd`/`new_folder` (folder creation called once, refused folder reported as the
  outcome); board item links.
- Component: the Host details' process list on desktop and phone.
- E15: a chief lists Hosts and creates a bot on another Host's new folder (two scripted Hosts if the stack supports them, else the
  same Host with a new folder).
- Live: one `pnpm test:bots`-style run where a chief chooses a Host, recorded like the old-ways records.

## 10b as built

- Tool `list_hosts` (Controller `bot-tools.ts` to Relay `bot-calls.ts` `listHosts`, read by `host-places.ts` from each Controller when asked, never stored):
  `{ hosts: [{ id, name, online, providers, cpu?, memory?, sessions?, workspaces?: [{ path, folders: [path] }] }] }`. Bounds: 8 Hosts (online first),
  5 workspaces each, 20 folders each; only Hosts that run bots. A part a Controller does not answer is left out; an offline Host is listed without being asked.
- `create_bot` gains `host`, `cwd` and `new_folder: { name, under? }` (wire `newFolder`; `under` defaults to the Host's first workspace). A Host other than
  the caller's needs a folder. `cwd` is checked by the Host's folder browsing (its execution policy); `new_folder` is created through the existing
  `workspace-folders/create` path, once: a repeated `operationId` reuses the folder the first call made. A refusal (folder exists, not allowed, Host
  offline, worktree on another Host) is the tool's error and nothing starts. The Team seat carries the chosen `cwd` and Host; the Controller creates
  it there without reading its source session. A Team's `source` may now be on another Host than its worker (task) or seat (inbox).
- The item the bot is created for gets `host` (the Host's name) and `folder` (the path) links when a place was chosen, if the item has room.
- Base instructions: one bullet, `BOT_INSTRUCTIONS_VERSION` 10 to 11.
- Tests: process reader per platform, schema and ordering, owner-only filtering, the card (jsdom and the settings component spec on desktop and phone),
  `list_hosts` shape and bounds, `create_bot` with host and folder (once, refusal, item links, standing and temporary), the Controller's seat in a
  chosen folder, and E15 with a second paired Host. The live run where a chief chooses a Host is recorded in [the review](../reviews/2026-11-26-chief-chooses-a-host.md).
