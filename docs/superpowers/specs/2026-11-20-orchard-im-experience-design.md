# Orchard: an IM experience centred on assistants

Status: approved direction (owner, 2026-11-20). Visual references are the mockups in [`assets/2026-11-20-orchard/`](assets/2026-11-20-orchard/):
- `mockup.html`: open it in a browser, the shapes move;
- `logo.html`;
- the light and dark captures.

## Why

The 2026-11-19 release made the session service fast underneath, but the page still reads as a diagnostic tool. Examples:
- a prompt used as a red title;
- a monospace timestamp;
- `RUNNING` in blue capitals;
- full workspace paths;
- a bordered approval form;
- "Opening session → Checking access → Synchronizing" on every open;
- a toolbar of equal-weight controls above and below each conversation.

The owner asked for an IM-grade experience, and for the UI and UX work to be part of the roadmap. The design target T5 already says no per-session connection label may appear ([IM session service design](2026-11-15-im-session-service-design.md)). Today's page breaks it.

## Decisions

1. **The user talks to assistants, not sessions.** The visual centre is a personified assistant: a name and an avatar. Several things sit behind it:
   - its sessions;
   - the agent that runs it (Claude Code, Codex, Copilot);
   - the machine (Host).

   All of these stay visible, one layer down. A new session behind the same assistant is a thin line in the conversation, not a new conversation.
2. **Layered disclosure, not less information.**

   | Layer | Where | Content |
   |---|---|---|
   | L0 Glance | Sidebar, title, notifications | Avatar, name, one sentence of business state ("想问你一件小事", "在跑测试，稍等～", "看完啦，有 3 点想法"), unread dot |
   | L1 Conversation | Message stream | Messages in bubbles. The agent's work is one grey line per turn, which can be opened. A running turn shows one live line ("Chief 在想例子怎么写 · 认真工作中"). Approvals are small inline cards with plain choices ("好的 / 先别 / 看看要改什么"). |
   | L2 Detail | Opened in place | Each tool call, command, diff and path; nothing that is shown today is lost |
   | L3 Diagnosis | Trace and Replica Inspector only | Connection phases, sync, timings, raw events |

3. **Three process modes**, set for all assistants or per assistant in the details panel:
   - **简洁** (default): the work folds into one line per turn.
   - **过程**: each step shows while it runs and folds when the turn ends.
   - **完整**: every step is open, which is today's level of detail in the new visual language.
4. **The composer is never blocked by connection state** (T4). A message sent while the session is still opening or syncing shows as "发送中" and is delivered when the session is ready. Only business reasons disable the composer:
   - read-only access;
   - an ended session;
   - a terminal in control, with take-over.
5. **One connection indicator.** The device's own link to the Relay is the only connection signal, and it sits in the sidebar. Host and runtime state are said in words on the assistant: "Mac mini 离线，消息会在它上线后送达", or "在休息，需要时自动醒来" for a released runtime.
6. **Product name: Orchard.** It follows the organisation name `orchardworks`. Assistants are the fruit of the orchard, and the logo is its farmer. The rename touches only what users see: the wordmark, the page title, the icons, and the login and about pages. Package names, the CLI command, the protocol names and the Controller product name stay as they are.

## Two views of the same assistants

Bot mode and Window mode both stay, and are designed together (owner, 2026-11-20).

| | Bot mode: the assistant view | Window mode: the workbench |
|---|---|---|
| What it is for | Talking to assistants one at a time, like IM | Watching and steering several assistants side by side |
| Unit | An assistant, with its sessions behind it | A window of tiles, each tile one assistant's conversation |
| Layout | Sidebar, conversation and details panel | Tiles over the same warm ground, each tile a small floating panel |

What the two modes share:
- the same avatars, names and business-state sentences;
- the same bubbles, work-summary line, inline approvals and process modes;
- the same details panel, opened from any tile.

Moving between the modes keeps your place. Opening an assistant from a tile shows it in Bot mode, and pinning an assistant from Bot mode adds it to a window.

Window mode gets the same visual language in the same step as Bot mode (I3), not a restyle afterwards. On the phone, a window becomes a swipeable stack of its tiles.

## Organised as an IM product

The owner's rule (2026-11-21): the product's features are organised the way an IM application organises them. Each requirement below maps to what Orchard already has, and a step that adds a feature places it in this map.

