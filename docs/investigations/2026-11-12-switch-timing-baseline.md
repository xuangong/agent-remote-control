# Window and bot switch timing: baseline before phase 3

Recorded on 2026-11-12 for main at `22f1ead1` (UI modernization phase 2c). The UI modernization spec asks for Window switching and bot switching to be measured before and after each phase; phases 3–5 compare against these numbers.

## Method

- **Data.** `.agents/skills/prepare-arc-local/scripts/perf-fixture.mjs` prepares a local instance with six Claude Code sessions, shown as "Perf 1" to "Perf 6", each with three turns (lists, numbered lists and a code block). It also creates three Windows: Perf A (Perf 1–3, one primary view and two docks), Perf B (Perf 4–6, the same layout) and Perf C (Perf 2 and Perf 5). Perf A and Perf B are shown as sections in Bot mode.
- **Timing.** `.agents/skills/prepare-arc-local/scripts/switch-timing.mjs` drives headless Chromium at 1440×900.
  - A Window switch clicks the Window's row in the sidebar.
  - A bot switch clicks the bot's row in the roster.
  - Each switch is timed in the page, from the click to the moment the target shows its own conversations: every view of the Window, or the bot's conversation, with its first request and all three replies.
  - Long tasks (over 50 ms) that start in that span are counted.
  - The first visit to each target also connects its sessions, so it is reported separately. Three measured rounds follow: 9 Window switches and 18 bot switches.
- **CPU.** Each run is made at full speed and again with Chromium's 4× CPU throttling, which makes regressions easier to see.
- **Machine.** A Mac mini (10 cores, 16 GB). Compare runs from the same machine only.

## Results

Two runs each; the medians are stable to within about 10%, while p90 and maximum vary more.

| Switch | CPU | Median | p90 | Max | Long tasks (count / total / longest) |
|---|---|---|---|---|---|
| Window | 1× | 125 / 131 ms | 303 / 200 ms | 303 / 200 ms | 11 / 975 ms / 128 ms; 8 / 881 ms / 148 ms |
| Window | 4× | 452 / 437 ms | 560 / 676 ms | 560 / 676 ms | 19 / 3767 ms / 440 ms; 13 / 3211 ms / 408 ms |
| Bot | 1× | 30 / 36 ms | 39 / 58 ms | 40 / 66 ms | none |
| Bot | 4× | 93 / 97 ms | 111 / 130 ms | 115 / 131 ms | none; 1 / 92 ms / 92 ms |

First visits at 4×: Windows took 664–1125 ms, with 524–962 ms of long tasks; bots took 132–170 ms.

Long tasks take up most of the time of a Window switch, at 70–90% of it at 4×. A bot switch shows a conversation the page already keeps, so it is cheap. Phase 4, which reworks the panes, is where Window switching should improve. Phase 3 should keep bot switching under 100 ms at 4×.

## Repeating the measurement

Use a dedicated detached worktree with its own instance, so that every build is measured against the same data:

```bash
git worktree add --detach .worktrees/perf <commit>
cd .worktrees/perf && pnpm install && pnpm local up
node <checkout with the scripts>/.agents/skills/prepare-arc-local/scripts/perf-fixture.mjs     # once; it keeps what exists
node <checkout with the scripts>/.agents/skills/prepare-arc-local/scripts/switch-timing.mjs --throttle 1
node <checkout with the scripts>/.agents/skills/prepare-arc-local/scripts/switch-timing.mjs --throttle 4
```

To measure another build in the same worktree: `git checkout --detach <commit> && pnpm install && pnpm local up`. Results are written to `.tmp/perf/switch-<commit>-x<throttle>.json`, with every switch listed.
