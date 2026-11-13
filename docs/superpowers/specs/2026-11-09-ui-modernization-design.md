# UI modernization: one Apple-style app for Window mode and Bot mode

Status: approved in conversation on 2026-11-09, section by section. Mockups are in `.superpowers/brainstorm/` (not committed).

**Scope amendment, 2026-11-13:** The user requires advance review before functional-layout changes and explicitly protects the existing Session View. Do not execute the conversation, tool-activity, approval-card or composer redesign described below in phase 3c or carry it into phase 4. Only targeted small fixes for confirmed Session View problems are allowed. Continue modernization on surrounding navigation, Bot lists and Window management. See [the pending roster layout review](2026-11-13-bot-roster-layout-review.md). The older descriptions below are retained as design history, subject to this amendment.

**Bot hierarchy clarification, 2026-11-13:** Only Ask is a secondary session under its owner in Bot mode. Other sessions, including Side and sessions serving Team/support/TPM roles, are first-level peers in the same Bot group. This supersedes the older suggestion to group Sides and Asks together as subordinate Threads. Role/source relationships do not establish additional navigation levels. See [the function organization review](2026-11-13-workbench-function-organization-review.md) for the confirmed model and the separate implementation gap.

## Goal

Make the website feel like a current Apple app, in both modes, on desktop and on phones: a shared shell with a sidebar and a toolbar, a consistent visual language with light and dark appearances, and interaction patterns people already know from macOS and iOS. Bot mode follows Grok Bot's design language (sections of long-lived bots, pictures and labels, approvals in the conversation) expressed with Apple's conventions.

## Decisions

| Question | Decision |
|---|---|
| Scope | Visual language and interaction structure together, in phases |
| Platforms | Desktop and phone equally; each follows its own platform's conventions (macOS on desktop, iOS on phones) |
| Appearance | Light and dark, following the system (`prefers-color-scheme`) |
| Visual style | Classic macOS: opaque surfaces, hairline separators, system colors. No large translucent or blurred materials (cost and inconsistency across browsers) |
| Shell | One app; a segmented control at the top of the sidebar switches Bots / Windows. Each mode keeps its own place, as today (modes do not follow each other) |
| Bot conversation | The user's messages in bubbles; the bot's replies laid out full width as a document |
| Window panes | Each pane keeps a slim header: status, title, state, a ⋯ menu; actions move into the menu |
| Phone, Window mode | Keep today's floating buttons and their behavior, restyled |
| Implementation | Evolve the existing code: a semantic token layer, a small set of own primitives on native `<dialog>` and popover, then the shell and modes. No UI library |
| Icons | An own line icon set in one module. SF Symbols are licensed for Apple platforms only and are not used |

## Foundation

### Tokens

Semantic tokens in pairs for light and dark, switched by `prefers-color-scheme`:

| Role | Light | Dark |
|---|---|---|
| Background / grouped background | `#FFFFFF` / `#F2F2F7` | `#1C1C1E` / `#000000` |
| Sidebar | `#F2F2F7` (opaque) | `#2C2C2E` |
| Label / secondary / tertiary | `#1D1D1F` / `#6E6E73` / `#AEAEB2` | `#F5F5F7` / `#98989D` / `#636366` |
| Separator / fill | black 18% / gray 12% | white 15% / gray 24% |
| Accent (system blue) | `#007AFF` | `#0A84FF` |
| Status: needs you / working / done / failed | system orange / blue / green / red | their dark variants |

The existing `--obs-*` variables are redefined in terms of the new tokens, so every page takes the new colors and the dark appearance as soon as the foundation lands. Code blocks, tables and diffs follow the appearance instead of a fixed dark background. Hard-coded colors in components are found by script and replaced with tokens.

Typography uses the system font (SF on Apple devices) and `ui-monospace` for code: six levels (large title, title, headline, body, callout, caption); body 14px on desktop and 17px on phones. Radii: 6px for controls and rows, 10px for panes and cards, 14–18px for inputs and sheets. Two shadows: overlay and pane. Motion: 150–250ms fades, slides and springs for menus, sheets and list changes; none with `prefers-reduced-motion`.

