# Window session connections verification

The Window heading's Info groups Host name and ID, Provider, cwd and native Session ID. Each view retains its browser-local connection choice; an absent preference connects by default. Disconnect preserves cached history and drafts, retires primary and secondary attachment, stops activity tracking, and removes recent-Window retention. Other enabled views retain shared connections. The mobile action handle stays one row high (44px), and expanded actions scroll horizontally in one row.

## Automated checks

- Lab suite: 2,647 passed, 12 skipped.
- Web suite: 871 passed.
- Debugger suite: 141 passed.
- Final heading/layout regression selection: 78 passed.
- Build, Lab typecheck, compatibility update/check and diff check passed.
- Transport tests cover default attachment, independent views sharing a connection, unsubscribe after the final view disconnects, persistent choices after remount and Window navigation, reconnection, draft/history preservation, and disabled activity observers.

## Local verification

Origin: `http://localhost:58408`.
Instance: `window-session-connections-1e07c29f`.
Build: local `pnpm local up` after final implementation changes, based on `5ed1266b` with this feature's uncommitted changes.

Build, Site, Controller, Page, Feature and Model turn were verified with headless Chromium and two native Codex sessions created in the instance workspace. Both returned `LOCAL-OK`; a reconnect was followed by a new assistant reply. WebSocket observations recorded 2 session subscriptions initially, 0 after both views disconnected, 0 after reload, and 1 after activating only one view. The page retained cached conversation text throughout. Info values were asserted in the DOM. Desktop and mobile screenshots were opened and reviewed; mobile checks measured the collapsed handle and expanded toolbar and exercised their real controls.

Artifacts are in this worktree's `.tmp/local/`: `browser-result.json`, `info-connected.png`, `disconnected.png`, `disconnected-reload.png`, `reactivated.png`, `mobile-collapsed.png` and `mobile.png`.

A Claude test turn could not complete because its configured model was unavailable through the native gateway; native model-turn coverage for this feature is Codex. The Host's existing safe-idle release policy is unchanged (five-minute grace by default); the page test verifies subscription removal rather than waiting for the entire native idle grace.

The native test sessions were released after validation, and this worktree's local instance was stopped. Production rollout updates the website/Relay only; Controller 0.2.79 remains the separately published handoff fix.
