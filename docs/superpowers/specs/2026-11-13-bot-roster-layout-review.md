# Bot roster layout review

Status: proposed, awaiting user review. No functional-layout changes have been implemented.

This review narrows the next step of the approved modernization design. The user requested advance review before changes to functional layout, including desktop and phone. Reference research: [agent workbench design references](../../investigations/2026-11-13-agent-workbench-design-references.md).

## Protected Session View boundary

The user explicitly requires preserving the existing Session View. Do not redesign its messages, tool activity, reasoning, approval cards, composer or internal conversation layout. Only targeted small fixes for confirmed problems are permitted. This supersedes the older phase 3c conversation/composer redesign and any phase 4 plan to restyle Session View. Modernization concerns the surrounding navigation and management surfaces. Functional-layout changes still require advance review.

## Current structure

- Desktop: a 260px Bot sidebar and a conversation area; the shared mode switch, Search and New section sit at the top.
- Sections show all visible members. Pins sort within their original section.
- Each row may show title, label, raw Host ID, provider and a textual status.
- Other sessions and each provider's Refresh controls appear in the same list without a collapsed summary.
- Compact mode already has a roster/conversation navigation stack and Back. The current compact breakpoint is 1180px.

The local baseline screenshots at `.tmp/ui-modern-3a/baseline-desktop-bot.png` and `baseline-phone-bot.png` show the initial empty/loading directory state, not a populated workflow or end-to-end session acceptance.

## Proposed next layout

| Area | Proposed change | User-visible effect |
| --- | --- | --- |
| Pinning | A Pinned section before ordinary sections. Each pinned Bot is shown once; its membership in the original section is retained as metadata. | A stable place to find frequently used Bots across sections. |
| Sections | Collapsible headings with counts. Existing section order remains stable. | Large rosters can be reduced without hiding the group itself. |
| Row | Avatar, title, one secondary line and one status accessory. Known Host names replace raw IDs in ordinary labels; full IDs stay available for disambiguation. | Less visual noise while retaining identity and urgency. |
| Row actions | An explicit ellipsis button, with keyboard and desktop context-menu access. Actions do not select the conversation. | Secondary actions are discoverable on phones and do not crowd the row. |
| Other sessions | Initially collapsed with a count. Refresh/source details stay reachable within its own controls. | Directory management no longer dominates the default Bot list. |
| Hidden Bots | A collapsed, counted section with an explicit restore action. | Hiding a Bot is reversible without searching in a separate settings screen. |
| Desktop | Preserve the existing sidebar and conversation areas. | No new permanent panel and no reduction of the main conversation beyond the current sidebar. |
| Phone | Use the same hierarchy in a full-width list. Opening a Bot keeps the existing full-screen conversation and Back behavior. | No desktop multi-panel layout squeezed onto a phone. |

## Attention and ordering

Keep stable list order while activity changes. Do not constantly move a row under the pointer. The single row status follows the approved priority: needs you, failed, working, new result. A pending-request count appears only if the existing runtime data actually contains that count; a coarse waiting state must not be presented as a fabricated number.

A separate Needs you inbox, status-based automatic grouping, bottom navigation, new breakpoint bands and relocation of the Window/Team/TPM floating controls are not part of this proposal. Each would receive its own review.

## What can proceed without this layout approval

- The already authorized Window deletion confirmation and stale attribution-test correction.
- Fixing confirmed clipping, overlap and unusable spacing without moving a function to another surface.
- Research, baseline captures and a concrete visual prototype for the proposed layout.

## Interactive proposal

Open [the standalone HTML preview](../../design-previews/2026-11-13-bot-roster-review.html). It uses sample data only and makes no backend calls. Resize it to compare the desktop sidebar and phone roster; section toggles, row selection and phone Back illustrate navigation. Conversation content and menus are placeholders, not proposed final copy or completed functionality.

## Review decision

Approve or revise the new Pinned/Hidden groups, collapsed sections/Other sessions, and row action placement before implementation. The current approved visual language, backend boundaries and session ownership remain the basis of the work.
