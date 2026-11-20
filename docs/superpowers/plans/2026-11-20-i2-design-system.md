# I2: Design system

**State: implemented (2026-11-20), awaiting the owner's review.** I2 is the second Orchard step (roadmap "Next: Orchard"; [Orchard design](../specs/2026-11-20-orchard-im-experience-design.md), "Visual language", "Phone", "Two views of the same assistants", step I2 and Acceptance). It delivers the system that I3 builds Bot mode and Window mode on: tokens, light and dark themes, primitives, avatar generation, the Orchard mark and wordmark, and fixture pages. It does not redesign a screen. The approved values are the CSS of [`mockup.html`](../specs/assets/2026-11-20-orchard/mockup.html) (v9, its `.theme-light` and `.theme-dark` blocks and the `/* v6 */` overrides) and option 1 of [`logo.html`](../specs/assets/2026-11-20-orchard/logo.html) (symbol `t1`, drawing `kid`).

## 1. For the owner

**What you will see.**
- Bot mode's pictures become the new assistants: flat soft shapes with two dark eyes, slowly changing outline, a bob while working, a pop when they need you, grey while resting.
- The Bot and Window mode switch becomes an orange pill segmented control. The phone sheets get the new surface, radius and safe-area padding.
- The tab icon, the home-screen icon, the installed app's name and the page title become Orchard.
- A new **Appearance** choice (System, Light, Dark) in the command palette. Today the page follows the system only.
- Everything else looks as it does today. I3 moves the screens.

**Where to review it.** On `pnpm local`, the fixture page `/e2e/fixtures/orchard-primitives.html` shows every primitive in both themes. Use the `?theme=` and `?width=phone` switches. The page shows avatars in every state and size, and the logo at every size.

**Deploy.** One Relay release, then a website release. The Relay must go first because the stored bot picture gains shapes and a gaze (section 4.4). The website only reads pictures in I2, so the order is a safety margin rather than a hard need. No Controller change.

## 2. Today

| Piece | Where | What it does |
|---|---|---|
| Lab tokens | `agent-remote-lab/src/ui/tokens.css` (121 lines) | About 60 `--ui-*` semantic tokens: an Apple-like blue accent, 6 to 18 px radii, a type scale with a 14 px body, two durations and two easings. Light sits in `:root` and dark in `@media (prefers-color-scheme: dark)`, duplicated name by name. Reduced motion sets durations to 0. There is no user override. |
| Lab aliases | `app.css:14-40` (`--obs-*`, 770 uses), `app.css:125-` (maps every `--agent-*` to `--obs-*`/`--ui-*` inside `.lab-shell, .lab-session-view, …`) | Three variable families chained onto `ui/tokens.css`. The counts of `var(--…)` uses across both packages: `--ui-*` 470, `--obs-*` 770, `--agent-*` 463. |
| Session View defaults | `agent-client-web/src/styles.css:1-34` (1,063 lines) | About 30 `--agent-*` variables with light values only. This is the published package's public styling surface, and a standalone host overrides them. Its font is IBM Plex Sans Condensed, with mono kickers in capitals. |
| Literal rule | `agent-remote-lab/src/ui/stylesheets.test.ts` | No colour literal outside `ui/tokens.css`. The shared `:root` and `.agent-file-html` are exempt. There is no undefined variable, no shadow mixed from a text colour, and one focus ring. |
| Token contrast | `agent-remote-lab/src/ui/tokens.test.ts` | It parses the two `:root` blocks, checks text pairs against 4.5:1, and checks the manifest colours (`#ffffff`). |
| Lab primitives | `agent-remote-lab/src/ui/` (Avatar, Button, IconButton, ListRow, Menu, SegmentedControl, Sheet, StatusBadge, Toolbar; 1,088 lines) and `ui.css` (188) | Apple-like controls. `Avatar` is a coloured circle, rounded square or hexagon with an initial, and its colour comes from a hash of the name (`avatarColor`). `SegmentedControl` (1 user: `WorkbenchModeSwitch`) and `Sheet` (5 users: `WindowSheets`, `RemoveBotSheet`, `BotActions`, `NewBotSheet`, `WindowWorkspaces`) are dialog and keyboard implementations with their own tests. `e2e/ui-primitives.browser.ts` checks that the Lab's container rules do not restyle them. |
| Bot picture | `agent-remote-protocol/src/window-groups.ts:15` `WindowBotDetails.picture: { shape: 'circle' \| 'rounded' \| 'hexagon', color: '#rrggbb' }` | Stored per bot in the account's Window groups at the Relay (`agent-relay-core/src/window-workspaces.ts`, keyed by the account `subject`). It syncs to every device. No UI writes it today; only `e2e/bot-mode.spec.ts:399` writes one. `BotPicture` (`components/BotRoster.tsx:16`) and the folded card (`SessionDock.tsx:204`) draw it. |
| Brand | `public/favicon.svg` ("AR" on blue), `public/app/icon-192.png`, `icon-512.png`, `manifest.webmanifest` ("Agent Remote Control", white), `index.html` theme-color metas, `useHostAndStack.ts:100` (`… · Agent Remote Control`) | The Relay serves exactly these paths (`agent-relay-node/src/gateway-static.ts:18`, `agent-relay-cloudflare/src/worker.ts:28`). |
| Motion queries | Seven scattered `matchMedia('(prefers-reduced-motion: reduce)')` reads | Nothing animates continuously today. Nothing reads page visibility for motion. |
| Component tier | `agent-remote-lab/e2e/fixtures/*.html` + `.tsx` served by Vite; `e2e/components/*.spec.ts`; `playwright.components.config.ts` (projects: Desktop Chrome, Pixel 7, iPhone 13 WebKit) | `touch-targets.spec.ts` checks one button. No project runs at exactly 390x844. |

## 3. Decisions

These settle the brief with the design and the owner's taste decisions. Each one is final for I2.

1. **One token module, in `agent-client-web`.** `packages/agent-client-web/src/theme/` holds the tokens as typed data (`tokens.ts`) and the stylesheet generated from them (`theme.css`). It is its own architecture module (section 4.6). There are three reasons:
   - the conversation primitives (bubble, work-summary line, approval card, session-change line, avatar) are drawn by the timeline, which lives in `agent-client-web` and cannot import the Lab (layer 4);
   - the published Session View must look like Orchard when it runs standalone;
   - the Lab already imports `agent-client-web`, so both packages read one source.
   The headless `agent-client` bans DOM and React, and tokens are not client state.
2. **Tokens are data, and the CSS is generated from them.** Contrast rules, the avatar palette and the manifest colours are checked against the same values the CSS carries. `theme.css` is committed, and a unit test fails when it differs from `renderThemeCss(tokens)`.
3. **Themes switch through `color-scheme`, not duplicated blocks.** Every colour token is one declaration, `light-dark(<light>, <dark>)`:
   - `:root` has `color-scheme: light dark`, which follows the system;
   - `:root[data-theme="light"]` and `[data-theme="dark"]` pin the theme.
   The user override is therefore one attribute. Native controls and scrollbars follow it. `light-dark()` needs Safari 17.5 and Chrome 123, which every supported browser has (November 2026). I2 converts the legacy `ui/tokens.css` to the same form, so the override covers today's screens at once, with no value change.
