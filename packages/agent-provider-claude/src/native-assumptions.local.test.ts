import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readUnknownNativeEvent, type ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { followSession } from '@orchardworks/agent-provider-sdk/conformance';

import { claudeBehaviour } from './behaviour.js';
import { ClaudeAgentProvider } from './provider.js';
import { recording, recordingNames } from './recordings.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';

/**
 * The native assumption checks of Claude Code (step B5, section 4.4 of `docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md`):
 * what the adapter declares (`behaviour.ts`) and what its recordings record, re-verified against the installed CLI, which updates itself.
 * Run nightly or by hand with `pnpm test:native:claude`, which also runs the recorder against the committed recordings and the terminal
 * fork. A difference fails loudly and names the declared field it contradicts. The CLI runs against a scripted model in a temporary
 * CLAUDE_CONFIG_DIR: nothing signs in, and no session of the person's own Claude Code is touched. Build the package first: the catalog
 * worker that reads a transcript is a built file.
 */
const executable = process.env.AGENT_CLAUDE_TEST_EXECUTABLE ?? 'claude';
const installed = /^(\d+\.\d+\.\d+) \(Claude Code\)/m.exec(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[1];
const MODEL = 'claude-sonnet-4-5-20250929';
const INPUT_ID = '5c0e2a7b-4d1f-4e8a-9b63-2f7d0c9e1a44';

describe(`the installed Claude Code (${installed ?? 'no version'}) against the declaration and the recordings`, () => {
  it('is the version the declaration was verified on (verifiedVersion)', () => {
    expect(installed, `verifiedVersion ${claudeBehaviour.verifiedVersion}: the installed CLI is Claude Code ${installed}. Run these checks against it and update verifiedVersion in behaviour.ts`).toBe(claudeBehaviour.verifiedVersion);
  });

  it('made the recordings (their cli header)', () => {
    const others = recordingNames().flatMap(name => recording(name).cli?.version === installed ? [] : [`${name} (${recording(name).cli?.version ?? 'none'})`]);
    expect(others, `recordings made with another Claude Code than the installed ${installed}: record them again with RECORD_JOURNAL_FIXTURES=1 pnpm test:native:claude, then review the diff and the golden rows`).toEqual([]);
  });

  it("keeps the uuid a message is sent with, live and in the transcript read again (input.identity 'echoes_client_id'), and sends nothing the adapter does not know", async () => {
    const fixture = await nativeFixture((_body, response) => nativeReply(response, [{ type: 'text', text: 'NATIVE_OK', deltas: ['NATIVE', '_OK'] }]));
    const diagnostics: string[] = [];
    const provider = new ClaudeAgentProvider({ ...fixture.options, onDiagnostic: line => diagnostics.push(line) });
    try {
      const session = await provider.createSession({ cwd: fixture.cwd, model: MODEL, permissionMode: 'bypassPermissions' });
      const seen = followSession(session);
      await seen.boundary();
      await session.sendMessage('Answer', { inputId: INPUT_ID });
      await seen.until(() => seen.liveEvents().some(event => event.type === 'turn_completed'), 'the end of the turn', 30_000);
      const handle = (await session.runtimeInfo()).persistence!;
      await session.dispose(); await seen.done;
      const again = await provider.resumeSession(handle);
      const reread = followSession(again);
      await reread.boundary();
      await again.dispose(); await reread.done;
      const ids = (observations: ProviderObservation[]) => observations.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' ? [event.item.clientMessageId] : []);
      expect(ids(seen.journal()), 'input.identity live').toContain(INPUT_ID);
      expect(ids(reread.history()), 'input.identity in the transcript').toContain(INPUT_ID);
      // A normal turn, live and read again, holds no message or record of a kind the adapter does not know (gap 10).
      expect(diagnostics.flatMap(line => { const unknown = readUnknownNativeEvent(line); return unknown ? [`${unknown.delivery} ${unknown.kind}`] : []; }), 'events of a kind the adapter does not know').toEqual([]);
    } finally { await provider.dispose(); await fixture.close(); }
  }, 90_000);
});
