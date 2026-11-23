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

- The Team roster loads in the workbench, not in the Teams panel.
- Decided with the owner (2026-11-23): a Team's Leader becomes a bot, the chief of the members shown in its group, which become
  standing bots, its staff, with the Leader recorded as their chief. Members never shown stay plain sessions. Team inboxes and messages are
  dropped. Rooms already show in Chats.
- Deleted: the Team queue, inbox, `team_message`, the Teams panel and launcher; E7's Team case rewritten on bots.

## 7d. TPM

- Decided with the owner (2026-11-23): history only. A TPM becomes a standing bot whose mission is its work; its intents stay
  readable in its conversation and are not carried into work items. Tracking work need not be the work items: a goal tool or other
  tools may serve later.
- Deleted: `tpm_intent`, TPM delivery, workspace, launcher, the companions' heartbeat; TPM tests rewritten on bots.

## Checks

Each sub-step: unit suites of what it touches, `pnpm build`, `pnpm arch:check`, the E15 flows. At the end of the step: `pnpm verify`,
components, preview, both e2e browsers, and `pnpm test:bots` with Claude Code and Codex.
