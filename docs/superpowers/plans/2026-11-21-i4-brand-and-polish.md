# I4: Brand and polish

**State: plan (2026-11-21).** I4 is the last Orchard step (roadmap "Next: Orchard"; [Orchard design](../specs/2026-11-20-orchard-im-experience-design.md): "Visual language", "Phone", "Organised as an IM product", "Navigation and Settings", step I4 and Acceptance). It follows [I3](2026-11-20-i3-assistant-view.md) and keeps its owner decisions: the language follows the browser, and every word comes from the catalogue `t(key, params)` in English and Chinese. It takes the roadmap's "Left for I4" items: the old composer, +59 lines of production CSS, and the detail strings that are English only.

## 1. For the owner

**What you will see.**
- **Composer.** The mockup's capsule: "+" at the left, "给 Chief 发消息…" inside, a round orange send button with dark ink at the right. "+" opens a small menu: Image, Resource, Command `/`, Queue for next turn while a turn runs, and the model, permissions and status where the composer still shows them (TPM, Ask, side and subagent panes). While a turn runs, a round stop button sits beside send. Sending, queued, Not sent and Check delivery look and behave as in I1.
- **Sign-in.** The Relay's sign-in pages and the page's own access screen carry the mark, the wordmark and the tokens, in both themes and both languages. A short check shows nothing but the warm ground; a longer one shows the mark and one sentence ("Opening Orchard…", "正在打开 Orchard…").
- **Navigation.** On the desktop, a narrow rail at the far left: the mark, Chats, Assistants, Windows, Search, Settings at the bottom, and your avatar with the device-link dot. The sidebar has no mode switch. On the phone, a tab bar: Chats, Assistants, Windows, Me.
- **One Settings page.** General, Assistants, Computers, Privacy and data, Advanced, Account and about. Every setting has one home; an assistant's own name, avatar and process mode stay in its details.
- **Chinese everywhere.** Settings, Hosts, menus, toasts, empty states and the L2 details ("允许这一次" for Allow once) speak Chinese on a Chinese browser, or when Settings says 中文.
- **Installed app.** Added to the home screen, it opens standalone on the warm ground of the chosen theme, with the browser's chrome in the same colour.

**Deploy.** One Relay release (the Worker serves the sign-in pages and the website together). No Controller change, no protocol change, no stored field: the new choices are per device. Smart reading uses the existing owner-only route.

**Review on `pnpm local`.** Section 8 lists the screens.

## 2. Today

| Piece | Where | Today |
|---|---|---|
| Composer | `agent-client-web/src/react/AgentComposer.tsx` (692), `AgentActionToolbar.tsx`, `AgentSessionSettings.tsx`, `AgentActivityStatus.tsx`; rules in `styles.css` (~60 lines) and `app.css` (~55 lines that override them) | A bordered box: editor, then a row of a fitted toolbar (Image, Resource, `/`, Queue, Model ▾, Permissions ▾, •••), the activity label with elapsed time and Interrupt, and a square send button. The label and elapsed time repeat the timeline's status line (I3 inventory S1). |
| Access pages | `agent-relay-core/src/access-page.ts` (copy and style), `auth-callback.ts`, `auth-error.ts`, `cli-access.ts`; the Lab's `components/AccessPage.tsx` for the checking, sign-in and unavailable states | "Agent Remote" with a generic glyph, blue legacy tokens, a three-step progress row, English only. Busy states say "Checking access…", "Restoring access…", "Verifying access…", "Opening session…". `restoring` has no caller. |
| Catalogue | `agent-client/src/presentation/messages.ts` (535 lines, ~330 keys per locale), `agent-client-web/src/react/locale.tsx` (`LocaleContext`, `browserLocale`, `useTranslate`) | The conversation's words. About 2,200 other user-facing strings are literals in ~300 files of the Lab, `agent-client-web` and `agent-client` (headings, buttons, `aria-label`, `title`, placeholders, notes, toasts, errors made in the client). |
| CSS | Production CSS of the Lab and the Session View without `theme.css` and `primitives.css`: 4,319 lines; 4,271 at the I2 release `ac075f9d` | +48 net for I3. Legacy rules still style the compact layout, TPM, Ask and the docks outside the Window canvas. |
| Installed app | `index.html`, `public/app/manifest.webmanifest`, `bindAppearance` | Standalone, named Orchard, theme colour following the appearance (I2). The root paints the legacy white surface, not the ground. iOS takes the home-screen name from the current title ("Chief · Orchard"). Safe areas belong to the browser (`viewport-fit=contain`, status bar `default`), a choice the device research in `docs/current/agent-remote/mobile-viewport-research.md` made. |
| Navigation | `shell/SidebarHeader.tsx` (Window/Bot switch, Search, +), `shell/SidebarFooter.tsx` (Hosts summary, gear), `app/views/MobileNavigation.tsx`, `hooks/useWorkbenchMode.ts`, `workbench-mode.ts` | The switch heads both sidebars (and View options, and Window recovery); Search and + sit beside it. The Window sidebar's foot has the Hosts summary and the gear; Bot mode's foot has the device-link slot; Window mode shows the link as a banner. Bot mode has no way to Settings, Hosts, Security or Sign out. On the phone, Bot mode is home; Window mode has the "Session navigation" bar with the launcher row. |
| Settings | `useViewModel.tsx` `sessionPanelContent` in `SessionsPage` ("Settings", opened by the gear "Sidebar settings"); `HostOverview` as the Hosts page; `SecurityPanel` and Sign out in the hidden app bar | One panel acting on one selected Host: Mobile display, Cache privacy, Call for support, Layout diagnostics ("Controller settings"), `HostPairing` with `HostSecurityActions` (providers, Codex daemon, rotate, stop) and `PairingKeys`, `HostVscodeTunnel`, `ControllerUpdates`. Appearance only in the palette. The device process default, letters and notifications each have two controls (details panel and view options). No language or motion choice, no smart-reading control (`GET`/`PUT …/smart-reading` exist; `GET /v1/remote/hosts` says `access: 'owner' \| 'shared'`). |