| IM requirement | In Orchard |
|---|---|
| **Chats**: recent conversations sorted by activity, each with unread or needs-you dots, pin and mute, and a draft preserved per chat | The assistant list in Bot mode, ordered by last activity. The needs-you and unread dots come from attention. Pinning comes from the star. Drafts are kept per target. |
| **Contacts**: everyone you can talk to, grouped, with add-new and presence | All assistants, including resting and hidden ones, grouped by Window group. Presence is working, idle, resting or Host offline. |
| **Groups**: assistants organised in groups, several members side by side | **A group is a Window** (the stored `WindowGroup`: one `window` plus its `bots` members). Chats and the Assistants directory are sectioned by group; Window mode shows the same group as tiles. A group has a name, members, and per-group settings (mute, notifications); an assistant can move between groups. Team messages appear as events in the conversation. |
| **Me and Settings** | One Settings page, plus the account and device sections (see below) |
| **Search** across chats and messages | Global search on the rail, plus search within a conversation |
| **Notifications**: needs-you is distinct from unread; mute per chat | Attention rules, and per-assistant notifications in details and in Settings |
| **Message actions**: copy, quote, resend, retract and edit where the agent allows | Message actions and prompt edit, with "Not sent" and Retry from I1 |
| **Delivery states**: sending, sent, not delivered | I1 send states |
| **Typing and working indicator** | The live status line |
| **Multi-device**: drafts, read state and order synchronise | The device store, per-account drafts and reads (the IM session service design) |

## Navigation and Settings

Approved by the owner on 2026-11-21. The mockup is in [`assets/2026-11-21-settings/`](assets/2026-11-21-settings/).

**Desktop.** A narrow icon rail at the far left replaces the large Window/Bot switch at the top of the sidebar. From top to bottom it holds:
- the Orchard mark;
- **Chats** (Bot mode): recent assistant conversations by activity;
- **Assistants**: the directory of every assistant, grouped, with add-new;
- **Windows** (Window mode);
- Search;
- **Settings**, at the bottom;
- the user's avatar, with the device-link dot.

Both modes share the rail. The sidebar carries no mode switch.

**Phone.** A bottom tab bar holds Chats, Assistants, Windows and Me. Me contains Settings.

**One Settings page.** Groups sit on the left and content on the right; on the phone the groups form a list.
- **General:** theme (system, light or dark), language (browser, 中文 or English), reduce motion, default view (assistants, windows or last used).
- **Assistants:** default process mode, notifications, team messages.
- **Computers:** for each Host, its online state, Controller updates, available agents, the smart-reading switch per provider, the VS Code tunnel and its previews, and pairing a new computer.
- **Privacy and data:** device cache and support sharing.
- **Advanced:** layout diagnostics, Trace and Inspector.
- **Account and about:** account, sign out, versions.

**What stays on the assistant.** Per-assistant settings stay in the assistant's details panel: name, avatar and that assistant's process mode. The Settings page holds only account-wide and device-wide settings, and every setting has exactly one home.

## Phone

The phone is a first-class target, not a later port (owner, 2026-11-20). Every step is designed and accepted at phone width (390 x 844) as well as desktop:
- **Assistants.** The assistant list is the home screen.
- **Conversation.** Opening an assistant shows its conversation full-screen, with a back gesture.
- **Details.** The details panel is a sheet that slides up from the assistant's name.
- **Composer.** The composer stays above the keyboard, without layout jumps. Return inserts a line on iPhone, and the send button sends.
- **Touch targets** are at least 44 px. No floating control covers content.
- **Safe-area insets** are respected. The page works as an installed home-screen web app.
- **Motion and battery.** Avatar motion pauses when the page is hidden.

## Visual language

- **Feel.** Soft and friendly, not formal. The softness comes from shape and voice, not decoration: no gradients, textures, emoji stickers or faces with mouths.
- **Layout.** Three floating panels with rounded corners (22 px) over a warm tinted ground, separated by gaps rather than lines:
  - the sidebar;
  - the conversation;
  - the details.
- **Messages.**
  - The user's bubbles are on the right: dark in the light theme, light in the dark theme.
  - The assistant's bubbles are on the left, neutral, with the avatar at the bubble's foot.
  - The assistant's name is not repeated on every message.
- **Colour.** The interface is near-monochrome. Colour belongs to the assistants, and one brand orange (`#ff7f45`) marks the primary action, toggles and the selected mode. A selected assistant, its name card and its approval cards take a light tint of the brand colour.
- **Type.** System sans for text, SF Pro Rounded for the wordmark. Body text is 14.5 px, with fewer weights and less grey than today.
- **Themes.** Light and dark from the start, sharing the same design tokens.
- **Tokens.** Colours, radii, spacing, type scale, elevation and motion live in one token module that every component reads. No component hard-codes a colour.

### Assistant avatars

- **Shape and colour.** A flat, matte, solid-colour soft shape: a circle, a rounded triangle, a sideways triangle or a squircle, each slightly irregular. There is no background tile.
- **Eyes.** Two dark vertical oval eyes, set off-centre so that the assistant looks somewhere. No other features.
- **Motion.**
  - The outline flows slowly, like soft clay, on a 5 to 7 s cycle; each assistant has its own phase.
  - A working assistant bobs gently.
  - An assistant that needs you gives a small pop.
  - A resting one turns grey.
  - Motion respects `prefers-reduced-motion`, and avatars smaller than 24 px do not animate.