4. **The override is per device.** The appearance (System, Light, Dark) is kept in `localStorage` as `agent-remote:appearance`. It follows the per-device rule of the IM session service design (layout and tab-local state). It is not in `conversation-storage`'s content prefixes, so "clear on close" keeps it.
5. **Contrast wins over a mockup grey.** The design requires WCAG AA for text in both themes. Where a mockup value fails, the token moves to the nearest value that passes on every surface it sits on. The hue stays.
   - The mockup's muted `#a0a3aa` is 2.5:1 on white. It survives only as `ink-faint`, for non-text marks.
   - Secondary text becomes one grey, about `#696d75` light (4.5:1 on the ground, the worst surface) and `#9a9da4` dark. This merges the mockup's `soft` and `muted`, so there is less grey than today.
   - White on the brand orange `#ff7f45` is 2.5:1. The ink on brand fills (primary pill, selected segment, send arrow) is therefore the dark ink `#1d1d1f` (6.7:1), in both themes. The orange itself stays exactly `#ff7f45`.
   - The focus ring is the brand hue at 3:1 or more: about `#d9581c` light (3.4:1 on the ground) and `#ff7f45` dark (6.2:1).
6. **Avatars follow the owner's rules exactly** (section 4.4): shape × colour × gaze; flat, matte, solid soft shapes with no tile, texture, gradient, mouth or blush; two dark vertical oval eyes, off-centre; a flowing outline; working bob, needs-you pop, resting grey; and motion off for reduced motion, below 24 px, and on a hidden page. The eyes do not drift. The mockup's eye drift is not in the owner's list.
7. **The avatar override lives with the bot, per account.** It is `WindowBotDetails.picture` in the account's Window groups at the Relay, beside the label, pin and sleep. These are synced, per-account bot details, as the IM design's per-account rule requires. The seed is the bot's view id (the `members` key), which survives a handoff. Window tiles of the same session read the picture from its Bot-mode group, as `useSessionViewPresentation.tsx:249` already does.
8. **Distinct by storing, deterministic until then.** `avatarFor(id)` is a pure hash. `distinctAvatar(id, taken)` probes from the hashed pair to the first shape × colour pair the account has not used. I3 writes the result into `picture` when it creates an assistant, which is when the design says avatars are generated. Until then a bot shows `avatarFor(id)`. Two unstored bots can share a pair; I3's creation and its picker remove that.
9. **Wordmark and mark.**
   - The wordmark is lowercase "orchard" in `ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif` at weight 750. No font is bundled, because SF Pro is licensed for Apple platforms only. Elsewhere the system sans at 700 or 800 is used.
   - Running text says "Orchard".
   - The mark's colours are brand tokens, the same in both themes. The mark is static at 32 px and below. Above that, its eyes glance and its sprout sways, under the same motion rule as avatars.
10. **Brand assets ship in I2, at the paths the Relay already serves.**
    - `favicon.svg`, `app/icon-192.png` (also the apple-touch-icon) and `app/icon-512.png` are redrawn from the one mark.
    - The manifest becomes "Orchard" with the ground colour.
    - The page title becomes "Orchard".
    - There is no maskable icon and no new path, so the Relay allowlists stay as they are. I4 may add a maskable icon together with the allowlist.
    - The access page, the about page and the in-app wordmark are placed in I3 (sidebar) and I4 (access page).
11. **The I2 primitives replace their Lab counterparts; nothing else moves.** I2 has a counterpart for `Avatar`, `SegmentedControl` and `Sheet`, and each becomes one implementation in `agent-client-web`:
    - `Avatar` is replaced by `AssistantAvatar`;
    - `SegmentedControl` and `Sheet` move with their behaviour and tests, and are restyled on tokens.
    `Button`, `IconButton`, `ListRow`, `Menu`, `Toolbar` and `StatusBadge` have no I2 counterpart. They stay on legacy tokens until I3 or I4 rebuilds their screens.
12. **The bot picture schema is changed, not extended.** `shape` becomes `circle | squircle | triangle | sideways`, and `picture` gains an optional `gaze` (0 to 5). Stored legacy values are read through one mapping: `rounded` and `hexagon` become `squircle`, and the gaze comes from the id. This is the Window workspace API rather than the session protocol: no message, entry type or refusal is added, and rule 5 is met by replacing the shape set.

## 4. Interfaces

### 4.1 Token module

```ts
// agent-client-web/src/theme/tokens.ts (pure data and functions; exported as `@orchardworks/agent-client-web/theme`)
export type ThemeName = 'light' | 'dark';
export interface ThemedColor { readonly light: string; readonly dark: string } // #rrggbb or rgb(r g b / a)
export const orchardColors: Readonly<Record<OrchardColorName, ThemedColor>>;   // section 4.2
export const orchardRadii, orchardSpace, orchardType, orchardElevation, orchardMotion, orchardBreakpoints; // section 4.2
export const avatarPalette: readonly AvatarColor[];                              // 8 fills, the same in both themes
export const brandColors: { tile: '#24242a'; body: '#ff7f45'; stem: '#2f8f55'; leaf: '#4cc27a'; eye: '#16161a' };
/** Text pairs the theme promises: [text token, surface token, minimum ratio]. The contrast test reads this. */
export const textPairs: readonly (readonly [OrchardColorName, OrchardColorName, 4.5 | 3])[];
export function contrastRatio(a: string, b: string): number; // WCAG 2.x relative luminance; alpha composited over the second colour
export function renderThemeCss(): string;                     // the exact text of theme.css

// agent-client-web/src/theme/appearance.ts (pure; storage and the root element are ports)
export type Appearance = 'system' | 'light' | 'dark';
export interface AppearancePort { read(): string | null; write(value: Appearance): void; setTheme(theme: ThemeName | undefined): void; setChromeColor(color: string, theme: ThemeName | 'system'): void }
export function readAppearance(stored: string | null): Appearance;          // anything unknown → 'system'
export function applyAppearance(port: AppearancePort, appearance: Appearance): void; // sets or clears data-theme and the theme-color metas
```

- **Generated CSS.** `theme.css` declares every token on `:root` as `--orchard-<name>`, with colours as `light-dark()`, plus `color-scheme` and the two `[data-theme]` rules.
  - Under `prefers-reduced-motion: reduce` the generated CSS sets the durations to 0.
  - It declares no `@keyframes`; primitives own their keyframes and read motion tokens.
  - `pnpm --filter @orchardworks/agent-client-web theme:write` regenerates it (Node strips the types).
- **Browser binding.** `agent-client-web/src/browser.ts` gains `bindAppearance(document, localStorage): { appearance: Appearance; set(next: Appearance): void }`. It is the only code that touches `document.documentElement` and the `meta[name=theme-color]` tags for the theme.
- **Startup.** The Lab calls it first in `main.tsx`, before rendering, and the command palette sets it.
- **Package.**
  - Exports gain `./theme` (TS), `./theme.css`, `./primitives` (React) and `./primitives.css`.
  - The build copies both CSS files, as it copies `styles.css`.
  - The Lab's `main.tsx` imports `theme.css` first and `primitives.css` after `ui/ui.css`.

### 4.2 Token values

These are the mockup's values, with the contrast changes of decision 5. Task 1's contrast table fixes the exact adjusted hexes; the ones marked ≈ are starting points.