### Primitives

New `packages/agent-remote-lab/src/ui/`, one component per file, each with unit tests for keyboard, focus and ARIA:

| Primitive | Purpose |
|---|---|
| `Button` | primary, secondary, plain, destructive |
| `IconButton` | icon-only buttons with an accessible name |
| `SegmentedControl` | Bots / Windows and similar choices |
| `ListRow` | picture, title, subtitle, trailing accessory |
| `Avatar` | a bot's shape, color and initial (from its stored picture) |
| `StatusBadge` | count badge, spinner, unread dot, failure mark |
| `Menu` | context and ⋯ menus on the popover API |
| `Sheet` | bottom sheets on phones, on `<dialog>`, half and full height |
| `Toolbar` | the 52px toolbar layout |
| `Icon` | the line icon set |

## App shell

`AppShell` owns the sidebar, the toolbar and the main area, and the layout per width; each mode supplies its sidebar content (`BotSidebar`, `WindowSidebar`) and toolbar content. The data hooks (`useBotWorkspace`, `useWindowWorkspace`, the session directory) do not change.

- **Desktop (≥ 900px).** Sidebar 260px, resizable from 220 to 360px, collapsible (⌘\ or a toolbar button). Top: the **+** menu (Bot mode: New Bot, Add existing session, New section; Window mode: New Window, New session), the Bots / Windows segmented control, search. Bottom: Host status (how many online) and Settings. The toolbar shows the current object on the left and its actions and ⋯ menu on the right.
- **Medium (700–900px).** The sidebar is collapsed and slides over the content from a toolbar button.
- **Phone (< 700px).** Bot mode is a navigation stack: the roster with a large "Bots" title, then the conversation full screen with Back (browser history, so edge swipe works). Window mode keeps the floating buttons; they open bottom sheets with the sidebar's content. A small tab bar switches Bots / Windows.
- **Search (⌘K).** A command palette over bots, Windows and session titles, plus common actions. Shortcuts avoid ones browsers reserve: ⌘K, ⌘\, ⌥⌘1 / ⌥⌘2 for the modes.
- **Notifications.** Toasts become banners (top right on desktop, top on phones); a "needs you" banner opens its bot or view.

## Bot mode

**Roster.** Pinned; then sections in rank order, each with a count, collapsible, and a ⋯ menu (Rename, Show as Window, Separate, Delete section); Other sessions (the fallback group), collapsed with a count, rows showing title and "Host · provider" instead of raw IDs, refresh in its ⋯ menu; Hidden Bots at the bottom with a count.

**Bot row.** Avatar, name, and a subtitle: the label, or the start of the latest reply. One trailing status, by priority: needs you (orange count of pending requests), failed (red mark), working (spinner), new result (blue dot). New result compares the latest entry with what this browser last showed for the bot (local storage); syncing it to the account comes later. Context and ⋯ menu: Rename, Edit label and picture, Pin, Hide, Move to section / New section, Show as Window, Remove bot.

**New Bot** (sheet): name, picture (three shapes, eight colors), optional label; provider, Host, workspace and model, defaulting to the last choice; an optional first message. The conversation opens when it is created.