## 3. Decisions

1. **The composer is one capsule** (`--orchard-fill`, radius `composer` 24): the "+" button, the editor, the stop button while a turn runs, and the send button (32 px, 44 px under a coarse pointer; `brand` fill with `on-brand` ink; `fill-strong` with `text-secondary` when it cannot send). Above the capsule stay what the composer already stacks there: the pending-send chips (I1), notes and errors, the command list, and the open setting panel. The editor and its placeholder are unchanged except the words: "Message {name}…" / "给 {name} 发消息…", with the assistant's name where the host gives one.
2. **One menu replaces the fitted toolbar.** "+" opens a menu of the composer's actions, whose availability is one pure rule (section 4.1): Image, Resource, Command `/`, Queue for next turn, and Model, Permissions and Status when the composer shows the session's settings (`settings="inline"`: TPM, Ask, side and subagent panes; the assistant views pass `none` since I3b). `AgentActionToolbar` and its width fitting go. The panels the settings items open are today's `AgentSessionSettings` panels, unchanged.
3. **The activity label and elapsed time leave the composer.** The timeline's status line says them (I3 inventory S1); the composer keeps Interrupt as the round stop button, with its label, pending and refused words unchanged. Return keeps `returnKeyAction` (I3b); the send button's hold-for-newline stays.
4. **Access pages wait quietly.** A busy state (`checking`, `verifying`, `opening`) shows only the mark (56 px, static) and one sentence, faded in by CSS after 400 ms, so a short check paints the ground and nothing else; reduced motion drops the fade, not the delay. A state that needs the reader (`signin`, `expired`, `unavailable`, the command line pages, the sign-in failures) is one card on the ground: mark and wordmark, title, one sentence, one action. The progress row, the eyebrow and the generic glyph go; the unused `restoring` state goes.
5. **The access pages stay small and self-contained.** `access-page.ts` keeps its words, style and mark as strings: no import of the client, the tokens module or a font. Its colours are the Orchard tokens as `light-dark()` literals with `color-scheme: light dark`, and its mark is `markSvg()`'s drawing; a Lab test (layer 4 may import both) fails when either drifts from `orchardColors` or `markSvg()`. The Relay picks the language from `Accept-Language`; the callback page's script prefers the device's stored language when there is one.
6. **One catalogue, in areas.** The catalogue stays in `agent-client/src/presentation` and becomes `messages/` with one English and one Chinese file per area (`common`, `conversation`, `composer`, `timeline`, `navigation`, `settings`, `hosts`, `windows`, `sessions`, `team`, `diagnostics`, `errors`). Each Chinese area is typed by its English area, so a missing or extra key fails the type check, and the existing catalogue test (same keys, same placeholders, no empty form in every locale) runs over the merged tables plus a new check that no key is defined in two areas. English text stays byte-identical when a literal moves, so tests that read English keep their meaning.
7. **Words made outside React take `t`.** Pure rules that return words (`sessionActivityLabel`, `sessionNoticeWords`, `composerAvailability.words`, `hostSummary`, `assistantStatus`, …) take a `Translate` argument, English by default. Errors the client makes for a person carry a `messageKey` (and params) beside their English `message`; the toast and inline error renderers show `t(error.messageKey)` when present. Messages that come from the Relay or the Controller are data and stay as sent.
8. **The language is a device choice.** `agent-remote:language` is `browser` (absent), `zh` or `en`; `effectiveLocale(choice, navigator.languages)` decides, and `<html lang>` follows. The Lab and the fixture pages provide `LocaleContext` from it and re-render when it changes, in this tab and others.
9. **Navigation is four destinations** (design "Navigation and Settings"): Chats (Bot mode), Assistants (the directory), Windows (Window mode) and Settings, plus Search as an action. The rail (desktop) and the tab bar (phone, where Me holds Settings and the account) show the current destination from one pure rule over the URL and the mode (section 4.3). `?mode=bot|window`, `section`, `bot`, session and Window links keep their meaning; Settings and the directory are `?page=settings&group=<id>` and `?page=assistants`, written over the mode's place so the way back returns to the same chat or Window.
10. **Chats and Assistants split today's roster.** Chats lists the assistants shown in Bot mode, pinned first, then by last activity, without group headings, then Other sessions. Assistants lists every assistant of the account by Window group, hidden and resting ones included and marked, with New assistant, the group actions and Show in Chats for a hidden one. A `section` link opens the directory at its group.
11. **One Settings page, one home per setting** (section 4.4). Today's settings panel, its components and the Hosts page move into the groups; the old panel, the sidebar footer and the mode switch are deleted. The details panel keeps the assistant's name, avatar and process mode, and loses the device default, notifications and letters, which move to Settings > Assistants.
12. **New device choices:** reduce motion (`agent-remote:motion`: absent follows the system, `reduce` always reduces; the switch shows on and locked when the system reduces) and the default view (`agent-remote:default-view`: `chats`, `windows` or `last`, absent means `last`, which is today's rule). Reduced motion stops the avatars and the mark through `MotionProvider` and sets `data-motion="reduce"` on the root, which zeroes the Orchard durations (generated in `theme.css`).
13. **Smart reading** is a switch per provider under each Host the reader owns, through the existing `GET` and `PUT /v1/remote/hosts/:id/smart-reading`; a Host the reader does not own shows no switch.
14. **CSS.** The compact layout, TPM and Ask views move onto Orchard tokens and primitives, and each moved selector deletes its legacy rule. The composer's rules in `styles.css` and their overrides in `app.css` become one set on Orchard tokens. Net production CSS for I3 plus I4 is at most 0 against `ac075f9d` (4,271 lines); the ratchet falls with every commit.
15. **Installed app.** Safe areas stay with the browser (`viewport-fit=contain`, status bar `default`), as the device research decided; the rail, the tab bar, sheets and the composer pad by `env(safe-area-inset-*)`, which is zero there and right elsewhere. The root paints `--orchard-ground`, so the launch, the overscroll and the browser-painted margins take the theme's ground; `apple-mobile-web-app-title` names the home-screen icon Orchard whatever the page title is; the manifest's colours are the light ground, checked against the tokens.

## 4. Interfaces

Every rule below is pure, in a module of its own, with a vector table that its unit test reads row by row; components read the rule and never repeat it.

### 4.1 Composer menu (`agent-client-web/src/react/composer-menu.ts`)

```ts
export type ComposerMenuItemId = 'image' | 'resource' | 'command' | 'queue' | 'model' | 'permissions' | 'status';
export interface ComposerMenuFacts {
  readonly images: boolean;            // rich editor that takes images (capability or an image draft binding)
  readonly resources: boolean;         // capability resourceInput
  readonly resourceUpload: boolean;    // an upload callback and a hydrated resource draft
  readonly target: boolean;            // a session to write to, or a draft-only stand-in
  readonly ready: boolean;             // the session admits operations now
  readonly readOnly: boolean; readonly busy: boolean;
  readonly firstInputPending: boolean; // history still waits for the first message (text only)
  readonly consoleCommands: boolean;
  readonly queue: 'none' | 'refused' | 'allowed';   // canQueue, and the queue operation now
  readonly draft: { readonly content: boolean; readonly command: boolean; readonly skill: boolean; readonly imagesReady: boolean; readonly waiting: number; readonly sendable: boolean };
  readonly settings: boolean;          // the composer shows the session's settings (settings="inline" with an agent)
}
export interface ComposerMenuItem { readonly id: ComposerMenuItemId; readonly enabled: boolean; readonly note?: MessageKey }
export function composerMenu(facts: ComposerMenuFacts): readonly ComposerMenuItem[];
```

Rows (`composer-menu.vectors.ts`) carry today's toolbar conditions over unchanged: Image shows with `images` and is enabled with a target, not read-only, not busy and no first-input history (note `composer.imagesAfterHistory`); Resource needs `ready` and `resourceUpload` (note `composer.resourcesAfterHistory`); Command needs `ready`, not busy, and console commands when read-only; Queue shows unless `none`, and is enabled when allowed with content, ready images, no command or skill, nothing waiting and not busy; the three settings items show with `settings`. A mutation that drops one condition fails a row.

### 4.2 Access pages (`agent-relay-core/src/access-page.ts`)

```ts
export type AccessLocale = 'en' | 'zh';
/** The first language of an Accept-Language header or a browser's list that the pages speak; English otherwise (q=0 skipped). */
export function accessLocale(languages: string | readonly string[] | null | undefined): AccessLocale;
export type AccessPageState = 'checking' | 'signin' | 'verifying' | 'opening' | 'expired' | 'unavailable';
export interface AccessFacts { sessionLink?: boolean; failure?: 'denied' | 'capacity'; surface?: 'app' | 'relay' }
export type AccessPlan = { kind: 'wait'; sentence: AccessWordKey } | { kind: 'card'; title: AccessWordKey; description: AccessWordKey; action: AccessWordKey; secondary?: AccessWordKey };
export function accessPlan(state: AccessPageState, facts?: AccessFacts): AccessPlan;      // the rule
export function accessView(state: AccessPageState, locale: AccessLocale, facts?: AccessFacts): AccessView; // its words
export function accessWord(locale: AccessLocale, key: AccessWordKey, params?: Record<string, string>): string;
export const accessWaitDelayMs = 400;
```

Rows (`access-page.vectors.ts`): every state with and without a session link, on the page and on the Relay, with each failure. Checked over every row: a busy state is a wait with one sentence; a wait never says access, check, restore, verify or session in either language; both locales have every word with the same placeholders; `accessLocale` over headers and browser lists. A Lab test (layer 4 may import both) checks that `accessLocale` agrees with `chooseLocale` and that the page's colours and mark are the tokens' and `markSvg()`'s.

### 4.3 Destinations (`agent-remote-lab/src/destinations.ts`)

```ts
export type Destination = 'chats' | 'assistants' | 'windows' | 'settings';
export type SettingsGroupId = 'general' | 'assistants' | 'computers' | 'privacy' | 'advanced' | 'account';
export type DefaultView = 'chats' | 'windows' | 'last';
/** The rail's and the tab bar's current destination: page=settings|assistants first, then the mode. */
export function destinationOf(url: URL, mode: WorkbenchMode): { destination: Destination; group?: SettingsGroupId };
/** The address of a destination over the current one: Settings and the directory keep the mode's place underneath. */
export function destinationUrl(url: URL, target: { destination: Destination; group?: SettingsGroupId }): URL;
/** The mode a page opens in: an address that names one wins, then the default view (last: the stored mode), then Window;
 *  a phone without a named Window opens Chats (I3b's home rule). */
export function initialMode(facts: { named?: WorkbenchMode; stored?: WorkbenchMode; defaultView: DefaultView; phone: boolean }): WorkbenchMode;
export function readDefaultView(stored: string | null): DefaultView;
```

Rows: every URL form the app writes today (`mode=bot` with and without `section`, `bot`, a session locator; `mode=window`, `window=`, `session=`, `agent=`; none) against both modes, with and without `page`; `destinationUrl` round-trips (`destinationOf(destinationUrl(u, d)) = d`) and leaves every other parameter as it was; `initialMode` over named × stored × default view × phone.

### 4.4 Settings groups (`agent-remote-lab/src/settings/settings-groups.ts`)

```ts
export type SettingsItemId = 'theme' | 'language' | 'motion' | 'defaultView' | 'mobileDisplay' | 'processMode' | 'notifications' | 'letters'
  | 'computers' | 'pairing' | 'cache' | 'supportSharing' | 'layoutDiagnostics' | 'trace' | 'inspector' | 'account' | 'security' | 'signOut' | 'versions';
export type ComputerItemId = 'agents' | 'previews' | 'vscodeTunnel' | 'controllerUpdates' | 'smartReading' | 'hostSecurity';
export interface SettingsFacts { readonly account: boolean; readonly supportAvailable: boolean; readonly notificationsAvailable: boolean }
export function settingsGroups(facts: SettingsFacts): readonly { id: SettingsGroupId; items: readonly SettingsItemId[] }[];
export function computerItems(computer: { owned: boolean }): readonly ComputerItemId[];
```

Rows: the six groups in order whatever the facts; Account, Security and Sign out only for a signed-in account (not the Devbox); support sharing when the account may share; notifications where the device can show them; a computer's Controller updates, smart reading and keys only for its owner (`access: 'owner'` in `GET /v1/remote/hosts`); and **one home**: over every combination of facts, each item is in exactly one group.

### 4.5 Language and motion choices

```ts
// agent-client/src/presentation/messages/index.ts
export type LanguageChoice = 'browser' | Locale;
export function readLanguageChoice(stored: string | null): LanguageChoice;
export function effectiveLocale(choice: LanguageChoice, languages: readonly string[]): Locale;
// agent-client-web/src/theme/motion.ts
export type MotionChoice = 'system' | 'reduce';
export function readMotionChoice(stored: string | null): MotionChoice;
export function reducesMotion(choice: MotionChoice, system: boolean): boolean;
```

`agent-client-web` binds them: `bindLanguage(document, storage, navigator)` and the motion port read the keys, listen to `storage` events and an in-page change, set `<html lang>` and `data-motion`. `LocaleProvider` replaces the Lab's module-level `browserLocale()`.

### 4.6 Catalogue layout (`agent-client/src/presentation/messages/`)

`index.ts` (the mechanism: `Locale`, `Message`, `translator`, `chooseLocale`, `effectiveLocale`, plurals, `messageCatalogue`), `en.ts` and `zh.ts` (the merged tables) and `areas/<area>.en.ts`, `areas/<area>.zh.ts`. A Chinese area is `{ readonly [K in keyof typeof area]: Message }`, so the type check fails on a missing or extra key; `MessageKey` is the union of every English area. Keys are prefixed by area (`composer.*`, `settings.*`, …; the I3 keys keep theirs). The package's public surface is unchanged (`translator`, `useTranslate`).

## 5. Tasks

**For every task:**
- Work in `.worktrees/im-session-service`; `pnpm task:start` once before Task 1. Others work in this worktree: commit by path, never `-a`, and end each message with the `Co-Authored-By` line.
- jsdom suites on Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- Run only what the task touched: `pnpm test:unit <package> <file>`, and `npx playwright test --config=playwright.components.config.ts <spec> --project=<one or two>` from `packages/agent-remote-lab`. The full components suite and `pnpm verify` run once, in Task 12.
- Each commit lowers the legacy budget it moved, keeps `pnpm arch:check` green, and states its state accounting (section 7).
- Before a commit that changes package exports: `pnpm compatibility:update`, then `pnpm compatibility:check`.

### Task 0. Baselines (no commit)
`pnpm local up` (instance of this worktree, `agent-remote-controller-dev` only); captures `.tmp/i4/before-*.png` of section 8's screens; a production build of `b270a227` for the A/B arm of Task 12 (`ARC_LOCAL_WEB_DIST`).

### Task 1. Catalogue in areas, the language and motion choices
**Files:** `presentation/messages/**` (the I3 keys move to `areas/conversation.*`), `presentation/messages.test.ts` (merged tables, no key in two areas); `agent-client-web/src/react/locale.tsx` (`LocaleProvider` over the stored choice), `src/browser.ts` (`bindLanguage`, the motion port with the stored choice), `theme/tokens.ts` → `theme.css` (`[data-motion="reduce"]` durations); `agent-remote-lab/src/App.tsx`, `main.tsx` and the fixture pages (the provider instead of `browserLocale()`); `e2e/components/english-words.ts` (new: every visible text node, accessible name, `title` and placeholder of a page, minus `code`, `pre`, `kbd`, paths, the user's own content and an allowlist of proper names: Orchard, Claude Code, Codex, Copilot, OpenCode, Agent, Host, Controller, VS Code, Trace, Inspector, Mac and Host names in the fixture).
**Tests:** `messages.test.ts` over every area; `locale.test.tsx`: a stored `zh` wins over an English browser and `browser` follows it, a change re-renders and sets `<html lang>`, another tab's change arrives; motion rows and the port.

### Task 2. The rules
**Files:** `composer-menu.ts` and `.vectors.ts` and `.test.ts` (`agent-client-web/src/react`); `access-page.vectors.ts`, `access-page.test.ts` and the pure part of `access-page.ts` (`agent-relay-core/src`); `destinations.ts`, `settings/settings-groups.ts` and their vectors and tests (`agent-remote-lab/src`); `effectiveLocale`, `readLanguageChoice` (catalogue) and `readMotionChoice`, `reducesMotion` (`theme/motion.ts`) with their rows.
**Tests:** each table row by row, with the mutation named in section 4 recorded in the commit. `pnpm test:unit agent-client-web src/react/composer-menu.test.ts`, `pnpm test:unit agent-relay-core src/access-page.test.ts`, `pnpm test:unit agent-remote-lab src/destinations.test.ts src/settings`, `pnpm test:unit agent-client src/presentation`, `pnpm test:unit agent-client-web src/theme`.

### Task 3. The composer capsule
**Files:** `AgentComposer.tsx`, `ComposerMenu.tsx` (new, replaces `AgentActionToolbar.tsx`), `AgentSessionSettings.tsx` (its trigger items come from the menu; panels unchanged), `AgentActivityStatus.tsx` → `InterruptButton.tsx`, `PendingSendQueue.tsx` (words only), `styles.css` composer section rebuilt on `--orchard-*`, `app.css` composer overrides deleted; `areas/composer.*`; Lab callers that read the toolbar (`e2e/composer-actions.ts`, `agent-e2e/specs/composer-actions.ts`) re-pointed to the menu.
**Tests:** `AgentComposer*.test.tsx` keep their rules, re-pointed from the toolbar to the menu (one mapping line each in the commit); `ComposerMenu.test.tsx`: the menu shows exactly `composerMenu`'s items, disabled items keep their note, Escape and outside press close it and return focus to "+", arrow keys move; `AgentComposer.handoff.test.tsx` and E9 unchanged. **Component:** `composer-overflow.spec.ts`, `composer-send-press.spec.ts`, `image-input.spec.ts`, `resource-input` and `assistant-phone.spec.ts` re-pointed; a new `composer-capsule.spec.ts` (both themes, desktop and 390 × 844): the capsule's radius and fill, send `brand` with `on-brand` ink at AA, 44 px targets under a coarse pointer, the keyboard emulated by a `visualViewport` resize keeps the capsule visible with the last bubble steady, and `coveringControls` empty with the menu closed.

### Task 4. The access pages
**Files:** `agent-relay-core/src/access-page.ts` (words for both locales, `accessPageStyle()`, `accessMark`, one `accessDocument({ view, locale, origin })` for the Relay's three pages), `auth-callback.ts`, `auth-error.ts`, `cli-access.ts` (each takes the request's `Accept-Language`; the CLI page's words join the table), `gateway.ts` (passes the header); `agent-remote-lab/src/components/AccessPage.tsx` (reads `accessView`; the locale from the choice), `GatewayController.tsx` (no change of states); `agent-remote-lab/src/access-brand.test.ts` (new: the page's colours equal `orchardColors`, its mark is `markSvg()`'s drawing, no sentence has a connection word, `accessLocale` agrees with `chooseLocale`).
**Tests:** `access-page.test.ts` (the vectors; the Relay's HTML for each state has the mark, one `h1` only for a card, `role="status"` for a wait, the CSP hashes still match its style and script, `lang` follows the locale); `google-auth.test.ts`, `cli-access.test.ts` and `GatewayController.test.tsx` re-pointed to the new words; `e2e/auth-entry.spec.ts` re-pointed (the wait is a status sentence, the card's heading and action) plus a zh pass and a check that a 100 ms check paints no text. Captures of every state, both themes, both locales.

### Task 5. Navigation: the rail and the tab bar
**Files:** `shell/NavigationRail.tsx` and `shell/TabBar.tsx` (new; `shell.css`), `app/WorkbenchView.tsx` (the rail before both modes' sidebars on desktop, the tab bar under every phone screen; Settings and the directory as main content), `hooks/useWorkbenchMode.ts` (reads `initialMode`, `destinationOf`; `navigate(destination, group?)` writes `destinationUrl`), `workbench-mode.ts` (keeps `page` and `group` beside the place), `shell/SidebarHeader.tsx` (no switch and no Search: a title, the Wordmark in Chats, and the + actions), `components/BotWorkspace.tsx`, `BotRoster.tsx` and `bot-roster.ts` (Chats: `projectChats`, pinned first then by last activity, then Other sessions), `components/assistant/AssistantDirectory.tsx` (new: every group, every bot with hidden and resting marked, the group actions, New assistant, Show in Chats), `app/views/MobileNavigation.tsx` (the tab bar replaces "Sessions"; the launcher row stays above it), `GlobalViewOptions.tsx` and `WindowRecovery.tsx` (no switch), `state/palette-actions.ts` and `shell/command-items.ts` (Chats, Assistants, Windows and Settings by name; Switch mode goes), `device-link.ts` (the rail's avatar and the Me tab claim the indicator: the dot, its words as a popover with Retry or Sign in), `areas/navigation.*`.
**URL contract:** every row of section 4.3's table is a test; `App.bot-mode.test.tsx` gains: a `?mode=window&window=…` link, a `?mode=bot&section=…&bot=…` link and a session link open the same place as before; Settings and back keep the chat and its draft; the phone's back gesture leaves a pushed conversation and then Settings.
**Tests:** `NavigationRail.test.tsx` and `TabBar.test.tsx` (`aria-current` from `destinationOf`, the avatar's dot and words for each link state, Search opens the palette); `bot-roster.test.ts` (Chats order: pinned, activity, never hidden; the directory: every bot, hidden and resting marked, groups in catalog order); the re-pointed tests of the switch and the footer (`WorkbenchModeSwitch.test.tsx` and `SidebarFooter.test.tsx` deleted with their components, their rules mapped). **Component:** `navigation.spec.ts` (new; desktop and 390 × 844, both themes, both locales): the rail and the tab bar, 44 px targets, `coveringControls` empty on Chats, a conversation, Windows and Settings, the tab bar inside the viewport with the keyboard emulated; `launcher-layout.spec.ts`, `assistant-phone.spec.ts`, `assistant-view.spec.ts` and `standalone-layout.spec.ts` re-pointed.

### Task 6. One Settings page
**Files:** `settings/SettingsPage.tsx` (new: the group list in the sidebar's place and the group in the content panel on the desktop; the list, then a pushed group, on the phone), `settings/GeneralSettings.tsx` (Theme, Language, Reduce motion, Default view, and `MobileDisplaySettings`), `settings/AssistantSettings.tsx` (default process mode, notifications, team messages), `settings/ComputerSettings.tsx` (the Hosts overview as a list; a Host's page: online state, OS and Controller version with its update from `ControllerUpdates`, agents from `HostProviders`, the smart-reading switch per provider, the Codex daemon, the VS Code tunnel, previews, rotate, stop and revoke; Pair a computer from `PairingKeys`), `settings/PrivacySettings.tsx` (`CachePrivacySettings`, `CallForSupportSettings`), `settings/AdvancedSettings.tsx` (`LayoutDiagnosticsSettings`, Open Trace, Show Replica Inspector), `settings/AccountSettings.tsx` (identity, Security, Sign out, the web build and each Controller's version), `settings/settings.css`; `directory-client.ts` (`smartReading(hostId)`, `setSmartReading(hostId, providerId, enabled)`; `request` sends a body on `PUT`); the moved components keep their behaviour and tests (props from the page instead of `useViewModel`); `useViewModel.tsx` (no `sessionPanelContent` for settings and hosts), `state/panels.ts` (no settings or hosts page), `SessionsPage.tsx` (All sessions and Favorites only), `GatewayController.tsx` (the account action becomes data for Settings: identity, Security, Sign out), `components/assistant/AssistantDetails.tsx` (no device default, notifications or letters), `SessionViewOptions.tsx` and `ViewOptions.tsx` (no device default, letters, notifications or switch), `areas/settings.*`, `areas/hosts.*`.
**Tests:** `SettingsPage.test.tsx` (the groups from `settingsGroups`, the phone list and back, each choice writes its key and shows at once: Theme sets `data-theme`, Language re-renders in Chinese, Reduce motion sets `data-motion` and is locked on when the system reduces, Default view decides the next open); `ComputerSettings.test.tsx` (an owned Host shows its smart-reading switch and `PUT`s `{ providerId, enabled }`, a shared Host shows none, a refusal says so and restores the switch); the moved components' own tests unchanged in intent; `App.hosts-page.test.tsx` re-pointed to Settings > Computers; `AssistantDetails.test.tsx` (only name, avatar and this assistant's process mode). **Component:** `settings.spec.ts` (new; desktop and 390 × 844, both themes, both locales: every group, AA contrast, 44 px targets, no horizontal overflow, `english-words` empty in Chinese); `pairing-keys.spec.ts`, `layout-diagnostics.spec.ts`, `security.spec.ts`, `controller-updates.spec.ts`, `vscode-tunnel.spec.ts`, `call-for-support.spec.ts` re-pointed to their group.

### Task 7. Every remaining word in the catalogue
**Split by area, each with its own area files, run in parallel on disjoint files:** `timeline` (`agent-client-web/src/react/**` outside the composer), `errors` and `sessions` (`agent-client/src/client`, `succession`, `replica` and the Lab's root modules: `session-description.ts`, `session-forks.ts`, `prompt-edit-succession.ts`, `directory-client.ts`, …), `sessions` (the Lab's session components: succession dialog, links, references, quotes, scanner, tracking, native commands, connection notices), `team` (TPM, Team, Ask, call for support, favorites), `windows` (Window mode components, docks, workspaces, toolbar, menus, `useWindowWorkspace` and the other hooks), `diagnostics` (Trace, Replica Inspector, layout diagnostics). Files that Tasks 3 to 6 rewrote are theirs.
**Rule for each string:** English byte-identical; Chinese in the design's voice (plain, short, friendly; "好的 / 先别 / 看看要改什么"); proper names, commands, paths and code stay as they are; a React component reads `useTranslate()`; a pure function takes `t`; an error made for a person gets `messageKey`.
**Tests:** each package's touched files (`pnpm test:unit <package> <files>`), the type check, and `english-words` on every fixture page the area renders (Task 12 runs them all).

### Task 8. CSS: the last legacy views on Orchard
**Files:** `tpm.css`, `ask.css`, `ask-resize.css`, `session-view-responsive.css`, `session-view-options.css`, `app.css` (the compact layout's heading, empty views and dock rail; the `--obs-*` aliases that reach zero uses), `session-dock.css` (the rules the Window canvas replaced that still style the compact rail), `styles.css`; `TpmWorkspace.tsx`, `AskConversation.tsx`, `SessionHeading.tsx`, `SessionDock.tsx` and the empty views, onto `--orchard-*` and the primitives (`FloatingPanel`, `Pill`, `Card`, `SegmentedControl`); dead selectors (no element emits them) deleted; `ui/legacy-token-budget.json` lowered in each commit.
**Measure:** production CSS lines as I3a measured them (the Lab and the Session View without `theme.css` and `primitives.css`), at most 4,271 at the end of I4; each commit states its change.
**Tests:** `tpm-dock.spec.ts`, `ask-timeline-layout.spec.ts`, `session-view-responsive.spec.ts`, `dock-title-interactions.spec.ts`, `session-family-resize.spec.ts`, `composer-overflow.spec.ts` (their `webkit-ask-*` projects and `chromium-desktop`), `launcher-layout.spec.ts`; a contrast row for the TPM and Ask fixtures in both themes; captures of the compact layout, TPM and Ask before and after.

### Task 9. The installed app
**Files:** `index.html` (`apple-mobile-web-app-title`), `app.css` (the root and `body` paint `--orchard-ground`), `public/app/manifest.webmanifest` (unchanged values, `"lang"` absent: the app speaks both), `brand-assets.test.ts` (the title meta, the root ground), `e2e/components/installed-app.spec.ts` (new; `webkit-mobile-viewport` and `orchard-phone-webkit`, with `navigator.standalone` true): the manifest and the Apple metas; the theme colour follows System, Light and Dark, pinned before the first paint; the root's computed background is each theme's ground; the tab bar, the capsule and the sheet stay inside the viewport with the keyboard emulated; `coveringControls` empty on Chats, a conversation and Settings.

### Task 10. Deletion
Section 6's list, each with the test that now owns its rule in `docs/superpowers/specs/2026-11-21-i4-test-mapping.md`; `pnpm verify:changed`.

### Task 11. E11: Settings on the real stack
**Files:** `agent-e2e/flows/e11-settings.e2e.ts` (new), `flows/page.ts` (helpers: `openSettings`, `chooseSetting`).
**E11 (desktop 1280 × 800 and 390 × 844; `E2E_BROWSER=webkit` for both):** open an assistant's chat and type a draft; open Settings from the rail (the Me tab on the phone); choose Dark, then 中文, and see the page in Chinese with `<html lang="zh-CN">`; in Computers, turn smart reading off for the scripted provider and see the Relay answer without it, then on again; go back to Chats and find the same assistant open with the draft; no word of the T5 list in any frame.

### Task 12. Acceptance
1. `pnpm test:components` once (if a test fails under load, run it alone three times and report what it did), `pnpm test:preview-browser`, `pnpm test:e2e:flows` (E1 to E11; E9 to E11 also with `E2E_BROWSER=webkit`), `pnpm verify`.
2. `pnpm compatibility:update`, then `pnpm compatibility:check`; `pnpm arch:check`; `pnpm fixtures:check`.
3. Section 8 on `pnpm local`.
4. T1 and T5 at 4x CPU and 100 ms RTT, A/B against production `b270a227` on the same instance and data (`ARC_LOCAL_WEB_DIST`): `local-baselines.mjs --scenarios open-known --throttle 4 --rtt 100 --reps 10` and `session-control.mjs --throttle 4 --rtt 100 --opens 10 --sends 3 --type-during-open`, run back to back; anything slower than production is fixed before the report.

## 6. Deletions

Earlier work this step makes unnecessary:
- `AgentActionToolbar` and its width fitting, the composer's activity label and elapsed time (the status line says them), the composer rules in `styles.css` that `app.css` overrode, and those overrides.
- The access pages' progress row, eyebrow, generic glyph and the unused `restoring` state.
- The Window/Bot switch (`WorkbenchModeSwitch`), `SidebarHeader`'s switch row, `SidebarFooter` and its `hostSummary`, the old settings panel and its page in `SessionsPage`, the details panel's device default, notifications and letters rows, the module-level `browserLocale()` in `App.tsx`.
- The Hosts page and the settings panel in `SessionsPage` and `panels.ts`, the compact drawer's "Sidebar sections" Hosts and Settings, the hidden app bar's account actions, the palette's mode switch, the duplicate controls of the device process default, letters and notifications.
- Legacy rules of the compact layout, TPM and Ask views and their budget entries; `--obs-*` aliases that reach zero uses.
- `I3`'s English-only detail strings, as literals.

## 7. State accounting

Roadmap rule 1: fields and paths, +N/−M.

| Change | Fields | Paths |
|---|---|---|
| Rules (4.1 to 4.5) | +0 state; +9 functions (`composerMenu`, `accessLocale`, `accessView`, `destinationOf`, `destinationUrl`, `initialMode`, `settingsGroups`, `effectiveLocale`, `reducesMotion`) | 0 |
| Composer | −1 component (the fitted toolbar) and its measuring state; +1 menu open flag (the draft's `view` gains `'menu'`) | 0 |
| Access pages | −1 state (`restoring`), −3 page elements | 0 |
| Navigation | −1 control (the switch), −1 footer; +1 URL parameter pair (`page`, `group`); +1 stored key (`agent-remote:default-view`) | 0 |
| Settings | −1 panel; +1 page (moved components, 0 net); +2 stored keys (`agent-remote:language`, `agent-remote:motion`), +1 root attribute (`data-motion`) | 0 |
| Catalogue | +~2,200 keys per locale, −the same literals | 0 |

**Why something is added:** the language, motion and default-view choices and the Settings page are the owner's approved design; `page` and `group` give Settings and the directory an address so the way back keeps the chat. **Budgets:** the legacy ratchet only falls; net production CSS of I3 plus I4 at most 0 against `ac075f9d`; the entry chunk stays under 70 KB gzip; the App chunk's growth from the Chinese tables is measured, and if it passes the 600 KB budget the Chinese areas load as their own chunk, before the first render, for a Chinese reader only.

## 8. Verification on `pnpm local`

`pnpm local up` in this worktree; `agent-remote-controller-dev` only; a headless browser only; never the owner's Controller or production. Captures in `.tmp/i4/`, light and dark, English and Chinese:
1. Desktop Bot mode (Chats) with the rail, a conversation and its details; Window mode with tiles; Settings, each group; the Assistants directory.
2. Phone 390 × 844: Chats (the list), a conversation with the composer focused and the keyboard emulated, the details sheet, Settings from Me.
3. The access page: a long check (the mark and its sentence), sign-in, expired and unavailable; the Relay's callback page.
4. A real turn with Claude Code: the capsule while it runs (stop beside send), the "+" menu, an image added, Queue for next turn.

## 9. Results

Filled in per task: commits, suites and counts, the CSS line count against `ac075f9d`, the ratchet, T1 and T5 against production, the captures and deviations.
