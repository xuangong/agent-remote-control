# Bots step 7: fold the older features

Step 7 of the [bots plan](2026-11-23-fold-into-assistants-plan.md), for section 9 of the
[bots design](../specs/2026-11-23-bots-design.md). Each fold moves what the feature does onto bots, migrates what the person has, and
deletes the old path in the same branch. Ask and quoting stay.

## Order

Smallest and least shared first, so each fold leaves less for the next:

1. **7a Side.** A Side becomes a temporary bot the person starts.
2. **7b Call For Support.** Support becomes a bot asking the bot whose mission fits. The bots' tools and enablement, which ride on
   the support enablement today, move to a bot enablement of their own first.
3. **7c Team.** A Team becomes a chief and its bots. The page's Team roster loading, which the task directory, rooms and work
   items read, moves out of the Teams panel before the panel goes.
4. **7d TPM.** A TPM becomes a bot whose mission is its work, with work items, todo and confirmations; the companions' heartbeat goes.

## 7a. Side

- `/side <text>` asks the Relay to start a temporary bot on the staff of the bot on screen (`start_bot`, a Team action of the person,
  owner = that bot's session, mission = the text, workspace `same`), and opens it beside its chief as any temporary bot.
- Existing Side views stay where they are, as ordinary bots of their group: they lose the Side role and relation, nothing else.
- Deleted: Side creation (`/side` fork path), Side relations and their page state (selection, anchors, unlinking, navigation).
- Tests: the Relay starts a temporary bot for the person; the page's `/side` creates one; the Side unit tests go; an E15 case.

## 7b. Call For Support

- Bot enablement moves from `support_enablement` to `bot_enablement` (bots and their tools), with the Controller asking for it.
- Profiles are not migrated: Settings says once that support became bots, then the setting goes.
- Deleted: profiles, enablement, support groups, calls, rosters, ledgers, report framing, the four tools, `callForSupport`,
  `readOnlyProvider`, the support panel and settings, and their tests.
- Gate: a bot asks the bot whose mission is reviewing to review an uncommitted change it reads through the shared repository.

## 7c. Team

- The Team roster loads in the workbench, not in the Teams panel (`kernel/useTeamRoster.ts`): tasks, rooms and the inboxes that carry work
  items read it. It refreshes twice a minute, and every 4 s while a room is open.
- Decided with the owner (2026-11-23): a Team's Leader becomes a bot, the chief of the members shown in its group, which become
  standing bots, its staff, with the Leader recorded as their chief. Members never shown stay plain sessions. Team inboxes and messages are
  dropped. Rooms already show in Chats. Vocabulary: chief / staff (zh 主管 / 成员).
- Deleted: the Team queue entry points (`send`, `acknowledge`, `describe_member`, `report`, the registration message), the actions that made
  or changed an ordinary Team (create, `add_member`, `retry_creation`, `abandon_creation`, `rename`, `archive`, `restore`,
  `resolve_message`), the Controller's seats and tools for them (`read_team`, `acknowledge_team_messages`, `send_team_message`,
  `report_team_progress`, `describe_team_member`, the two resource tools), the `teamInbox` negotiation, the Teams panel and launcher, the
  gather button, Team layout and view binding, the `/team` command, Team attributions and Track's "Main:" line, and their tests.
  `TeamCreate` now carries a bot (`/side`); that is the only way a Team is made by the person.
- Kept: `Team` as the delivery substrate of tasks, inboxes, links and rooms, with its queue, claim, settle, presence, receipts and budgets,
  and `read` for the Controller's own receipts. `isTeam` still accepts an ordinary Team's shape, so an older Relay's state loads and migrates.

### Migration

`migrateRelayState` (`legacy-teams.ts`, after the bot records of earlier builds) removes every Team with none of task, link, inbox or room.
For each, the Window views tagged with its id (`feature.kind` `team`) lose the tag and the managed binding; if the group appears in Bot mode
(a group without a section gains one), each of them becomes a standing bot (record made with `reconcileBots`, id `migrationBotId`): the
Leader's view named by the Team's title, the others by the member's name with its responsibility as the mission. The Leader's bot is then
recorded as `chief` of the others; with no Leader view in a group, the staff stay the person's. Members with no view stay plain sessions.
A group hidden in Bot mode only loses the tags; its views are not made bots. The bots get their inbox Teams from the Controller's
`bot_enablement`, as any standing bot does. The run is idempotent: the Teams are gone afterwards. Tests: `legacy-teams.test.ts`.

### Left for later

- Resources: only ordinary Teams used them (the upload and download tools, `send` attachments, the two Hosts' transfers). Their Relay store,
  `resource_*` Host calls, `teamResources` negotiation and Cloudflare storage still exist with no caller; removing them touches the uplink
  protocol and every Relay, so it is its own step.
- The kernel keeps its handling of managed Team windows (`gather`, `teamId` and `teamMemberId` on session entries, feature kind `team`), which
  nothing creates now.
- Controller tests that used an ordinary seat to prove role succession (`team-prefix`, `team-generic-succession`, the `team` roles of
  `native-prefix-role-runtime`) were removed with it; the bots' seats are covered by the dispatch, injection and E15 tests, but not by a
  prefix-handoff test of their own.
- The App-level attribution navigation tests (`App.attributions.test.tsx`) used a Team as the relation; `session-attribution-navigation.test.ts`
  keeps the window operations.
- E7's Team case became "a temporary bot a bot started survives a Controller restart and still reports to its chief"; E15 did not cover a restart.

## 7d. TPM

- Decided with the owner (2026-11-23): history only. A TPM becomes a standing bot whose mission is its work; its intents stay
  readable in its conversation and are not carried into work items. Tracking work need not be the work items: a goal tool or other
  tools may serve later.
- Deleted: `tpm_intent`, TPM delivery, workspace, launcher, the companions' heartbeat; TPM tests rewritten on bots.

## Checks

Each sub-step: unit suites of what it touches, `pnpm build`, `pnpm arch:check`, the E15 flows. At the end of the step: `pnpm verify`,
components, preview, both e2e browsers, and `pnpm test:bots` with Claude Code and Codex.
