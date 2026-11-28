# The session goal
Module: `agent-provider-sdk/src/observation.ts` (`AgentSessionGoal`, `runtimeInfo.goal`) and `agent-remote-protocol/src/snapshot.ts`; the adapters: `agent-provider-claude/src/goal.ts` and `agent-provider-codex/src/goal.ts`; the words: `agent-client/src/presentation/session-goal.ts`; the page: `agent-client-web/src/react/items/SessionGoalLine.tsx`, `agent-remote-lab/src/conversation/assistant/TileHeader.tsx`; tests: those files' neighbours, `session-goal-pinned.spec.ts`, and flow E22.

| Clauses | Gaps when written | Closed by a test | Not tested, with the reason |
|---:|---:|---:|---:|
| 9 | 0 | 9 | 0 |

## Purpose
- G1. A session can work toward a goal its CLI keeps (`/goal`). The adapter reports what the CLI's own record says as `runtimeInfo.goal` (objective, status, and the iterations, tokens, time, budget, last reason and times the CLI keeps, none it does not). Every other layer only carries and shows it; native interpretation stays in the adapter. (Tests: `session-goal.test.ts` in the protocol, `goal.test.ts` of each adapter.)
- G2. The goal is the person's. It is set by the person's own `/goal` command: the Claude Code command runs as typed, and the Codex command calls `thread/goal/set`, `get` and `clear` with `origin: user`. Bots get no goal tools. (Tests: Claude `session-goal.test.ts` > "reaches Claude Code as the person typed it"; Codex `session-goal.test.ts` > "sets the objective as the person's own goal".)

## Guarantees
- G3. Claude Code: the goal is read from the `goal_status` rows of the session's transcript, which hold it live, after a reopen and in history; the SDK's `active_goal` message reaches only a remote session and is not read. A set row opens it, each row after it is one check (not met with the evaluator's reason, met, or impossible), a closing sentinel row clears it. The transcript is read again only from the bytes appended, at the records a goal's turn leaves and at the turn's end, and only once the session has or has been sent a goal. (Tests: `goal.test.ts`, `session-goal.test.ts`; native: `native-goal.local.test.ts`.)
- G4. Codex: the goal is read with `thread/goal/get` when a thread opens again, and follows `thread/goal/updated` and `thread/goal/cleared` of its own thread; a notification that arrives while the stored goal is being read wins. Timestamps are seconds in Codex and milliseconds here. (Tests: `session-goal.test.ts`, `goal.test.ts`; native: `native-goal.local.test.ts`.)
- G5. The adapter says what the person can do to the goal now (`actions`: clear, pause, resume, each a command of the session's directory and its arguments). Both CLIs take `clear`; Codex also takes `pause` and `resume`. A running turn does not stop them: `/goal` is the one command that runs while a turn runs (Claude Code takes it into its native queue). (Tests: both `session-goal.test.ts`.)
- G6. The page pins the goal as one line above the conversation, with the team page line: its objective, where it stands and the figures that exist, and the offered actions as buttons. It keeps one height in every state (a long objective is cut), moves no entry when it changes or goes, and only reads while the session cannot be changed. A tile badges it with the status. (Tests: `SessionGoalLine.test.tsx`, `AgentTimeline.goal.test.tsx`, `SessionWorkbench.goal.test.tsx`, `session-goal-pinned.spec.ts` at desktop and phone width, E22.)
- G7. A page opened later reads the goal the session reports; a goal cleared is gone after a reload. (Tests: E22.)

## Errors and refusals
- G8. An action the CLI refuses shows "The goal could not be changed." in the line until the CLI reports the goal again. A read-only session offers no goal action, and a Codex session in read-only access refuses the command. (Tests: `SessionGoalLine.test.tsx`, `SessionWorkbench.goal.test.tsx`.)
- G9. A Codex without goals, or one that does not answer `thread/goal/get`, leaves the session without a goal; an objective over 4,096 characters, and `/goal edit` without an objective, are refused before any request. (Tests: Codex `goal.test.ts`, `session-goal.test.ts`.)

| Clause | Test(s) that prove it |
|---|---|
| G1 | `session-goal.test.ts` (protocol), Claude and Codex `goal.test.ts` |
| G2 | Claude and Codex `session-goal.test.ts` |
| G3 | Claude `goal.test.ts`, `session-goal.test.ts`, `native-goal.local.test.ts` |
| G4 | Codex `goal.test.ts`, `session-goal.test.ts`, `native-goal.local.test.ts` |
| G5 | Claude and Codex `session-goal.test.ts` |
| G6 | `session-goal.test.ts` (client), `SessionGoalLine.test.tsx`, `AgentTimeline.goal.test.tsx`, `SessionWorkbench.goal.test.tsx`, `session-goal-pinned.spec.ts`, `e21` |
| G7 | `e21` |
| G8 | `SessionGoalLine.test.tsx`, `SessionWorkbench.goal.test.tsx` |
| G9 | Codex `goal.test.ts`, `session-goal.test.ts` |