| Token | Light | Dark | Use |
|---|---|---|---|
| `ground` | `#f3efe9` | `#151517` | The warm ground the panels float on |
| `surface` | `#ffffff` | `#232327` | Panels, the selected segment's surround |
| `fill` | `#f4f4f6` | `#2f2f34` | Their bubble, chips, grouped rows, composer, segmented track |
| `fill-strong` | `#e8e8ec` | `#3b3b41` | Pressed and hovered fills, the toggle's off track |
| `tint` | `#fff1e6` | `#3a2d24` | Selected assistant, name card, approval card |
| `text` | `#2a2b30` | `#dcdde2` | Body |
| `text-strong` | `#1d1d1f` | `#f2f2f5` | Names, headings, the selected tab |
| `text-secondary` | ≈`#696d75` | ≈`#9a9da4` | Status sentences, times, work-summary line, labels |
| `ink-faint` | `#a0a3aa` | `#6a6d74` | Non-text only: list markers, the composer's + glyph, separators' ink |
| `mine` / `on-mine` | `#2a2b30` / `#ffffff` | `#f2f2f4` / `#1d1d20` | The user's bubble |
| `brand` / `on-brand` | `#ff7f45` / `#1d1d1f` | `#ff7f45` / `#1d1d1f` | Primary action, toggle on, selected mode, unread dot, send |
| `focus` | ≈`#d9581c` | `#ff7f45` | Focus ring, 2 px, offset 2 px |
| `danger-text` | ≈`#c4321f` | ≈`#ff7a6b` | Failure words (4.5:1 on `surface`, `fill` and `tint`) |
| `online` | `#39b56a` | `#39b56a` | The machine's online dot (non-text) |
| `separator` | `rgb(0 0 0 / .06)` | `rgb(255 255 255 / .07)` | Rare: the design separates by gaps |
| `shadow-ink` | `rgb(20 20 30 / .14)` | `rgb(0 0 0 / .5)` | Elevation only |
| `avatar-resting` | `#c9cbd0` | `#55575d` | A resting avatar's fill |

