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
