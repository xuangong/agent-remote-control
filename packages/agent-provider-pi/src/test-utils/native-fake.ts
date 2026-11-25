import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followSession, type ProviderNativeFake } from '@orchardworks/agent-provider-sdk/conformance';
import { PiAgentProvider } from '../provider.js';
import { FakeClock, FakePi, playRun, sessionLines } from './fake-pi.js';

/**
 * The pi adapter driven by a fake of the pi CLI behind its native port (`PiLauncher`), for the provider conformance kit
 * (`@orchardworks/agent-provider-sdk/conformance`). The fake opens a session whose file holds one finished turn, plays the events of a
 * further turn, and keeps the session file as pi does, so the session read again holds both turns.
 */
const SESSION = '4c1f6a2e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';
const handle = { providerId: 'pi', sessionId: SESSION, opaque: '{}' };

function nativePi(unknown: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'pi-conformance-'));
  const agentDirectory = join(root, 'agent'), cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const file = join(agentDirectory, 'sessions', '--workspace--', `2026-11-26T00-00-00-000Z_${SESSION}.jsonl`);
  const clock = new FakeClock();
  const first = playRun({ prompt: 'Hello', messages: [{ text: 'Hi' }] }, clock).messages;
  mkdirSync(join(file, '..'), { recursive: true });
  const lines = sessionLines(SESSION, cwd, first);
  // An entry of a kind a newer pi could write, once in the history the session holds.
  if (unknown) lines.push(JSON.stringify({ type: 'hologram', id: 'ffffffff', parentId: (JSON.parse(lines.at(-1)!) as { id: string }).id, timestamp: new Date(1_795_000_000_000).toISOString() }));
  appendFileSync(file, `${lines.join('\n')}\n`);
  const fake = new FakePi(agentDirectory);
  // The fake keeps what the file holds, so a turn played after the history adds to it.
  const diagnostics: string[] = [];
  const provider = new PiAgentProvider({ executable: '/native-fake/pi', env: { PI_CODING_AGENT_DIR: agentDirectory, PI_CODING_AGENT_SESSION_DIR: undefined }, launch: fake.launcher, workRoot: root, onDiagnostic: line => diagnostics.push(line) });
  return { fake, provider, diagnostics, cwd, file, close: async () => { await provider.dispose(); rmSync(root, { recursive: true, force: true }); }, read: () => readFileSync(file, 'utf8') };
}

export function piNativeFake(): ProviderNativeFake {
  return {
    async turn({ unknown }) {
      let unknownSent = 0;
      const native = nativePi(unknown);
      try {
        native.fake.script({ messages: [{ text: 'Reply to Next' }] });
        const session = await native.provider.resumeSession(handle);
        if (unknown) unknownSent += 1;
        const seen = followSession(session);
        try {
          await seen.boundary();
          if (unknown) { native.fake.last.emit({ type: 'hologram' }); unknownSent += 1; }
          await session.sendMessage('Next');
          await seen.until(() => seen.liveEvents().some(value => value.type === 'turn_completed'), 'the end of the live turn');
        } finally { await session.dispose(); await seen.done; }
        const again = await native.provider.resumeSession(handle);
        if (unknown) unknownSent += 1;
        const reread = followSession(again);
        try { await reread.boundary(); } finally { await again.dispose(); await reread.done; }
        return { live: seen.journal(), reread: reread.history(), diagnostics: native.diagnostics, unknownSent };
      } finally { await native.close(); }
    },
  };
}
