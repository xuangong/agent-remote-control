# Workbench function organization review

Status: discussion proposal, awaiting user review. No navigation or product behavior changes are authorized by this document.

## Purpose and constraints

The product helps a person continue, supervise and coordinate agents running on their own machines. Its organization should support complete working journeys, including returning to the original work after an interruption. Visual refinement must follow these responsibilities and their actual behavior.

Preserve the existing Session View, including messages, tools, reasoning, approval cards, composer and internal layout. Existing Session View controls remain in place. Only targeted small fixes for confirmed problems are permitted. Functional entry relocation, new groupings and changes to navigation require advance user review.

The earlier [roster proposal](2026-11-13-bot-roster-layout-review.md) is a partial exploration. Its Pinned/Hidden groups and menus are still unapproved. Resolve the whole-workbench questions here before turning that exploration into an implementation plan.

## Current product evidence

These observations come from the current worktree's implementation and product documentation, not usage analytics or an authenticated competitor evaluation:

- `BotWorkspace.tsx` provides a Bot roster and a retained conversation surface; its header plus creates a section. `bot-roster.ts` projects sections and members from Window groups and session bindings. Bot mode and Window mode are presentations of related underlying work, not independent runtimes.
- `App.tsx` supplies Window navigation, the current Window's views, All sessions, Favorites, Settings and movable Track/Team/TPM/Ask entries. Those entries move between desktop shortcuts and floating controls. Their visibility also depends on mode and feature settings.
- `App.tsx` builds the common command palette from actions, Windows, Bots and known sessions. Results have different destinations: a Bot opens Bot mode, whereas a session result opens through Window mode. Some settings/actions also enter Window mode.
- `SessionTrackingMenu.tsx` summarizes tracked background sessions. It is not evidence that every Bot, Team, TPM or native session is continuously observed. Counts and activity depend on the underlying observation scope.
- The README distinguishes ordinary sessions, saved Window layouts, contextual Ask/Side conversations, Team collaboration, support calls and TPM delivery. Team and TPM lists are grouped by their source session. TPM coordinates delivery with a main session; it does not have the Team Leader's implementation role.

## Responsibility model

These are responsibilities to make clear in the interface. They are not a decision to add four tabs or replace the current modes.

| Responsibility | Existing concepts | Design obligation |
| --- | --- | --- |
| Continue work | Bots, Windows, session views, recent places, Favorites | Make it easy to resume the correct conversation or arrangement, preserving draft, selection and position. |
| Notice and respond | Track, waiting/failed states, new results, Team/support approvals, TPM attention | Explain what needs a decision, which work it belongs to and whether the observation is current. Lead to the existing action surface and provide a way back. |
| Coordinate work | Ask, Side, Team, support calls, TPM | Explain the goal and relationship to the source session before creation. Preserve each mechanism's distinct ownership and lifecycle. |
| Manage environment and inventory | All sessions, Hosts, Providers, Settings, discovery/refresh | Keep infrastructure available when choosing execution context, diagnosing availability or managing the installation, without making it the main everyday browsing hierarchy. |

Object meaning should remain explicit:

- A native session is a conversation/runtime identity. A view displays it.
- A Window holds a saved arrangement. Closing a view or deleting a Window does not stop that native session.
- A Bot entry is a curated way to return to a bound conversation. Pinning, hiding and section membership should not be mistaken for native lifecycle operations.
- Team, support calls and TPM represent different coordination contracts. They should not become interchangeable merely to simplify a menu.
- Host and Provider identify execution context. Shared names or matching directory paths on different Hosts do not establish shared project identity.

## Journeys to design before moving controls