- **Generation.** An avatar is generated from shape × colour × gaze when an assistant is created, so every assistant is distinct. The user can change it. Default assistant names may come from the naming shortlist: 团团 Dango, 软糖 Gummies, 窝 Nest, 石子 Pebbles, 孵 Hatch.

### Logo

- **The mark.** The Orchard farmer:
  - an orange mochi-shaped robot on a dark rounded tile (`#24242a`);
  - it fills the tile and is cropped by the bottom edge, as if peeking up;
  - its head is tilted, and its two oval eyes look up and to the left;
  - one green sprout leaf.
- **The wordmark** is "orchard" in lowercase SF Pro Rounded, weight 750. Lowercase keeps it soft and matches the rounded type.
- **In running text** (sentences, page titles, documents) the name is a proper noun: "Orchard".
- **Animation.** At large sizes the eyes glance and the sprout sways; at 32 px and below the mark is static.
- **Sizes.** The 16 px favicon and 512 px app icon are cut from the same drawing.

## Where the change lives

The client runtime (`agent-client`: timeline, replica, send state, device store, succession) is unchanged. The work is in presentation:

| Area | Package | Change |
|---|---|---|
| Quiet open, composer, send queue | `agent-client` (`remote-session-client`, `session-state`, `send-state`) and `agent-client-web` (`AgentActivityStatus`, `AgentComposer`) | Connection phases stop producing user-facing labels. The composer's enabled state depends only on business state. Sends before ready enter the existing send queue. |
| Design tokens and primitives | New `agent-client-web/src/theme` (tokens and themes) and primitives (bubble, card, avatar, pill, status line) | One source of truth for the visual language |
| Assistant view | `agent-remote-lab` Bot mode (assistant list, conversation, details panel) | The new three-panel layout. Bot mode becomes the primary view because its model (one bot continuing many sessions) already matches "an assistant". |
| Timeline rendering | `agent-client-web` `AgentTimeline` and items | Bubbles, the one-line work summary with L2 expansion, inline approval cards, the session-change line, the three process modes |
| Window mode | `agent-remote-lab` Window mode | Kept as the multi-window workbench and designed together with the assistant view: tiles are assistant conversations built from the same primitives. Its window and tile behaviour does not change. |
| Brand | Site shell, `index.html`, icons, access page | Orchard wordmark and logo |

## Roadmap steps

These are the I steps in the roadmap. Each ships on its own.

1. **I1 Quiet open (experience layer, no visual change).**
   - T4 and T5 on the current page.
   - No Opening session, Checking access or Synchronizing label in smart mode.
   - The composer is enabled during open and sync, and sends queue until the session is ready.
   - The control check runs alongside the timeline subscription, not before it.
   - Enabling journals in production follows I1, with the owner's approval of the deploy.
2. **I2 Design system.** Tokens, light and dark themes, primitives, avatar generation and the Orchard logo. Component fixture pages show every primitive in both themes.
3. **I3 Assistant view and workbench.** Bot mode and Window mode in the new design, together.
   - Bot mode in the new layout: sidebar, conversation with bubbles and the three process modes, details panel.
   - The details panel shows the agent, the machine, the sessions, settings, upcoming routines when P5 lands, and files.
   - Inline approvals, the work-summary line, the session-change line.
   - Assistant-voiced status sentences.
4. **I4 Brand and polish.** The Orchard brand across the site (access page, about, icons, installed web app), and the remaining screens. The phone layout is not deferred to I4. I2 primitives and the I3 assistant view ship with their phone layouts and phone acceptance.

## Acceptance

- **T4 and T5 are met.** Measured by the existing runner at 4x CPU and 100 ms round trip:
  - no frame shows a per-session connection label;
  - a message typed during open shows as sending within 100 ms and is delivered once the session is ready.
- **Every piece of information visible today is reachable in L2 or L3.** A component test per item kind opens L2 and finds it.
- **Both themes pass contrast checks** (WCAG AA for text). Motion stops under `prefers-reduced-motion`.
- **Every step passes its component and e2e checks at phone width (390 x 844) and desktop width.** A main flow runs in a mobile WebKit context.
- **The owner reviews each step on `pnpm local`** before it merges.

## Tests

Tests follow `.agents/skills/write-tests/SKILL.md`:
- **Label and composer rules are pure functions over session state.** Examples: "which label, if any", "is the composer enabled and why not". They get unit tests and vector rows; no mounted Workbench.
- **Primitives and layouts get component (browser) tests** on builder states, in both themes, at desktop and phone widths.
- **One e2e flow covers the main path:** open an assistant, type during open, see "sending", see it delivered, with no connection label in any frame.
- **The process modes are one rule** (which steps are open for a mode and turn state) with a unit table. The timeline component reads it.

## Out of scope

- Renaming packages, the CLI command or the Controller.
- Changing the Remote protocol.
- Voice input and sharing, which appear in the second reference but are not part of this work.
- Upcoming routines in the details panel. They appear when P5 (automation) lands.
