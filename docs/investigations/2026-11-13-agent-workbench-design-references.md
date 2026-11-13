# Design references for the agent workbench

Observed on 2026-11-13. This is a focused review of official documentation and public product imagery, not hands-on acceptance of authenticated competitor apps. Public pages and screenshots are retained under `.tmp/ui-modern-3a/research/` in the implementation worktree. Search returned unrelated results and its fetch provider was unavailable; the cited official URLs were fetched directly and the public sites were opened in headless Chromium.

## Findings and proposed application

| Product | Evidence from the product | Application to Agent Remote Control |
| --- | --- | --- |
| [Conductor workflow](https://www.conductor.build/docs/concepts/workflow) | A workspace collects one stream of work, with conversation, files, diff, checks and review. Finished workspaces move to History. [Parallel agents](https://www.conductor.build/docs/concepts/parallel-agents) distinguishes independent workspaces from agents sharing one branch. | Preserve Window as a coherent working context. Keep side conversations attached to their parent, make completed/hidden work easy to put away, and avoid giving every subordinate session equal navigation weight. |
| [Vibe Kanban interface](https://www.vibekanban.com/docs/workspaces/interface) | Its workspace list exposes running, idle and needs-attention states, pins and status grouping. Conversation is separate from optional changes/logs/preview and details panels. Panel visibility and sizes are remembered. | A compact, prioritized status per Bot row; clear grouping and counts. Keep conversation space primary, reveal diagnostics or Threads when requested. A four-panel desktop layout should not be carried unchanged to a phone. |
| [Happy Mobile Access](https://happy.engineering/mobile/) | Its phone client supports messages, permission answers, stopping a turn, model choices and reading files/Git changes while agents remain on the host. A saved pairing is distinct from live connected status. The public home image shows Bots and Tasks organized in a narrow left rail on desktop and a list on phone. | Make the phone's core loop fast: find the session needing attention, read context, answer, and return. Keep Host names human-readable and show connection state honestly. Put secondary controls behind an explicit menu instead of compressing them into the conversation header. |
| [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) | A browser or mobile client continues a local session, synchronizes conversation across devices, and reconnects after interruptions. Execution remains on the original machine. | Preserve the user's place and draft across navigation. Distinguish connecting, disconnected and active execution. Do not equate opening a row with having read its newest content. |

## Design decisions for the next milestone

These are our recommendations, not claims about competitor implementations.

1. Keep the approved opaque Apple-style surfaces and system typography. The useful references are navigation and attention management, not a new color palette.
2. A Bot row has an avatar, title, one secondary line and one prioritized status. Long titles and labels truncate within the row; action controls retain usable width.
3. Pinning forms a dedicated section. Ordinary sections retain their order. Other sessions starts collapsed with a count. Hidden Bots is discoverable without crowding the default list.
4. Needs attention takes priority over failed, working and new result. Never invent a pending-request count from a coarse state or infer new results from native directory timestamps.
5. Use known Host names in secondary metadata; retain full identity in details or a tooltip for disambiguation. Missing metadata must have an honest fallback.
6. Desktop menus may be anchored or open at the pointer; phone actions must remain reachable through an explicit button. Opening a menu must not also select or navigate the row.
7. On phones, display one main surface at a time and preserve back navigation. Do not use page-wide horizontal scrolling to accommodate a desktop layout.
8. Treat mobile layout problems discovered during any phase as current work, not automatically postponed to phase 5. The full navigation/tab-bar redesign remains a separate milestone.

## Layout acceptance checklist

- Inspect 1440x900, 1024x768, 768x1024, 390x844 and 320x740. Check light and dark on the primary desktop and phone sizes.
- Include long English titles, Chinese titles, long Host names, empty sections, many rows and all supported statuses.
- No unintended document-level horizontal scroll, overlapping action targets, hidden primary actions or text under floating controls.
- Verify pointer and keyboard menu interaction, Escape/back behavior, focus return and conversation/draft preservation.
- On touch layouts aim for 44px action targets; allow labels to truncate before shrinking controls.
- Measure switching using the same fixed fixture before and after. Keep browser/component evidence separate from real-provider evidence.

## Protected Session View

After reviewing the direction, the user explicitly ruled out redesigning Session View; it is already well refined. Preserve the existing conversation, tool, approval and composer presentation. Apply the research to outer navigation and management surfaces; allow only targeted small Session View fixes. Functional-layout changes require advance user review.

## Scope and cautions

The next implementation follows the approved modernization phases. A kanban board, cloud sandbox service, issue tracker and new account architecture are not needed to adopt these interaction patterns. Vibe Kanban's homepage currently announces its sunset and continued community maintenance; it is a useful design reference, not a recommended new runtime dependency.
