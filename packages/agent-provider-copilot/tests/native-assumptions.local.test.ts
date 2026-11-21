import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {AgentSessionInUseError, readUnknownNativeEvent} from '@orchardworks/agent-provider-sdk';
import {copilotBehaviour} from '../src/behaviour.js';
import {CopilotAgentProvider} from '../src/provider.js';
import {recording, recordingNames} from '../src/recordings.js';
import {copilotRuntimeVersion, fixture, observe, reply, waitFor} from '../src/test-utils/native-fixture.js';

/**
 * The native assumption checks of the Copilot CLI (step B5, section 4.4 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md`):
 * what the adapter declares (`behaviour.ts`) and what its recordings record, re-verified against the CLI the adapter runs. The pinned
 * `@github/copilot` package is a loader that runs a newer runtime it keeps up to date, so the version checked is the runtime's own. Run with
 * `pnpm test:native:copilot`, which also runs the recorder. A difference fails loudly and names the declared field it contradicts. The CLI
 * runs against a scripted model in a temporary COPILOT_HOME: nothing signs in.
 */
const installed = copilotRuntimeVersion();

describe(`the Copilot CLI the adapter runs (${installed}) against the declaration and the recordings`, () => {
  it('is the version the declaration was verified on (verifiedVersion)', () => {
    expect(installed, `verifiedVersion ${copilotBehaviour.verifiedVersion ?? 'none'}: the adapter runs Copilot ${installed}. Run these checks against it and update verifiedVersion in behaviour.ts`).toBe(copilotBehaviour.verifiedVersion);
  });

  it('made the recordings (their cli header)', () => {
    const others = recordingNames().flatMap(name => recording(name).cli?.version === installed ? [] : [`${name} (${recording(name).cli?.version ?? 'none'})`]);
    expect(others, `recordings made with another Copilot than ${installed}: record them again with RECORD_JOURNAL_FIXTURES=1, then review the diff and the golden rows`).toEqual([]);
  });

  it("says at resume that another client holds the session, which the adapter raises typed writer_elsewhere (concurrency.probe 'native', failures.inUse)", async () => {
    const f = await fixture((body, res) => reply(res, body, 'HELD'));
    const second = new CopilotAgentProvider({useLoggedInUser: false, requestTimeoutMs: 15000, env: {COPILOT_HOME: join(f.home, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined},
      nativeSessionConfig: {provider: {type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions'}}});
    try {
      const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'});
      const seen = observe(session);
      await session.sendMessage('Hold this session');
      await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
      const refused = await second.resumeSession((await session.runtimeInfo()).persistence!).then(async resumed => { await resumed.dispose(); return undefined; }, (error: unknown) => error);
      expect(refused, 'concurrency.probe native: a second client resumed a session another client holds').toBeInstanceOf(AgentSessionInUseError);
      expect(refused).toMatchObject({reason: 'writer_elsewhere'});
      // A normal turn holds no event of a type the adapter does not know (gap 10).
      expect(f.diagnostics.flatMap(line => { const unknown = readUnknownNativeEvent(line); return unknown ? [`${unknown.delivery} ${unknown.kind}`] : []; }), 'events of a type the adapter does not know').toEqual([]);
      await session.dispose(); await seen.done;
    } finally { await second.dispose(); await f.close(); }
  }, 90000);
});
