# I4 test mapping

Where the rule of each deleted or re-pointed test lives now. A deleted test's rule is owned by a named test.

## Navigation and Settings

| Before | Rule | Now |
|---|---|---|
| `components/WorkbenchModeSwitch.test.tsx` (deleted with the component) | The arrow keys move between the modes without choosing one | `SegmentedControl.test.tsx` (`activation="manual"`), which the Lab no longer needs for the modes |
| same | The mode switch keeps the names the page relied on ("Workbench mode", "Window mode", "Bot mode") | Gone with the switch; the destinations are named in `shell/NavigationRail.test.tsx` and `TabBar.test.tsx` (Chats, Assistants, Windows, Settings or Me, `aria-current` from the current destination) |
| `shell/SidebarFooter.test.tsx` (deleted with the component) | `hostSummary` words ("1 Host online", "1 of 2 Hosts online", "All Hosts offline", "No Hosts paired", "Checking Hosts…") | `settings/host-summary.test.ts` (computers, in English and Chinese) |
| same | The footer opened the Hosts page and Settings | `NavigationRail.test.tsx` (Settings in the rail, the account's popover to Account), `App.hosts-page.test.tsx` (Settings > Computers) |
| `shell/SidebarHeader.test.tsx` | The header held the mode switch, Search (with the platform shortcut) and the actions | `SidebarHeader.test.tsx` (a title or the wordmark, then the actions); Search and its shortcut text in `NavigationRail.test.tsx`; the shortcuts themselves in `hooks/useShellShortcuts` tests |
| `App.bot-mode.test.tsx` "puts the mode switch and the New menu…" | The Window sidebar header has the New menu and no app-bar mode switch | Same test, re-pointed: a "Windows" title, the New menu, and the modes in the rail |
| `App.bot-mode.test.tsx` "shows … footer" | The Window sidebar has Windows, In this Window and Shortcuts, and no Hosts footer | Same test, re-pointed (no footer; Settings in the rail) |
| `App.hosts-page.test.tsx` | The Hosts page: opened from the footer, pairing in its toolbar, a Host card opens the Host | Same file: Settings > Computers (lead, Pair a computer, a card opens the Host's page) on the desktop and on the phone |
| `App.command-palette.test.tsx` | Search from each mode's sidebar; "Switch to Bot mode" | Search in the rail (one button for both modes); Chats, Assistants, Windows and Settings by name (`state/palette-actions.test.ts`) |
| `state/panels.test.ts` | `settings` and `hosts` panels and their page titles | Removed with the panels; All sessions, Favorites and New session keep their rows |
| `components/BotWorkspace.test.tsx` "hides a group in Bot mode or Window mode from its roster header" | A group's appearance in either mode, from its header menu | `BotWorkspace.test.tsx` (same name, in the directory) and `assistant/AssistantDirectory.test.tsx` |
| `components/assistant/AssistantDetails.test.tsx` device default, notifications, letters | The details panel's device default, notifications and letters | `settings/SettingsPage.test.tsx` (each choice writes its key), `hooks/useSessionAttention.test.tsx` (the permission rules through the Assistants group) |
| `components/SessionViewOptions.test.tsx` | Device default and letters in View options | `SessionViewOptions.test.tsx` (this assistant only; nothing for a view that is no assistant) |
| `App.test.tsx` letters and process default from View | The timeline follows the device default and Show letters | Same tests, re-pointed to Settings > Assistants and back |
| `components/HostPairing.test.tsx` revoke, rotate, stop, pairing keys | Host management in the Hosts select | `settings/ComputerSettings.test.tsx` (a computer's page: revoke, rotate, stop, Pair a computer, nothing for a shared computer) |
| `components/PairingKeys.test.tsx` "does not request history when management is hidden" | The panel hid its management | Removed: the panel only exists on the page that shows it |
| `App.host-providers.test.tsx` tunnel from "Sidebar settings" | Each Host's VS Code tunnel | Same test, from each Host's page |
| `e2e/components/launcher-layout.spec.ts` and `assistant-phone.spec.ts` | Launchers cover nothing; the list is home on a phone | Same specs, scoped to the launcher (not the rail's Windows) and with the tab bar |
| agent-e2e flows E1, E6, E8, E10 | "Sidebar settings", the mode buttons, "2 Hosts online" | `flows/page.ts` `goTo`, `openSettings`, `chooseSetting`, `openComputer`; E11 owns Settings end to end |

New rules, each with its test: the address contract (`hooks/useWorkbenchMode.test.tsx`, `App.bot-mode.test.tsx`), Chats and directory projections (`bot-roster.test.ts`), the Settings groups and each choice (`settings/SettingsPage.test.tsx`), smart reading (`settings/ComputerSettings.test.tsx`, `directory-client.test.ts`), the rail and the tab bar in a browser (`e2e/components/navigation.spec.ts`, `settings.spec.ts`), and Settings on the real stack (`flows/e11-settings.e2e.ts`).
