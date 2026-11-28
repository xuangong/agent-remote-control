import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentSessionGoal } from '@orchardworks/agent-provider-sdk';
import { followSession } from '@orchardworks/agent-provider-sdk/conformance';

import { CLAUDE_GOAL_COMMAND } from './goal.js';
import { ClaudeAgentProvider } from './provider.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

/**
 * The native assumption checks of `/goal` (`pnpm test:native:claude`): what the adapter reads of a goal is what the installed Claude Code
 * writes. The CLI runs against a scripted model, and the scripted model answers the goal's evaluator (a request with a JSON schema as its
 * output format and no tools) as the test says: not met for the first checks, then met. Nothing signs in.
 */
const executable = process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? 'claude';
const installed = /^(\d+\.\d+\.\d+) \(Claude Code\)/m.exec(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[1];
const MODEL = 'claude-sonnet-4-5-20250929';
const CONDITION = 'every test passes';

/** The scripted model: the evaluator is told by its output format; `metAfter` checks find the condition not met before one finds it met. */
async function goalFixture(metAfter: number) {
  let checks = 0;
  const fixture = await nativeFixture((body, response) => {
    if (body.output_config?.format) {
      checks++;
      nativeReply(response, [{ type: 'text', text: JSON.stringify(checks > metAfter ? { ok: true, reason: 'the tests pass' } : { ok: false, reason: `two tests fail (check ${checks})` }) }]);
    } else nativeReply(response, [{ type: 'text', text: 'WORKING' }]);
  });
  // Claude Code signs in with a token against a base URL of its own; the fixture's API key alone reads as "Not logged in".
  return { ...fixture, options: { ...fixture.options, env: { ...fixture.options.env, ANTHROPIC_AUTH_TOKEN: 'local-claude-test' } } };
}

describe(`the installed Claude Code (${installed ?? 'no version'}) and the goal of a session`, () => {
  it('reports a goal set through the command, each check of it, and its completion, from the transcript', async () => {
    const fixture = await goalFixture(2);
    const provider = new ClaudeAgentProvider(fixture.options);
    try {
      const session = await provider.createSession({ cwd: fixture.cwd, model: MODEL, permissionMode: 'bypassPermissions' });
      const seen = followSession(session);
      await seen.boundary();
      const goals = () => seen.liveEvents().flatMap(event => event.type === 'runtime_updated' && event.runtimeInfo.goal ? [event.runtimeInfo.goal as AgentSessionGoal] : []);
      expect((await session.listCommands!()).find(command => command.id === CLAUDE_GOAL_COMMAND), 'the /goal command of the session').toMatchObject({ kind: 'command' });
      await session.executeCommand!(CLAUDE_GOAL_COMMAND, CONDITION);
      await seen.until(() => goals().some(goal => goal.status === 'complete'), 'the goal found met', 60_000);
      const reported = goals();
      // The scripted checks come faster than the adapter reads the transcript, so the reports in between depend on timing; the last does not.
      expect(reported.at(-1)).toMatchObject({ objective: CONDITION, status: 'complete', iterations: 3, lastReason: 'the tests pass' });
      expect(reported.at(-1)!.actions, 'a met goal offers nothing').toBeUndefined();
      await session.dispose(); await seen.done;
    } finally { await provider.dispose(); await fixture.close(); }
  }, 120_000);

  it('restores a goal that was still active when the session is opened again, and clears it with `/goal clear`', async () => {
    const fixture = await goalFixture(Number.MAX_SAFE_INTEGER);
    const provider = new ClaudeAgentProvider(fixture.options);
    try {
      const session = await provider.createSession({ cwd: fixture.cwd, model: MODEL, permissionMode: 'bypassPermissions' });
      const seen = followSession(session);
      await seen.boundary();
      await session.executeCommand!(CLAUDE_GOAL_COMMAND, CONDITION);
      await seen.until(() => seen.liveEvents().some(event => event.type === 'runtime_updated' && (event.runtimeInfo.goal?.iterations ?? 0) >= 1), 'a check of the goal', 60_000);
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose(); await seen.done;
      const again = await provider.resumeSession(handle);
      const reread = followSession(again);
      await reread.boundary();
      expect((await again.runtimeInfo()).goal, 'the goal after a reopen').toMatchObject({ objective: CONDITION, status: 'active', actions: [{ kind: 'clear', commandId: CLAUDE_GOAL_COMMAND, args: 'clear' }] });
      await again.executeCommand!(CLAUDE_GOAL_COMMAND, 'clear');
      await reread.until(() => reread.liveEvents().some(event => event.type === 'runtime_updated' && event.runtimeInfo.goal === undefined && event.runtimeInfo.status === 'idle'), 'the goal cleared', 60_000);
      expect((await again.runtimeInfo()).goal).toBeUndefined();
      await again.dispose(); await reread.done;
    } finally { await provider.dispose(); await fixture.close(); }
  }, 120_000);
});
