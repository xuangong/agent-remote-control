# Team pages and the primary bot
Module: `agent-relay-core/src/bot-pages.ts` (pages on a bot's inbox), `bot-calls.ts` (`writePage`, `readPage`, `personSetPrimary`), `window-workspaces.ts` (`setBotPrimary`); the page: `agent-client-web/src/react/items/PageCards.tsx`, `agent-remote-lab/src/conversation/assistant/PagesList.tsx`, `PrimaryControl.tsx`; the tools: `agent-controller/src/bot-tools.ts`.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 8 | 0 | 8 | 0 |

## Purpose
- P1. A page is a markdown document a standing bot keeps with `write_page { title, contents, page_id?, team? }`: whole-document rewrites, at most 8000 characters of contents, 120 of title, 10 pages per bot, kept on the bot's inbox. Everyone of the account reads it with `read_page { page_id?, bot? }` (without a page id, the list); only the bot that holds it writes it, and a sub-session never does. (Tests: `bots.test.ts` with `pages.v1.json`, `bot-pages.test.ts`, `bot-tools.test.ts`.)
- P2. The team page is the page written with `team: true`: at most one per bot, the mark moving to the page marked last, and it stays on later rewrites. Nothing else decides it. (Tests: `bot-pages.test.ts`.)
- P3. A rewrite that changes nothing keeps the version and the time. (Tests: `bot-pages.test.ts`.)

## Guarantees
- P4. A team page shows as one card in the conversation of its bot and of its chief, read from the record, closed to its title and "Updated by <bot> <time>" and opened to the rendered table; a rewrite changes the card where it stands, keeps it open and adds no timeline entry. The bot's details list every page, read only. (Tests: `PageCards.test.tsx`, `task-directory.test.tsx`, `PagesAndPrimary.test.tsx`, `team-page.spec.ts` on desktop and phone, `e19-team-page.e2e.ts`.)
- P5. At most one bot of an account is primary, and only a bot whose chief is the person; the person marks it from the bot's details (`set_primary`), which replaces the mark in one Relay write, and moving the bot under another bot clears it. (Tests: `window-bots.test.ts`, `bot-pages.test.ts`, `PagesAndPrimary.test.tsx`.)
- P6. The primary bot's instructions carry one extra section, only its own; setting or clearing the mark changes the instructions hash, so the bots whose role changed are sent `[Your standing instructions · v15]` again. The Host starts the bot's session with the section too. (Tests: `bots.test.ts`, `bot-pages.test.ts`, `bot-tools.test.ts`, `e19-team-page.e2e.ts`.)
- P7. Chats lists the primary bot first, in the first section, with a Primary mark; `list_bots` shows which bot is primary. (Tests: `assistant-groups.test.ts`, `BotRoster.test.tsx`, `bot-pages.test.ts`.)

## Errors and refusals
- P8. A state stored before pages and the mark loads and commits again; a primary mark on a bot that reports to another bot is refused with "Only a bot that reports to you can be primary." (Tests: `storage-previous-answer-sessions-state.test.ts`, `window-bots.test.ts`.)

| Clause | Test(s) that prove it |
|---|---|
| P1 | `bots.test.ts`, `bot-pages.test.ts`, `bot-tools.test.ts` |
| P2, P3 | `bot-pages.test.ts` |
| P4 | `PageCards.test.tsx`, `task-directory.test.tsx`, `team-page.spec.ts`, `e18` |
| P5 | `window-bots.test.ts`, `bot-pages.test.ts`, `PagesAndPrimary.test.tsx` |
| P6 | `bots.test.ts`, `bot-pages.test.ts`, `bot-tools.test.ts`, `e18` |
| P7 | `assistant-groups.test.ts`, `BotRoster.test.tsx` |
| P8 | `storage-previous-answer-sessions-state.test.ts`, `window-bots.test.ts` |
