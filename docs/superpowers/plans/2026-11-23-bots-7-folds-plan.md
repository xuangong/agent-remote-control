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
4. **7d TPM.** TPMs are removed entirely; a TPM's native session stays a plain session, its history readable.

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
- Decided with the owner (2026-11-23, revised 2026-11-24): ordinary Teams are dropped, not converted. Data loss is acceptable and no
  compromise approach is built: no conversion of a Leader into a chief or of members into staff, no transition code for older peers.
  Rooms already show in Chats. Vocabulary: chief / staff (zh 主管 / 成员).
- Deleted: the Team queue entry points (`send`, `acknowledge`, `describe_member`, `report`, the registration message), the actions that made
  or changed an ordinary Team (create, `add_member`, `retry_creation`, `abandon_creation`, `rename`, `archive`, `restore`,
  `resolve_message`), the Controller's seats and tools for them (`read_team`, `acknowledge_team_messages`, `send_team_message`,
  `report_team_progress`, `describe_team_member`, the two resource tools), the `teamInbox` negotiation, the Teams panel and launcher, the
  gather button, Team layout and view binding, the `/team` command, Team attributions and Track's "Main:" line, and their tests.
  `TeamCreate` now carries a bot (`/side`); that is the only way a Team is made by the person.
- Kept: `Team` as the delivery substrate of tasks, inboxes, links and rooms, with its queue, claim, settle, presence, receipts and budgets,
  and `read` for the Controller's own receipts. `isTeam` accepts only those four shapes.

### Old state

`migrateRelayState` (`legacy-teams.ts`) drops what the build no longer has when state loads, and converts nothing:

- every Team with none of task, link, inbox or room (`isOrdinaryTeam`; state validation lets it pass so it can be dropped);
- the `team` tag and the managed binding of every Window view that carries one; the view stays a plain session;
- the file-transfer fields of a Team (`resourceUploads`, `resourceGrants`, message `resources`).

Idempotent: the state loads unchanged afterwards. Test: `legacy-teams.test.ts`. The lab kernel reads a view saved with a `team` tag as an
ordinary view and imports old local compositions without their Team fields. An older Controller that sends a removed call is refused by
the ordinary uplink validation; nothing special is built for it.

### Also done

- File transfers are gone: the Relay resource store, the `resource_begin/chunk/finish/metadata/read` Host calls, `resourceUploads` and message
  `resources` on a Team, the `teamResources` uplink negotiation, the Cloudflare storage (`team-resource-storage.ts`), and their tests. The
  delivery fingerprint still hashes an empty attachment list, so stored receipts keep matching.
- The lab kernel has no managed Team windows: no `gather`, no `open`, no `teamId` / `teamMemberId` on entries, slots or targets, no feature
  kind `team`, no Team roles in the roster, no `team` flag on a session view.
- A bot's inbox seat is covered by a prefix-handoff test (`bot-seat-succession.test.ts`), for the requester seat bound in place and the leader
  seat the Controller created for a standing bot.
- The Relay tests' Team fixtures are links, since the ordinary shape is not a Team.

### Left for later

- The App-level attribution navigation tests (`App.attributions.test.tsx`) used a Team as the relation; `session-attribution-navigation.test.ts`
  keeps the window operations.
- E7's Team case became "a temporary bot a bot started survives a Controller restart and still reports to its chief"; E15 did not cover a restart.

### Leftovers, done (2026-11-24)

- The recipient-unaware paths of the Team broker are gone: every delivery names its exact recipient, and the `teamRecipients` negotiation
  (uplink offer, `registered` field, `x-arc-team-recipients` header, `team_recipients_upgrade_required`) went with them. `teamSuccession` stays
  its own negotiation. An older Controller or page is updated; nothing special refuses it.
- The Cloudflare Relay drops `relay_team_resource_chunks` when its storage opens. A Node Relay no longer references its
  `<state file>.resources` directory; it is not read or deleted, so a stale one stays on disk until the person removes it.
- `docs/current/agent-remote/call-for-support.md` is deleted; the README intro and the command line help name bots, not Team, support or TPM roles.

## 7d. TPM (as built)

- Decided with the owner (2026-11-23, revised 2026-11-24): TPMs are removed entirely, not folded into bots. A TPM's native session stays a plain
  session and its conversation stays readable; it is not converted into a bot, and its work record, todo and intents are not carried anywhere.
  Tracking work may be served later by a goal tool or other tools.
- Deleted, protocol: `tpm.ts` (`TpmWork`, `TpmIntent`, `TpmCreate`, `TpmAction`, `TpmList`), the `tpm` Host paths and the `tpmManagement`
  registration field of the uplink, the `tpm` kind of a succession participant, and `session-todo.ts` (the todo list was TPM's only consumer).
  The frozen legacy Team codecs of `agent-remote-protocol/testing` went too: they only checked a current peer against an older one.
- Deleted, Relay: the `/v1/remote/hosts/<id>/tpm` routes and `tpmManagement` on a Host.
- Deleted, Controller: `TpmCoordinator`, the TPM store and role, TPM routing of a succession (`session-succession-tpm.ts`), the todo and
  heartbeat toolkits and background reviews (`session-todo.ts`, `session-heartbeat.ts`, `session-background.ts`), the `/remote/tpm` routes, the
  `tpm` Host option and its `tpm-v1` state directory, the TPM role of a handoff, the recovery admissions of a TPM creation in the succession store
  (`settleRecoveredAssociation`, `AssociationRecovery`), and the TPM tests.
- Deleted, client and lab: the TPM workspace, menu, launcher, visibility command and storage keys, the TPM work and main-session hooks, the TPM
  role label, the todo panel (`SessionTodoPanel`), the client's `RemoteHostControlClient` (only TPM used it), the debugger's `tpm` command, and
  the TPM component fixtures and specs.
- Old state is dropped when it loads, nothing is converted. The Relay drops the `tpm` tag and managed binding of a Window view (the view stays a
  plain session) with the `team` ones (`legacy-teams.ts`), and the TPM participants of the receipts of earlier handoffs
  (`migrateBrokerAssociations`). The Controller's succession store drops TPM participants from its roles and prepared handoffs, and the admissions of
  a TPM creation. The TPM state directory of a Controller stays on disk, unread. The lab reads a saved view with a `tpm` feature as an ordinary view.
- Tests: the TPM suites went with their code. Where a test only used TPM as an example (succession fixtures, participants, role extensions) it
  uses a Side, an Ask or a role extension. The prefix-handoff test of a TPM's tools (`native-prefix-role-runtime.test.ts`) went with TPM; the
  bot seat is covered by `bot-seat-succession.test.ts`. No e2e flow of `packages/agent-e2e/flows` covered TPM, so none changed. Component specs
  that only ran on the TPM fixture went (`tpm-dock`, `session-attributions-layout`, the Ask-and-TPM title test of `dock-title-interactions`).

## Checks

Each sub-step: unit suites of what it touches, `pnpm build`, `pnpm arch:check`, the E15 flows. At the end of the step: `pnpm verify`,
components, preview, both e2e browsers, and `pnpm test:bots` with Claude Code and Codex.