**Toolbar and details.** Avatar, name, label and state; Threads (count of the bot's Sides and Asks) and ⋯ on the right. The name opens the bot's details: edit name, label and picture in place; provider, model, Host and workspace; Open in Window.

**Conversation.** The user's messages are accent bubbles on the right. The bot's replies are full-width Markdown with the avatar and name at the start of each turn; code blocks follow the appearance and have a copy button. Tool activity and reasoning are folded into one line per turn ("✓ Read 4 files, ran 2 commands · 12s ›") that expands in place: Bot mode's existing content-only display with the new look. Approvals, questions and plan confirmations are cards in the conversation with their actions, headed "Needs you". Failures are red cards with Retry. Day separators; a "Jump to latest" button when scrolled back.

**Composer.** Rounded field; **+** for images and resources; model and permission as small pills; Send becomes Stop while the bot works. Enter sends, Shift+Enter adds a line; sending while it works steers the turn, as today.

**Threads.** A collapsible panel on the right on desktop lists the bot's Sides and Asks and holds the chosen one; full screen on phones.

## Window mode

**Sidebar.** Windows (name, view count, the most urgent status of its views; **+** New Window; menu: Rename, Show as section, Copy link, Delete with confirmation). In this Window: its views by placement with a status dot, attached Sides and Asks indented under their view, collapsed docks dimmed; a click focuses and scrolls to the view, expanding a collapsed one. Shortcuts: Favorites, Teams, TPM, Asks, All sessions. The first four open today's panels restyled; All sessions is a page that takes the Host and provider choice, filters, scan and refresh out of the sidebar, and starts new sessions.

**Toolbar.** Window name (rename in place) and view count; **+** (new session view, open existing session), show or hide docks, ⋯ (Show as section, Copy link, Agent control, Delete).

**Panes.** Header: status dot, title, state (idle, working, needs you, failed), ⋯ menu, and ✕ on hover. The menu holds Favorite, New Side, Ask, Search in conversation, Display (full, preview, content only), Session settings, Hand off, Rename, Close. The focused pane has an accent ring. Separators are hairlines that become handles on hover. Collapsed docks are vertical title strips that expand on click; floats are rounded windows with a shadow, moved by their header. The timeline uses Bot mode's message styles but shows full detail by default (compact expandable tool rows, collapsible reasoning), still governed by each pane's display setting. The composer is Bot mode's, more compact. Team, TPM and Ask views take the same header and card styles; their content does not change.

**Phone.** The floating buttons keep their placement, dragging and behavior with an Apple look (white capsules, soft shadow, counts). They open bottom sheets (half or full height) with the sidebar's content. The current view is full screen with the desktop pane header; switching views goes through In this Window in the sheet.

## Phases

Only the website changes; each phase merges and deploys on its own.

| Phase | Content | Visible result |
|---|---|---|
| 1 | Tokens, dark appearance, typography, `src/ui/` primitives, icon set, `--obs-*` mapping, themed code blocks | The whole site in the new colors and type, with dark mode |
| 2 | `AppShell`, shared sidebar and toolbar, segmented control, ⌘K search, Window-mode sidebar content, All sessions page | The new frame on desktop and tablets, in both modes |
| 3 | Bot mode: roster rows and statuses, New Bot, bot details, conversation layout, cards, composer, Threads panel, new-result tracking | Bot mode as designed |
| 4 | Window mode: pane header and menu, focus ring, separators, collapsed docks, floats, feature views | Window mode as designed |
| 5 | Phones: Bot navigation stack and tab bar, floating buttons and sheets, banners | Phones as designed |

Each phase gets its own implementation plan, written when the previous phase has landed.

## Testing

- Primitives: unit tests for keyboard, focus and ARIA.
- Existing component and Playwright tests find controls by accessible name. Rule: a control that still exists keeps its accessible name (for example "Window mode", "Bot mode", "Windows"), so those tests keep working.
- Each phase is checked on a local instance with real sessions, by screenshots in light and dark, desktop and phone.
- Contrast meets WCAG AA in both appearances; the main flows work with the keyboard alone; reduced motion is honored.
- Window switching and bot switching are measured on a local instance with a Playwright script that records long tasks (as for the 2026-11-09 Window-switch investigation), before and after each phase.

## Risks

- **`App.tsx` is large (over 2,500 lines).** The shell moves layout only; state and logic stay. The extraction is its own commit.
- **Playwright has failures on main.** Each phase compares the failure list before and after its change rather than requiring a clean run.
- **Parallel work in the Lab.** Each phase starts from the current main.
- **Dark appearance gaps.** Hard-coded colors are listed by script in phase 1 and replaced.