- **Avatar palette** (both themes): orange `#ff8a3d`, blue `#3d8bff`, violet `#8b6cff`, green `#34b878`, pink `#ff6fa8`, teal `#22b3c2`, yellow `#f2bf3a`, coral `#ff6b5e`. The first three are the mockup's. The eye `#16161a` must reach 3:1 (non-text) on each fill; violet is the lowest at 4.9:1.
- **Radii:**
  - `panel` 22 (also the sheet's top corners);
  - `bubble` 20, with `bubble-tail` 6 (the corner at the speaker's side: bottom-right for mine, bottom-left for theirs);
  - `card` 18, `row` 18, `group` 16, `composer` 24, `toggle` 10;
  - `pill` 999;
  - the mark's tile is 15/64 of its size.
- **Space:** `2xs` 2, `xs` 4, `s` 6, `m` 8, `l` 10 (panel gap), `xl` 14 (message gap), `2xl` 16 (panel padding), `3xl` 24 (conversation column padding), `4xl` 32. The conversation column is 580 px at most.
- **Type** (size/line-height and weight):

  | Token | Size and weight | Use |
  |---|---|---|
  | `caption` | 11.5/1.4 | |
  | `footnote` | 12.5/1.5 | |
  | `callout` | 13/1.5 | Pills, segments |
  | `body` | 14.5/1.6 at 400 | Bubbles and rows |
  | `headline` | 15 at 600 | Names, the title pill |
  | `title` | 18 at 700 | The name card |
  | `large-title` | 26 at 700 | |
  | `wordmark` | 17 at 750 | Rounded stack |

  Weights are 400, 600, 700, and 750 for the wordmark only. `font-text` is `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif`, `font-rounded` is decision 9's stack, and `font-mono` is today's.
- **Elevation:**
  - `flat`: no shadow, for panels on the ground (the mockup's v6 panels have none);
  - `popover`: `0 8px 24px shadow-ink`, for menus;
  - `lifted`: `0 -8px 32px shadow-ink`, for sheets, and `0 20px 48px` for floating panels over content.
- **Motion:**
  - durations: `fast` 150 ms, `base` 220 ms, `pop` 360 ms, `bob` 2.4 s, `glance` 5 s, `sway` 3.2 s;
  - `outline` from 5 to 7 s, chosen per assistant;
  - easings: `standard` `cubic-bezier(.2,.8,.2,1)` and `flow` `cubic-bezier(.45,0,.55,1)`.
- **Breakpoints** (not variables; written into primitive media queries from the data): `phone` 760 and `compact` 1180, which are today's.

### 4.3 Primitives

These live in `agent-client-web/src/primitives/`, are exported from `./primitives`, and are styled by `primitives.css`. That file uses only `--orchard-*` and contains no literal (section 4.6). Every primitive accepts `className`. None takes a colour prop except the avatar override.

```ts
export function Bubble(props: { from: 'mine' | 'theirs'; avatar?: ReactNode; delivery?: 'sending' | 'sent'; sendingLabel?: string; children: ReactNode }): JSX.Element;
export function Card(props: { tone?: 'plain' | 'tint'; children: ReactNode }): JSX.Element;
export function Pill(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'plain' }): JSX.Element;
export function SegmentedControl<T extends string>(props: /* today's Lab props, unchanged */): JSX.Element;   // moved
export function Toggle(props: { checked: boolean; label: string; onChange(next: boolean): void; disabled?: boolean }): JSX.Element; // role="switch"
export function AssistantAvatar(props: { id: string; picture?: BotPicture; size: number; mood?: AvatarMood; label?: string }): JSX.Element;
export function StatusLine(props: { avatar?: ReactNode; sentence: string; detail?: string; live?: boolean }): JSX.Element;    // "Chief 在想例子怎么写 · 认真工作中" with typing dots when live
export function WorkSummaryLine(props: { summary: string; open: boolean; onToggle(): void; children?: ReactNode }): JSX.Element; // button with aria-expanded; children are L2
export function ApprovalCard(props: { prompt: ReactNode; choices: readonly { label: string; primary?: boolean; onChoose(): void }[] }): JSX.Element;
export function SessionChangeLine(props: { children: ReactNode }): JSX.Element;   // "· 换到新的会话继续 ·", role="separator" with an accessible name
export function Sheet(props: /* today's Lab props, unchanged */): JSX.Element;     // moved; bottom safe-area inset; its Close is a Pill icon button
export function FloatingPanel(props: { as?: 'aside' | 'section' | 'div'; label?: string; children: ReactNode }): JSX.Element; // the 22 px panel; full-bleed at phone width
export function OrchardMark(props: { size: number; title?: string }): JSX.Element;
export function Wordmark(props: { size?: number }): JSX.Element;                 // mark + "orchard"
export function MotionProvider(props: { children: ReactNode; port?: MotionPort }): JSX.Element;
```

**Rules that the fixture specs pin:**
- **Touch targets.** Under `(pointer: coarse)` every interactive primitive's own box is at least 44 × 44. This covers the pill, segment, toggle, work-summary button, approval choice and sheet close. Where the drawn shape is smaller (the toggle is 34 × 20, the send glyph 32), the extra area is the element's padding, never a pseudo-element outside it.
- **Focus.** One ring: `outline: 2px solid var(--orchard-focus); outline-offset: 2px`.
- **Cascade.** Each root rule doubles its class, as `ui.css` does today, so the Lab's bare `button` rules cannot restyle it (`e2e/ui-primitives.browser.ts` extends to the new primitives).
- **Phone layout.** At phone width, `FloatingPanel` drops its radius and gap and pads by `env(safe-area-inset-*)`. `Sheet` pads its bottom by `env(safe-area-inset-bottom)`.

### 4.4 Avatar generation

```ts
// agent-client-web/src/theme/avatar.ts (pure)
export type AvatarShape = 'circle' | 'squircle' | 'triangle' | 'sideways';
export type AvatarGaze = 0 | 1 | 2 | 3 | 4 | 5;   // up-left, up-right, left, right, down-left, down-right
export interface AvatarRecipe { shape: AvatarShape; color: string; gaze: AvatarGaze; outlineSeconds: number; phase: number } // phase in [0, 1)
export type AvatarMood = 'idle' | 'working' | 'needs_you' | 'resting';
export function avatarFor(id: string): AvatarRecipe;                                   // FNV-1a 32-bit over the id → shape, colour, gaze, duration 5–7 s, phase
export function avatarWith(id: string, picture: BotPicture | undefined): AvatarRecipe; // the stored override wins, field by field; gaze absent → from the id
export function distinctAvatar(id: string, taken: readonly Pick<AvatarRecipe, 'shape' | 'color'>[]): AvatarRecipe; // first untaken pair from the hashed one; all 32 taken → avatarFor(id)
export const avatarShapes: Readonly<Record<AvatarShape, { base: string; keyframes: readonly [string, string, string]; eyes: readonly [[number, number], [number, number]] }>>; // 64×64 path data

// agent-client-web/src/theme/motion.ts (pure)
export interface MotionFacts { reducedMotion: boolean; pageVisible: boolean; size: number; mood: AvatarMood }
export interface AvatarMotion { outline: boolean; bob: boolean; pop: boolean; grey: boolean }
export function avatarMotion(facts: MotionFacts): AvatarMotion;
export function markMotion(facts: Omit<MotionFacts, 'mood'>): { glance: boolean; sway: boolean };
```

**Drawing.**
- An avatar is one SVG, 64 × 64 viewBox, with no tile or background.
- **Shape.** The shape path is filled with the palette colour, or `avatar-resting` when grey. The four bases are taken from the mockup symbols: `tri` (rounded triangle), `cir`, `tri2` (sideways) and a new squircle. Each is drawn slightly irregular. The three keyframes are the mockup's morph values.
- **Eyes.** Two ellipses (`rx` 3.6, `ry` 6.2, `#16161a` via `--orchard-avatar-eye`), offset by the gaze vector (about 4 to 5 units). They are never centred.
- **Outline flow.** It is one SMIL `<animate attributeName="d">` over the keyframes, with `calcMode="spline"` and the `flow` easing. It runs for the recipe's duration, starting at `begin = -phase × duration`. SMIL is used because CSS `d` animation is not available in Safari.
- **Bob, pop and grey.** These are CSS on the wrapper:
  - bob is a 2 px rise over 2.4 s;
  - pop is a scale of 1 → 1.12 → 1 over 360 ms, once when the mood becomes `needs_you`;
  - grey swaps the fill.

**Motion rule** (`avatarMotion`, unit table):
- `outline` iff not reduced, visible, `size ≥ 24` and mood is not `resting`;
- `bob` iff the same and mood `working`;
- `pop` iff the same and mood `needs_you`;
- `grey` iff mood `resting`, whatever the motion.

When `outline` is false the component renders no `<animate>` element at all. Removing the element is what stops it; the CSS animations are simply not applied. `markMotion` is the same rule with a 32 px threshold.

**Motion port.** `MotionProvider` subscribes once to `matchMedia('(prefers-reduced-motion: reduce)')` and `visibilitychange`, and gives every avatar and mark `{ reducedMotion, pageVisible }`. The port is injectable for tests. Without a provider, motion is off, which is the safe default.

**Bot picture schema** (`agent-remote-protocol/src/window-groups.ts`):
```ts
picture: Type.Optional(Type.Object({
  shape: Type.Union([Type.Literal('circle'), Type.Literal('squircle'), Type.Literal('triangle'), Type.Literal('sideways')]),
  color: Type.String({ pattern: '^#[0-9a-f]{6}$' }),
  gaze: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
}, strict)),
export function readBotPicture(stored: unknown): BotPicture | undefined; // legacy rounded/hexagon → squircle; anything else invalid → undefined
```
- **Legacy reads.** The Relay reads stored `bots` through `readBotPicture` (in `window-workspaces.ts`, where a saved group's `bots` are decoded), so stored legacy values keep decoding.
- **Frozen fixture.** `agent-remote-protocol/src/fixtures/window-bots.v1.json` holds a `rounded` picture and a `hexagon` picture, and must keep reading.
- **Writes.** A write must use the new set.

### 4.5 Mark, wordmark and assets

- **One drawing.** `agent-client-web/src/theme/mark.ts` exports the path data of `kid` and the tile (from `logo.html`: a 64 viewBox, rotated -14° about (32, 44), clipped to a 15 px-radius tile), plus `markSvg(): string`. That function returns the static SVG with brand literals, and is the favicon's source.
- **Component.** `OrchardMark` renders the same paths with `var(--orchard-brand-*)` fills, plus the glance and sway animations when `markMotion` allows them.
- **Generated files.** `scripts/brand-assets.mjs` (root, run by `pnpm brand:assets`) writes `packages/agent-remote-lab/public/favicon.svg` from `markSvg()`. It rasterizes `icon-192.png` and `icon-512.png` with Playwright Chromium from the same SVG, so they are cut from one drawing. All outputs are committed.
- **Manifest.** `name` and `short_name` are "Orchard", and `background_color` and `theme_color` are the light `ground`.
- **`index.html`.**
  - `<title>Orchard</title>`;
  - the theme-color metas are the two grounds;
  - the apple-touch-icon is `icon-192.png`.
- **Window title.** `useHostAndStack.ts` says `… · Orchard` and `Orchard`.

### 4.6 Architecture

- **New module.** `architecture/modules.json` gains `{ "name": "client-theme", "layer": 1, "paths": ["packages/agent-client-web/src/theme/**"] }`. It is added to the `domain-impure` ban (no DOM, timers, clock or random numbers), so tokens, avatar recipes, motion rules and appearance stay pure.
- **Existing modules.** `src/primitives/**` stays in `client-web` (layer 3) and imports `client-theme`.
- **The Lab.** It imports both only through the package's exports.
- **Literal rule.** It is extended in `ui/stylesheets.test.ts`:
  - colour literals are allowed only in `theme.css` (generated) and the legacy `ui/tokens.css`;
  - `primitives.css` uses no `--ui-*`, `--obs-*` or `--agent-*`;
  - no stylesheet uses an undefined `--orchard-*`.

## 5. Migration path

There is no big-bang rewrite. Every legacy colour already routes through one literal file, so screens move by selector, and a ratchet makes the progress visible.

1. **I2 (this step).**
   - The Orchard tokens exist.
   - `ui/tokens.css` keeps its names and values and becomes `light-dark()` pairs: one declaration per name instead of two, its two composite shadows split into ink tokens. `data-theme` therefore themes every screen.
   - The three replaced primitives move to Orchard (decision 11). Their old CSS is deleted.
   - **Ratchet.** `ui/legacy-token-budget.json` records, per stylesheet, the count of `var(--ui-|--obs-|--agent-` uses. `stylesheets.test.ts` fails when a count is above its budget, and also when it is below, so the budget is lowered in the same commit. The budget never rises: a new rule uses `--orchard-*`.
2. **I3.**
   - Bot mode's sidebar, conversation and details, Window mode's tiles, and the timeline items in `agent-client-web` are rebuilt on primitives and `--orchard-*` only.
   - Each rebuilt selector deletes its legacy rule rather than overriding it, and the budget drops with it.
   - The timeline's `--agent-*` defaults in `styles.css` are re-pointed to Orchard tokens (`--agent-ink: var(--orchard-text)`, …), so a standalone Session View host keeps its override surface and gets Orchard by default.
3. **I4.**
   - The remaining screens move: the access page, Hosts, settings, and the Trace and Replica Inspector, which are L3 but share the themes.
   - When a family's uses reach zero, its definitions go: `--obs-*` in `app.css`, then `ui/tokens.css` and the remaining Lab primitives.
   - `--agent-*` stays as the published package's public surface, defined from Orchard tokens.

## 6. State accounting

Rule 1 of the roadmap: fields and paths, +N/-M.

| Change | Fields | Paths |
|---|---|---|
| `client-theme` (new, pure) | +0 state; tokens as constants; +6 functions (`contrastRatio`, `renderThemeCss`, `readAppearance`, `applyAppearance`, `avatarFor`/`avatarWith`/`distinctAvatar`, `avatarMotion`/`markMotion`) | +0 recovery paths |
| Appearance | +1 stored key per device (`agent-remote:appearance`), +1 root attribute | Theme selection 2 duplicated blocks → 1 declaration per token |
| `MotionProvider` | +2 subscriptions per page (reduced motion, visibility), shared by every avatar | Scattered `matchMedia` reads unchanged (they leave with their screens in I3) |
| `WindowBotDetails.picture` | `shape` set replaced (3 → 4 values, 1 kept), +1 optional field (`gaze`) | +1 read mapping (`readBotPicture`) |
| Lab `Avatar` | -1 component, -3 functions (`avatarColor`, `readableOn`, `avatarInitial`), -1 palette, -1 token (`--ui-on-light-fill`), -2 scripted variables | Initials gone |
| `SegmentedControl`, `Sheet` | Moved, 0 net | 0 |
| `ui/tokens.css` | Names unchanged; declarations ~120 → ~62 | 0 |
| Brand | Files replaced at the same paths | 0 |

**Why I2 only adds.** It is a new system that I3 and I4 consume. Its only net addition to running state is the appearance key and the motion subscriptions. **Budget:**
- production CSS lines in the Lab plus Session View must not grow net, excluding `theme.css` and `primitives.css`;
- the legacy-token budget only falls;
- no new timer or poll: motion is driven by the browser's animation clock and two event subscriptions.

## 7. Tasks

**For every task:**
- Work in `.worktrees/im-session-service` and run `pnpm task:start` once before Task 0.
- jsdom suites run on Node 22: prefix `PATH=/opt/homebrew/opt/node@22/bin:$PATH`, as CI does.
- Each commit states its state accounting (section 6) and ends with `pnpm arch:check` and `pnpm test:unit <package> [file]` for what it touched.
- Before each commit that changes package exports or the protocol, run `pnpm compatibility:update`, then `pnpm compatibility:check`.
- Every unit test is pure and under 50 ms. The browser specs are in the component tier.

### Task 0. Baseline captures and the ratchet

**Files:**
- `packages/agent-remote-lab/src/ui/legacy-token-budget.json` (new);
- `ui/stylesheets.test.ts`.

**Steps:**
1. Record today's per-file counts of legacy variable uses in the budget file.
2. Add the ratchet test (section 5, item 1).
3. On `pnpm local`, capture Bot mode and Window mode at desktop and at 390x844, in light and dark, as `.tmp/i2-before-*.png`. The owner compares them in Task 12.

**Test.** The ratchet passes on today's counts. Adding one `var(--ui-label)` to a scratch copy fails it; so does removing one without lowering the budget. Run `pnpm test:unit agent-remote-lab src/ui/stylesheets.test.ts`.

### Task 1. Tokens and the generated theme

**Files:**
- `packages/agent-client-web/src/theme/tokens.ts`, `theme.css`, `index.ts` (new);
- `tokens.test.ts` (new);
- `packages/agent-client-web/package.json` (`./theme`, `./theme.css`, the build copy, `theme:write`);
- `architecture/modules.json` (`client-theme`, `domain-impure`).

**Interfaces.** Sections 4.1, 4.2 and 4.6.

**Tests** (`tokens.test.ts`):
- Every `textPairs` row meets its ratio in both themes, with alpha composited over the surface.
- `text-secondary` meets 4.5:1 on `ground`, `surface`, `fill` and `tint`.
- `on-brand` meets it on `brand`; `on-mine` on `mine`; `danger-text` on `surface`, `fill` and `tint`.
- `focus` meets 3:1 on `ground` and `surface`.
- The eye meets 3:1 on every palette colour and on `avatar-resting`.
- `renderThemeCss()` equals the committed `theme.css` byte for byte. The failure message names `theme:write`.
- The generated CSS declares each colour token once, as `light-dark(`, and has the two `[data-theme]` rules and the reduced-motion durations.
- **Mutation check.** Setting `text-secondary` to the mockup's `#a0a3aa` fails the first test; dropping the `[data-theme="dark"]` rule fails the CSS test.

**Commands:**
```bash
pnpm test:unit agent-client-web src/theme/tokens.test.ts
pnpm arch:check
```

### Task 2. Appearance: system, light, dark

**Files:**
- `agent-client-web/src/theme/appearance.ts` and `.test.ts` (new);
- `src/browser.ts` (`bindAppearance`);
- `packages/agent-remote-lab/src/ui/tokens.css` (to `light-dark()` pairs) and `ui/tokens.test.ts` (it parses pairs);
- `src/main.tsx`;
- `src/shell/command-items.ts` (three items: Appearance: System, Light, Dark; the current one checked);
- `index.html` (`color-scheme` meta kept).

**Tests:**
- `appearance.test.ts` (a stub port):
  - an unknown or missing value reads `system`;
  - `light` and `dark` set `data-theme` and the matching theme-color;
  - `system` clears it and restores both media metas;
  - writing persists the value.
- `ui/tokens.test.ts`: the legacy pairs keep today's light and dark values, which the test compares with a frozen copy of today's two blocks, so no screen changes colour; contrast rows unchanged.
- `command-items.test.ts`: the three items exist, and choosing one calls `set`.
- **Component** (in Task 9's spec): with the system dark and `data-theme="light"`, a legacy-styled element (`.lab-shell` text) and an Orchard primitive both compute light colours.

**Commands:**
```bash
pnpm test:unit agent-client-web src/theme/appearance.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/ui src/shell/command-items.test.ts
pnpm arch:check
```

### Task 3. Avatar recipe and the motion rule

**Files.** `agent-client-web/src/theme/avatar.ts`, `avatar.test.ts`, `motion.ts`, `motion.test.ts` (new).

**Interfaces.** Section 4.4.

**Tests:**
- **`avatar.test.ts`:**
  - the same id gives the same recipe, and the hash is pinned by 5 golden ids, so a refactor cannot re-roll everyone's avatar;
  - over 10,000 generated ids, each shape, colour and gaze has between 0.8× and 1.2× its fair share, and `outlineSeconds ∈ [5, 7]` and `phase ∈ [0, 1)` hold;
  - `avatarWith` takes the stored shape, colour and gaze, and fills an absent gaze from the id;
  - `distinctAvatar` with 31 pairs taken returns the 32nd, and with all 32 taken returns `avatarFor`;
  - every shape's eye pair is off-centre (its midpoint is at least 3 units from the shape's centroid, for every gaze) and inside the shape's base path (point-in-polygon on a flattened path).
- **`motion.test.ts`:** the full table of `reducedMotion × pageVisible × size {16, 23, 24, 84} × mood` against section 4.4's rule, and `markMotion` at 32 and 33.
- **Mutation checks:**
  - `size > 24` instead of `≥ 24` fails a row;
  - dropping `pageVisible` from `outline` fails a row;
  - `grey` depending on motion fails a row.

**Command:** `pnpm test:unit agent-client-web src/theme`.

### Task 4. Bot picture schema (protocol, Relay)

**Files:**
- `agent-remote-protocol/src/window-groups.ts` and `.test.ts`;
- `src/fixtures/window-bots.v1.json` (new, frozen);
- `agent-relay-core/src/window-workspaces.ts` and its test;
- `packages/agent-remote-lab/e2e/bot-mode.spec.ts:399` (writes `squircle` with a gaze);
- `docs/current/agent-remote/protocol.md` (the bot details paragraph).

**Interfaces.** Section 4.4, "Bot picture schema".

**Tests:**
- **Schema.** It accepts the four shapes with and without a gaze, and refuses `hexagon`, `rounded` and a gaze of 6 on write (`bot.update`).
- **Legacy read.** `readBotPicture` maps the frozen fixture's `rounded` and `hexagon` pictures to `squircle`, keeping their colours.
- **Relay.** A saved group holding the frozen legacy `bots` lists with mapped pictures, and a later `bot.update` round-trips the new form.

**Commands:**
```bash
pnpm test:unit agent-remote-protocol src/window-groups.test.ts
pnpm test:unit agent-relay-core src/window-workspaces
pnpm fixtures:check
pnpm compatibility:update && pnpm compatibility:check
pnpm arch:check
```

### Task 5. Avatar, mark, wordmark and the motion provider

**Files:**
- `agent-client-web/src/primitives/AssistantAvatar.tsx`, `OrchardMark.tsx`, `Wordmark.tsx`, `MotionProvider.tsx` (new);
- `primitives.css` (new);
- `index.ts` (new; the `./primitives` and `./primitives.css` exports);
- `agent-client-web/src/theme/mark.ts` (new);
- their tests.

**Tests** (jsdom, an injected `MotionPort`):
- **Avatar animation.** A 40 px `idle` avatar with motion allowed renders one `<animate attributeName="d">` whose `begin` is the recipe's negative phase. With `reducedMotion`, at 23 px or with the page hidden it renders none; becoming visible restores it.
- **Avatar state.** `resting` sets `data-mood="resting"` and the resting fill. `needs_you` sets `data-pop` once on entry, not again on a re-render with the same mood. The root is `aria-hidden` unless a `label` is given.
- **Mark and wordmark.** `OrchardMark` at 32 px renders no animated group and at 64 px both; `markSvg()` contains no `var(` and parses as SVG; `Wordmark` renders `orchard` in lowercase.

**Commands:**
```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-client-web src/primitives
pnpm arch:check
```

### Task 6. Conversation primitives

**Files.** `agent-client-web/src/primitives/Bubble.tsx`, `Card.tsx`, `Pill.tsx`, `Toggle.tsx`, `StatusLine.tsx`, `WorkSummaryLine.tsx`, `ApprovalCard.tsx`, `SessionChangeLine.tsx`, plus their CSS and tests.

**Tests** (jsdom):
- **`Bubble`:** `mine` and `theirs` set `data-from`; `theirs` places the avatar at the body's foot; `delivery="sending"` shows `sendingLabel` and sets `aria-busy`.
- **`Toggle`:** it is `role="switch"` with `aria-checked`. Click and Space call `onChange(!checked)`, and `disabled` blocks both.
- **`WorkSummaryLine`:** it is a button with `aria-expanded`. Its children (L2) render only when `open`, and the button controls their region (`aria-controls`).
- **`ApprovalCard`:** one button per choice, in order. A `primary` choice has `data-variant="primary"`, and choosing calls only its own handler.
- **`StatusLine`:** `live` renders the typing dots as `aria-hidden`, and the sentence is in a polite live region.
- **`SessionChangeLine`:** `role="separator"` with the text as its accessible name.

**Command:** `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-client-web src/primitives`.

### Task 7. Surfaces: Sheet, FloatingPanel, SegmentedControl (moved)

**Files:**
- `git mv` `agent-remote-lab/src/ui/Sheet.tsx`, `Sheet.test.tsx`, `SegmentedControl.tsx` and `SegmentedControl.test.tsx` to `agent-client-web/src/primitives/`;
- `FloatingPanel.tsx` (new);
- remove the `.ui-sheet*` and `.ui-segmented*` rules from `ui.css` and restyle them in `primitives.css`;
- the Sheet's Close becomes an icon `Pill`.

**Callers.** `WindowSheets.tsx`, `RemoveBotSheet.tsx`, `BotActions.tsx`, `NewBotSheet.tsx`, `WorkbenchModeSwitch.tsx` and `WindowWorkspaces.tsx` import from `@orchardworks/agent-client-web/primitives`.

**Tests:**
- The moved tests pass unchanged, apart from their import path: same behaviour, new home.
- `FloatingPanel` renders its landmark with `label`.
- Section 4.3's phone and safe-area rules are pinned in Task 9's spec, not here.

**Commands:**
```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-client-web src/primitives
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/components src/app
pnpm arch:check
```

### Task 8. Brand assets

**Files:**
- `scripts/brand-assets.mjs` (new; root `package.json` `brand:assets`);
- `packages/agent-remote-lab/public/favicon.svg`, `app/icon-192.png`, `app/icon-512.png`, `app/manifest.webmanifest`;
- `index.html`;
- `src/app/useHostAndStack.ts:100-101`;
- `src/ui/tokens.test.ts:157` (the manifest colours now come from `tokens.ts`);
- the tests that assert the old title.

**Tests** (`packages/agent-remote-lab/src/brand-assets.test.ts`, node):
- `favicon.svg` equals `markSvg()`.
- The PNG headers read 192 × 192 and 512 × 512.
- The manifest's name, short name and colours equal "Orchard" and the light `ground` from `tokens.ts`.
- `index.html`'s two theme-color metas equal the two grounds.
- No path is added beyond the Relay allowlist (`gateway-static.ts`, `worker.ts`); the test reads the list through `agent-relay-node`'s exported constant if one exists, or else names the three paths.

**Commands:**
```bash
pnpm brand:assets
pnpm test:unit agent-remote-lab src/brand-assets.test.ts src/ui/tokens.test.ts
```

### Task 9. Fixture page and component specs

**Files:**
- `packages/agent-remote-lab/e2e/fixtures/orchard-primitives.html` and `.tsx` (new);
- `e2e/components/orchard-primitives.spec.ts` (new);
- `playwright.components.config.ts`;
- `e2e/ui-primitives.browser.ts` (adds Pill, Toggle, the moved SegmentedControl and Sheet close).

**The page.**
- **Switches.**
  - `?theme=light|dark|system` sets the appearance through `bindAppearance`.
  - `?motion=on|off` replaces the motion port: `off` is reduced motion; `on` is the real port.
- **Sections:**
  - every primitive in every state: bubbles mine and theirs, sending, long text and code; card plain and tint; pills; segmented; toggle on, off and disabled; status line live and still; work-summary line closed and open; approval card; session-change line; a floating panel on the ground; an open sheet behind a button;
  - avatars: 4 shapes × 8 colours at 40 px, 6 gazes, the 4 moods at 16, 23, 24, 28, 40 and 84 px, and an override;
  - the mark at 16, 20, 32, 64 and 150 px, and the wordmark on both surfaces.
- Everything is built from props. There is no client, Relay or Controller.

**Projects.** Add `orchard-phone-chromium` (Chromium, 390 × 844, `isMobile`, `hasTouch`) and `orchard-phone-webkit` (WebKit, iPhone 13 with `viewport: { width: 390, height: 844 }`). Both match `orchard-primitives.spec.ts`. `chromium-desktop` (1280 × 720) runs it too.

**Spec** (each test runs for `light` and `dark`, and once for `system` with `emulateMedia({ colorScheme: 'dark' })`):
- **Contrast (WCAG AA).** For every text node in the page, the test takes the computed `color` and the effective background: it walks the ancestors and composites alpha down to the ground. The ratio must be at least 4.5, or 3 for text at 24 px and above, or at 18.66 px and above at weight 700 or more. The failure lists selector, colours and ratio.
- **Theme override.** With the system dark and `?theme=light`:
  - `ground` computes `#f3efe9`;
  - a legacy-token element computes its light value;
  - after `bindAppearance(...).set('system')` both become dark without a reload.
- **Reduced motion.**
  - With `emulateMedia({ reducedMotion: 'reduce' })` and `?motion=on`: `document.getAnimations()` is empty, the page has no `animate` element, and the typing dots are static.
  - With motion allowed: every avatar of 24 px and above that is not resting has exactly one `animate`, avatars under 24 px have none, the working avatar's wrapper has a running CSS animation, and the 64 px mark has two.
- **Hidden page.** Dispatching `visibilitychange` with `document.visibilityState` overridden to `hidden` removes every `animate`; making it visible again restores them.
- **Touch targets** (phone projects only). Every `button`, `[role=switch]`, `[role=radio]`, `a[href]` and `input` that is visible in the page measures at least 44 × 44. The sheet is opened, so its Close is measured too.
- **Layout at phone width.**
  - No horizontal overflow (`scrollWidth ≤ innerWidth`).
  - The floating panel spans the full width with radius 0.
  - The sheet's bottom padding includes the safe-area inset (WebKit, `env()` emulated through a CSS variable fallback that the spec sets).
- **Screenshots.** One per project, theme and section, as artifacts for the owner. They are not compared by pixels.

**Commands:**
```bash
pnpm test:components -- --project=chromium-desktop --project=orchard-phone-chromium --project=orchard-phone-webkit orchard-primitives
pnpm test:preview-browser
```

### Task 10. Migrate what the primitives replace

**Files:**
- `components/BotRoster.tsx` (`BotPicture` renders `AssistantAvatar` with `id = viewId`, `picture`, and a mood from the row's status: Needs you → `needs_you`, Working → `working`, asleep → `resting`, otherwise `idle`);
- `components/BotActions.tsx:112`;
- `components/SessionDock.tsx:204`;
- `app/useSessionViewPresentation.tsx:219,249` (pass the view id);
- `App.tsx` or `WorkspaceShell` (wrap the app in `MotionProvider`);
- `src/main.tsx` (CSS order: `theme.css`, `ui/tokens.css`, …, `ui/ui.css`, `primitives.css`).

**Tests:**
- `BotRoster.test.tsx`:
  - each row's avatar has `data-shape` and `data-mood`;
  - a stored picture wins;
  - two rows with stored different pictures differ;
  - a sleeping bot is resting.
- `e2e/bot-mode.spec.ts`: the stored `squircle` picture shows as a squircle with the stored colour.
- The ratchet budget is lowered by the removed avatar, segmented and sheet rules.

**Commands:**
```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm test:unit agent-remote-lab src/components/BotRoster.test.tsx src/components
pnpm test:components
pnpm verify:changed
```

### Task 11. Deletion (rule 7)

**Delete.**
- **Lab avatar.** `ui/Avatar.tsx`, `AVATAR_COLORS`, `avatarColor`, `readableOn`, `avatarInitial`, the `.ui-avatar*` rules (including the hexagon `clip-path`), `--ui-on-light-fill`, and `--ui-avatar-color`/`--ui-avatar-size` in `stylesheets.test.ts`'s scripted list.
- **Lab primitives.** The emptied `ui/Sheet*` and `ui/SegmentedControl*` paths, and their `ui.css` rules (24 lines).
- **Legacy dark block.** The duplicated dark `@media` block of `ui/tokens.css`, replaced in Task 2.
- **Old brand.** The old "AR" favicon and icons, replaced at their paths.

**Mutation check for `ui/Avatar.test.tsx`.** Each of its mutations must also fail a new test:
- the stored colour is ignored;
- the shape is ignored;
- an invalid colour is accepted;
- `aria-hidden` is dropped.

The initial-letter and ink-colour cases go with the feature, so no rule remains for them. Record the mapping (old test → owner test → mutations) below in section 10.

**Kept, with the reason:**
- `Button`, `IconButton`, `ListRow`, `Menu`, `Toolbar` and `StatusBadge` have no I2 counterpart (decision 11).
- The `--obs-*` and `--agent-*` families leave with their screens (section 5).
- The scattered `matchMedia` reduced-motion reads leave with their screens in I3.

### Task 12. Acceptance and local verification

Section 8 and section 9. Then run the full `pnpm verify`.

## 8. Acceptance

| Area | Accepted when |
|---|---|
| Tokens | One module (`client-theme`) holds every Orchard colour, radius, space, type size, elevation and motion value; `primitives.css` has no literal and no legacy variable; `renderThemeCss()` equals `theme.css` |
| Themes | Light and dark pass WCAG AA for every text node of the fixture page at desktop and 390 × 844, in Chromium and WebKit; System, Light and Dark switch Orchard primitives and today's screens without a reload; the choice survives a reload |
| Motion | Under `prefers-reduced-motion`, `getAnimations()` is empty and no `animate` element exists; avatars under 24 px and marks of 32 px and below never animate; a hidden page runs no avatar or mark animation |
| Touch | Every interactive element of the fixture page is at least 44 × 44 px at phone width (Chromium and WebKit) |
| Avatars | Deterministic from the id (golden ids); a stored picture in the account's Window groups overrides; legacy stored pictures still read; Bot mode and folded cards show the new avatars |
| Brand | Favicon, both icons and the manifest come from one drawing and say "Orchard"; the title says "Orchard"; the Relay serves them at the existing paths |
| Migration | The legacy-token budget is lower than at Task 0; no screen beyond section 1's changes colour (Task 0 against Task 12 captures) |
| Gates | `pnpm arch:check`, `compatibility:check`, `fixtures:check`, `test:components`, `test:preview-browser` and `pnpm verify` pass; no unit test over 300 ms |

## 9. Verification on `pnpm local`

Follow `.agents/skills/prepare-arc-local/SKILL.md`, and check the instance's own sessions before `up`.

1. Open `/e2e/fixtures/orchard-primitives.html` in light, dark and system, at desktop and in the 390 × 844 device mode. Capture `.tmp/i2-fixture-*.png`.
2. In Bot mode with three bots:
   - the avatars differ, outlines flow out of phase, and a working bot bobs;
   - a bot that asks for approval pops once;
   - a sleeping bot is grey and still;
   - switching tabs away and back pauses and resumes the motion (Performance panel: no animation frames while hidden).
3. **Battery and CPU.** With 30 animated 40 px avatars on screen, record a 10 s Chrome performance trace at 4x CPU. Record main-thread busy time per second and frame rate in section 10.
   - If the avatars cost more than 5% of a frame budget at 1x, take the figure to the owner before I3 (rule 4: measure before scale).
   - The fallback is that only avatars within the viewport animate.
4. Appearance: set Light with the system dark, reload, and confirm it persists. Set System and confirm the system theme returns.
5. Installed web app on an iPhone: the icon and the name "Orchard", the status bar colour in both themes, and the sheet clearing the home indicator.
6. The owner reviews the before and after captures (Task 0 and Task 12) and the fixture page before merge.

## 10. Results

Filled in per task: suites and counts, the measured contrast table (final hexes for the ≈ tokens), the avatar CPU trace, the deletion mapping and the ratchet's before and after.

**Commits** (on `design/im-session-service`): Task 0 `c84a0c90`, Task 4 `82b75fe7`, Task 1 `a2bd67ab`, Task 2 `f68bcd90`, Task 3 `c0593e21`, Task 5 `0a0c2dc4`, Task 6 `263f7e11`, Task 7 `8d7a2da9`, Task 9 `b3f25ee1`, Task 10 `9702920f`, Task 11 `1c8e943c`, Task 8 `bb21989f`. Task 8 ran after Task 11 so that only its root `package.json` change sends `verify:changed` to the full `pnpm verify`.

**Deploy.** The bot picture schema (Task 4) is a Window workspace interface change: deploy the Relay first, then the website.

**Contrast** (final hexes; the ratio is the worst surface the token promises):

| Token | Light | Dark |
|---|---|---|
| `text-secondary` on ground, surface, fill, tint | `#696d75`, 4.53 (ground) | `#9a9da4`, 4.89 (tint) |
| `on-brand` on `#ff7f45` | `#1d1d1f`, 6.71 | the same |
| `on-mine` on `mine` | `#ffffff` on `#2a2b30`, 14.1 | `#1d1d20` on `#f2f2f4`, 15.0 |
| `danger-text` on surface, fill, tint | `#c4321f`, 4.96 | `#ff7a6b`, 5.22 |
| `focus` on ground, surface (3:1) | `#d9581c`, 3.42 | `#ff7f45`, 6.24 |
| eye `#16161a` on the palette (3:1) | violet lowest, 4.89 | the same |
| eye on `avatar-resting` (3:1) | `#c9cbd0`, 11.1 | `#66686e` (mockup `#55575d` was 2.50), above 3 |

The fixture spec found no text node below AA in light, dark and system-dark, in chromium-desktop, chromium-mobile, orchard-phone-chromium and orchard-phone-webkit (390 × 844), with the sheet and the work summary open. A sending bubble keeps full opacity (the mockup's 0.55 would fail AA); its state is the word beside it.

**Motion and touch.** Under reduced motion there is no `animate` element and `getAnimations()` settles to empty (WebKit lists the Lab's 0.01 ms reduced-motion transitions for a frame, so the spec polls for 2 s). With motion, every avatar of 24 px and above that is not resting has one `animate`, smaller ones none, the working avatar bobs, the 64 px mark runs two animations and the 32 px mark none; a hidden page removes them all and a visible one restores them. Every button, switch, radio, link and input on the fixture page is at least 44 × 44 under a coarse pointer, in Chromium and WebKit.

**Avatar CPU** (30 animated 40 px avatars on screen, headless Chromium, `Performance.getMetrics` over 10 s, two runs; still = the same page with motion off):

| CPU | Busy ms/s, moving | Busy ms/s, still | Frames/s moving |
|---|---|---|---|
| 1x | 38.6, 32.7 | 5.3, 5.3 | 67, 73 |
| 4x | 88.7, 59.4 | 5.3, 9.5 | 72, 69 |

At 1x the avatars add 27 to 33 ms of main-thread work per second: 0.45 to 0.55 ms of each 16.7 ms frame, 2.7 to 3.3 % of the budget, under the 5 % line. At 4x they add 50 to 83 ms per second and the frame rate holds. No reduction (fewer concurrent avatars, pausing offscreen ones) was needed in I2; recheck on an iPhone in step 5 of section 9.

**Ratchet.** `ui/ui.css` 120 → 91 (segmented and sheet rules, Task 7) → 83 (avatar rules, Task 11); every other stylesheet is unchanged. `ui/tokens.css` 121 → 78 lines.

**Deletion mapping** (`ui/Avatar.test.tsx`): the stored colour ignored → `avatar.test.ts` "takes the stored shape, colour and gaze", `AssistantAvatar.test.tsx` "draws a stored picture" (and "fills an absent gaze", "keeps the id's own field"); the shape ignored → the first two; an invalid colour accepted → "keeps the id's own field for anything stored that is not a valid shape, colour or gaze"; `aria-hidden` dropped → "is hidden from assistive technology unless a label names it". Each mutation was applied and failed those tests. The initial-letter and ink cases left with the feature.

**Suites.** agent-client-web I2 suites: 159 tests in 11 files, 432 ms of tests (the slowest file, `Sheet.test.tsx`, 96 ms). Lab: `stylesheets.test.ts`, `tokens.test.ts`, `brand-assets.test.ts`, `command-items.test.ts`, `BotRoster.test.tsx`, `WorkbenchModeSwitch.test.tsx`, `Sheet.menu.test.tsx`. Protocol `window-groups.test.ts` 21 tests, Relay `window-workspaces` 28 tests. Components: 498 passed (72 skipped by project), 8.1 min; preview-browser: 73 passed, 136 s; `fixtures:check`, `arch:check` and `compatibility:check` pass. `pnpm verify`: compatibility, architecture, build and typecheck pass; its unit stage stopped once on a Controller git test at 1.01 s under a load average of 110 (563 ms alone on a quiet machine, untouched by I2), and the full `pnpm test` rerun then passed: 11,718 tests in 27 suites.

**Captures.** Before and after of Bot and Window mode: `.tmp/i2-before-*.png`, `.tmp/i2-after-*.png`; they differ only by the avatars and the orange mode switch. The fixture page: `.tmp/i2-fixture-{desktop,phone}-{light,dark,system}.png`; per-section captures per project in `.tmp/i2-components/`.

**Deviations.**
- `AppearancePort.setChromeColor(color, media)` takes the media the meta belongs to (`light` or `dark`); `chooseAppearance` stores and applies, `applyAppearance` only applies.
- `SessionChangeLine` takes its text as a string, because a separator's accessible name comes from `aria-label`.
- The safe areas are `--orchard-safe-area-*` tokens (`env()` by default), which the spec overrides to emulate a home indicator.
- `avatarWith` also ignores a stored field that is not a valid shape, colour or gaze, so a bad stored value cannot reach the SVG.
- The Lab cases of the moved tests (a Menu inside the Sheet, the WorkbenchModeSwitch) stay in the Lab, since the Lab owns those components.
- The fixture page is served by the Lab's Vite server (as in the component tier), not by the built site of `pnpm local`.

## 11. Open questions, answered

1. **Is changing `WindowBotDetails.picture` a protocol change that the design rules out?** No. The design excludes the session protocol. The bot picture is a stored Window workspace field that already exists for this purpose. The change replaces the shape set and adds one optional field (decision 12), and the Relay deploys first.
2. **White or dark text on the brand orange?** Dark. White fails AA at 2.5:1, the design requires AA for text, and the orange is fixed at `#ff7f45` (decision 5). The owner sees it on the fixture page and may instead choose a deeper orange for text-bearing fills; that would be a token change only.
3. **Per device or per account appearance?** Per device (decision 4). Appearance follows the device's own system setting.
4. **Do the eyes drift, as in the mockup?** No. The owner's list names the outline flow and three mood motions only (decision 6).
5. **Who generates and stores an avatar at creation, and where is the picker?** I3. I2 supplies `distinctAvatar` and the schema (decision 8).
6. **Do the icons, manifest and title ship before the I4 brand pass?** Yes. The brief puts them in I2 as assets, they share the paths the Relay already serves, and they agree with each other (decision 10). The access page and about page stay in I4.
7. **What if 30 SMIL avatars cost too much on a phone?** Measure first (section 9, step 3). Only then limit animation to on-screen avatars. Do not add a second mechanism without the figure.