| User intent | Entry and action | Return and continuity |
| --- | --- | --- |
| Continue yesterday's work | Choose a known Bot or saved Window; use common search if it is not visible. | Restore the intended place, draft and selection. Avoid requiring infrastructure browsing on every visit. |
| Respond to a blocked agent | Follow a truthful attention indicator to the responsible existing conversation or approval surface. | Return to the source list/Window without losing its position; distinguish pending input from unread results and failure. |
| Get help on the current work | Use the existing contextual coordination entry; choose a mechanism based on the goal: contextual discussion, related work, review/support, Team coordination or TPM delivery. | Preserve source identity and show the relationship so the user can return. Creation and background authority remain explicit. |
| Find or start something else | Common search identifies result type and destination. Creation names its object and execution context. | Make opening/replacing a selected view versus adding a new view understandable; do not silently change the current contract. |
| Recover after disconnection or an uncertain operation | Show the affected Host/work, last known state and a supported recovery action. | Keep unknown outcomes unknown until reconciled. A saved transcript or loaded roster is not proof of a running connection or successful handoff. |

## Confirmed organization issues and proposals

1. **The preview changes search semantics.** Its Search button currently filters sample Bot rows, while the actual shared header opens the cross-object command palette. This is a prototype limitation, not a proposal to narrow product search. Preserve common search in the eventual design. If a separate list filter is useful, label its scope and review its placement separately.
2. **The same plus has different creation scopes.** The Bot header creates a section; the Window header offers sessions and Windows; the Window toolbar creates a view or opens a session. Context-sensitive actions can be useful, but their outcome must be clear before selection. Review explicit labels or a small contextual creation menu before changing any entry.
3. **Related work is split across feature lists.** Team and TPM already know their source. A candidate improvement is clearer source context and consistent return behavior in their existing management surfaces. A unified attention surface is a separate proposal requiring identity, observation coverage, deduplication and unread semantics to be settled first. Do not invent a universal count from partial observations.
4. **Infrastructure detail competes with the roster.** Bot directory controls expose raw Host IDs and per-source refresh inline. Propose concise known Host/provider labels for ordinary browsing, with full identity and source controls still reachable. Preserve disambiguation for identically titled sessions across machines.
5. **Mode transitions are real product behavior.** Search and management actions can move to Window mode. Before offering a unified shell, specify when an action changes mode, what remains mounted and how Back restores the caller's context. Visual consistency alone does not solve this.

## Recommended direction and alternatives

Prefer an incremental common navigation model around the existing Bot and Window modes. Preserve their current places and strengths: a concise roster for continuing a conversation, and saved arrangements for parallel work. Make search, creation scope, attention semantics and return behavior consistent around them. Review each actual entry relocation separately.

Continuing isolated roster polish has low implementation cost but leaves cross-feature journeys unresolved. Replacing the product with a new project/task hierarchy would be a larger conceptual and data-model change; current Window labels and cross-Host folders are not sufficient evidence for that hierarchy. Neither alternative should be adopted implicitly.

For desktop, persistent surrounding context may help compare and coordinate several conversations. For phones, prioritize one readable existing Session View, a reachable switching/attention path and a reliable return to the originating list. Do not decide a new bottom navigation or replace floating controls without a separate concrete review.

## How function should drive appearance

- Stable identity: readable titles and restrained secondary Host/provider context. Do not make identity compete with colorful decoration.
- Urgency: semantic state indicators whose scope is truthful. Avoid constantly reordering familiar rows as activity changes.
- Primary action: emphasize the next useful action for the current state; make secondary management actions accessible without crowding the title.
- Continuity: preserve list position, draft and mounted conversation across navigation; transitions should communicate a relationship rather than merely animate.
- Density: measure real long titles and realistic populated rosters at desktop, intermediate and phone widths. Comfortable empty-state screenshots are insufficient.

## Review decisions still open

- Which journey should lead: parallel supervision, familiar Bots, or delegated delivery? No user priority has been inferred from a missing answer.
- Should attention become easier to reach across both modes, and what exact set of work can it truthfully cover?
- Which creation outcomes should each existing plus expose, with what wording?
- How should source-related Team/TPM/support work be discoverable without changing Session View?
- Which controls actually need relocation after these journeys have been demonstrated?

Next deliverable after agreeing on the direction: desktop and phone walkthroughs of the same realistic work, showing entry, action, state change and return. Review those flows before an implementation plan, rather than approving a static sidebar alone.
