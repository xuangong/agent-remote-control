# Bot workbench
Module: `agent-remote-lab/src/features/windows/bot-workbench.ts` (the projection), `bot-workbench-binding.ts` (bind, unbind, create, open), `bot-workbench-teams.ts` (the model from the Teams), `workbench-expansion.ts`; the page: `app/useBotWorkbench.ts`, `app/views/derivedWorkbenchTiles.tsx`, `BotWorkbenchBody.tsx`, `WorkbenchHeader.tsx`, `WorkbenchLedger.tsx`, `WorkbenchOverview.tsx`, `WorkbenchPhone.tsx`, `BotWorkbenchProvider.tsx`; `kernel/team-roster-store.ts`. Design: `docs/superpowers/specs/2026-11-28-bot-workbench-design.md`.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 14 | 0 | 13 | 1 |

## Purpose
- B1. A Window is a free workbench (any sessions, arranged freely) or a bot workbench: a free workbench bound to one bot that also shows the bot's work. The only stored fact of the binding is a tag on the main tile, `feature { kind: 'bot', id }` with a managed binding; nothing else about it is stored.

## Inputs and outputs
- B2. The binding is the first primary view tagged for a bot; a second tagged view is an ordinary one. (Tests: `bot-workbench.test.ts`; the contract fixture `window-bot-workbench.v1.json` through the protocol, Relay store and page.)
- B3. The tiles are a pure function of the Window, the bot's main session (its inbox seat, else the tile's binding), the Teams and this device's expanded set. A session is one tile: a stored tile wins over a derived one and carries its state. (Tests: `bot-workbench.test.ts`, `bot-workbench-teams.test.ts`.)

## States and transitions
- B4. Derived tiles stand in the order needs you, working, idle, oldest start first, after the stored tiles; all folded until the person expands one; nothing expands itself. Ended sub-sessions fold into one Ended group (the last 10); the person's own sides carry the mark and do not count toward the bot's limit. (Tests: `bot-workbench.test.ts`; `bot-workbench.spec.ts`.)
- B5. A sub-session starting or ending never writes the Window; only a person's act does (keeping a tile, adding, binding, unbinding, opening a native subagent from a derived tile). (Tests: `useBotWorkbench.test.tsx`; `bot-workbench.spec.ts`; `e17-bot-workbench.e2e.ts`, which compares the Window's revision.)
- B6. A tile the person is using (selected) is held: it keeps its slot when the others reorder, an ended held tile stays marked ended until the person leaves it, and the rail does not move it on screen. (Tests: `bot-workbench.test.ts` hold rule; `bot-workbench.spec.ts`, which measures the tile's position; mutation checked by removing the rule.)
- B7. Bind tags the tile that shows the bot's main session (or adds one) and puts it first, keeping every other view; unbind removes the tag and keeps the main tile, the stored tiles and the derived tiles the person had expanded. Opening a bot's workbench finds the one this device used last, else creates `wb-<botId>` (a taken id gets a random one), shown in Window mode only. (Tests: `bot-workbench-binding.test.ts`, `useWindowWorkspace.bot.test.tsx`, `BotWorkbenchSheets.test.tsx`, `WindowToolbar.test.tsx`; `e17`, bind and unbind.)
- B8. The Answers group lists the bot's open answer sessions; a row opens one as a read-only tile. Ended tiles are read-only. (Tests: `bot-workbench.test.ts`, `useBotWorkbench.test.tsx`, `bot-workbench.spec.ts`.)

## Limits
- B9. Derived tiles are not stored, so they do not count toward the 64 views of a Window. The device keeps at most 64 expanded ids and 300 last-read Teams. (Tests: `workbench-expansion.test.ts`, `team-roster-store.test.ts`.)

## Errors and refusals
- B10. An unknown list is drawn as reserved space, never as an empty-state sentence: the model is not loaded until the Teams are, and the ledger draws nothing until its board is known. A bot that no longer exists leaves a workbench with the main tile and no derived tiles. (Tests: `bot-workbench.test.ts`, `WorkbenchLedger.test.tsx`.)

## Guarantees
- B11. The header names the bot, what needs the person, its chief and staff (each opens that bot's workbench) and "Open in chat"; the ledger beside the rail links an item's owner to its tile (a staff bot's to its workbench). (Tests: `WorkbenchHeader.test.tsx`, `WorkbenchLedger.test.tsx`, `bot-workbench-teams.test.ts` owner target; `e17`, ledger.)
- B12. On a phone the workbench is a list (main, needs you, working, idle, added, Answers and Ended folded, Ledger); a row pushes its conversation full screen and Back returns to the list. (Tests: `phone-bot-workbench.spec.ts`; `e17` phone flow in Chromium and WebKit.)
- B13. The sub-sessions, inboxes and answer sessions last read are kept on the device (inside the recovery records the cache setting clears), so the workbench draws at launch before the Relay answers. (Tests: `team-roster-store.test.ts`.)
- B14. A conversation of a tile keeps its reading position and draft as any conversation does (per session), and only the visible mode holds its composer. Not tested at this tier: the live check on a real Claude Code bot showed the tiles, folds, ledger focus, staff switch and phone list working but did not measure reading positions across folding; the edge swipe is the navigation stack's N12, device only.

| Clause | Test(s) that prove it |
|---|---|
| B1, B2 | `bot-workbench.test.ts`, `window-groups.test.ts`, `window-workspaces.test.ts` (fixture) |
| B3 | `bot-workbench.test.ts`, `bot-workbench-teams.test.ts` |
| B4 | `bot-workbench.test.ts`, `bot-workbench.spec.ts` |
| B5 | `useBotWorkbench.test.tsx`, `bot-workbench.spec.ts`, `e17-bot-workbench.e2e.ts` |
| B6 | `bot-workbench.test.ts`, `bot-workbench.spec.ts` |
| B7 | `bot-workbench-binding.test.ts`, `useWindowWorkspace.bot.test.tsx`, `BotWorkbenchSheets.test.tsx`, `WindowToolbar.test.tsx`, `e17` |
| B8 | `bot-workbench.test.ts`, `useBotWorkbench.test.tsx`, `bot-workbench.spec.ts` |
| B9 | `workbench-expansion.test.ts`, `team-roster-store.test.ts` |
| B10 | `bot-workbench.test.ts`, `WorkbenchLedger.test.tsx` |
| B11 | `WorkbenchHeader.test.tsx`, `WorkbenchLedger.test.tsx`, `bot-workbench-teams.test.ts`, `e17` |
| B12 | `phone-bot-workbench.spec.ts`, `e17` |
| B13 | `team-roster-store.test.ts` |
| B14 | not tested at this tier (live check) |
