import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentSessionGoal } from '@orchardworks/agent-provider-sdk';
import { followSession } from '@orchardworks/agent-provider-sdk/conformance';

import { CodexAppServerProvider } from './provider.js';
import { message, startResponsesFixture } from './test-utils/native-responses-fixture.js';

/**
 * The native assumption checks of `/goal` (`pnpm test:native:codex`): the statuses, the units and the requests the adapter relies on are
 * what the installed `codex app-server` answers. It runs against a scripted Responses API in a temporary CODEX_HOME; the scripted model
 * never finishes the goal, so the goal works until the test pauses or clears it, as a person would.
 */
const executable = process.env.BORGEE_CODEX_TEST_EXECUTABLE ?? 'codex';
const installed = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[1];
const OBJECTIVE = 'every test passes';

const goalsOf = (seen: ReturnType<typeof followSession>) => seen.liveEvents().flatMap(event => event.type === 'runtime_updated' && event.runtimeInfo.goal ? [event.runtimeInfo.goal as AgentSessionGoal] : []);

describe(`the installed Codex CLI (${installed ?? 'no version'}) and the goal of a thread`, () => {
  it('reports a goal set, paused, resumed and edited through the command, and clears it, as the person\'s own', async () => {
    const f = await startResponsesFixture((_request, index) => message(`m${index}`, `WORKED ${index}`));
    const provider = new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000 });
    try {
      const session = await provider.createSession({ sessionId: 'goal', cwd: f.cwd, model: 'mock-model' });
      const seen = followSession(session);
      await seen.boundary();
      expect((await session.listCommands!()).find(command => command.id === 'goal')).toMatchObject({ kind: 'command' });
      await session.executeCommand!('goal', OBJECTIVE);
      await seen.until(() => goalsOf(seen).some(goal => (goal.tokensUsed ?? 0) > 0), 'a turn the goal started and counted', 30_000);
      const working = goalsOf(seen).find(goal => (goal.tokensUsed ?? 0) > 0)!;
      expect(working, 'a goal at work').toMatchObject({ objective: OBJECTIVE, status: 'active' });
      expect(working.startedAt, 'createdAt is in seconds, the goal in milliseconds').toBeGreaterThan(Date.now() - 24 * 3_600_000);
      expect(working.startedAt).toBeLessThanOrEqual(Date.now() + 60_000);
      await session.executeCommand!('goal', 'pause');
      await seen.until(() => goalsOf(seen).at(-1)?.status === 'paused', 'the goal paused', 30_000);
      expect(goalsOf(seen).at(-1)!.actions?.map(action => action.kind)).toEqual(['resume', 'clear']);
      await session.executeCommand!('goal', 'edit every test and lint check passes');
      await seen.until(() => goalsOf(seen).at(-1)?.objective === 'every test and lint check passes', 'the objective edited', 30_000);
      expect(goalsOf(seen).at(-1)!.status, 'an edit keeps a paused goal paused').toBe('paused');
      await session.executeCommand!('goal', 'resume');
      await seen.until(() => goalsOf(seen).at(-1)?.status === 'active', 'the goal resumed', 30_000);
      await session.executeCommand!('goal', 'clear');
      await seen.until(() => seen.liveEvents().at(-1)?.type === 'runtime_updated' && !(seen.liveEvents().at(-1) as { runtimeInfo: { goal?: unknown } }).runtimeInfo.goal, 'the goal cleared', 30_000);
      expect((await session.runtimeInfo()).goal).toBeUndefined();
      await session.dispose(); await seen.done;
    } finally { await provider.dispose?.(); await f.close(); }
  }, 120_000);

  it('restores a paused goal when the thread is opened again', async () => {
    const f = await startResponsesFixture((_request, index) => message(`m${index}`, `WORKED ${index}`));
    const provider = new CodexAppServerProvider({ executable, env: f.env, requestTimeoutMs: 20_000 });
    try {
      const session = await provider.createSession({ sessionId: 'goal-restore', cwd: f.cwd, model: 'mock-model' });
      const seen = followSession(session);
      await seen.boundary();
      await session.executeCommand!('goal', OBJECTIVE);
      await seen.until(() => goalsOf(seen).some(goal => (goal.tokensUsed ?? 0) > 0), 'a turn the goal started', 30_000);
      await session.executeCommand!('goal', 'pause');
      await seen.until(() => goalsOf(seen).at(-1)?.status === 'paused', 'the goal paused', 30_000);
      await seen.until(() => !seen.liveEvents().some(event => event.type === 'runtime_updated' && event.runtimeInfo.status === 'running' && event === seen.liveEvents().at(-1)), 'the turn in flight to end', 30_000);
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose(); await seen.done;
      const again = await provider.resumeSession(handle);
      const reread = followSession(again);
      await reread.boundary();
      // Codex reports it with the thread it resumes or answers for it a moment later, as a runtime update; the runtime holds it either way.
      const deadline = Date.now() + 30_000;
      let goal = (await again.runtimeInfo()).goal;
      while (!goal && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); goal = (await again.runtimeInfo()).goal; }
      expect(goal).toMatchObject({ objective: OBJECTIVE, status: 'paused' });
      await again.dispose(); await reread.done;
    } finally { await provider.dispose?.(); await f.close(); }
  }, 120_000);
});
