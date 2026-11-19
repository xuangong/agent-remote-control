import { describe, expect, it } from 'vitest';
import * as claude from '@orchardworks/agent-provider-claude/recordings';
import * as codex from '@orchardworks/agent-provider-codex/recordings';
import * as copilot from '@orchardworks/agent-provider-copilot/recordings';
import { rowsOf, rowsOfRecording } from '@orchardworks/agent-remote-fixtures';

/**
 * S1, adapter to Controller rows: what a real provider recording gives the runtime. Each recording is replayed twice; both runs must give
 * the golden rows recorded at baseline/im-session-2026-11-18, and the keys of an item read again must be the keys it had live.
 */
const providers = { claude, codex, copilot } as const;

describe.each(Object.entries(providers))('S1 adapter to Controller rows: %s recordings', (provider, library) => {
  it.each(library.recordingNames())('%s: two replays give the golden rows, and a reread keeps the keys and the order of the live run', async name => {
    const golden = library.recordingRows(name);
    const first = await rowsOfRecording(library.recording(name));
    const second = await rowsOfRecording(library.recording(name));
    expect(second).toEqual(first);
    expect(first).toEqual({ live: golden.live, reread: golden.reread });
    const liveKeys = new Set(first.live.map(row => row.key));
    expect(first.reread.filter(row => !liveKeys.has(row.key)).map(row => row.key)).toEqual([]);
    // A reread shows the items it shares with the live run in the order the live run showed them.
    const order = (rows: Array<{ key: string }>, keep: (key: string) => boolean) => [...new Set(rows.map(row => row.key))].filter(keep);
    const rereadKeys = new Set(first.reread.map(row => row.key));
    expect(order(first.reread, key => liveKeys.has(key))).toEqual(order(first.live, key => rereadKeys.has(key)));
    expect([...first.live, ...first.reread].filter(row => row.key === '' || row.key.startsWith('controller:'))).toEqual([]);
  });
});

describe('S1 adapter to Controller rows: the identity contract', () => {
  it('reports an observation that becomes a row without an item identity', async () => {
    const withoutIdentity = { ...codex.recording('settled').live.find(observation => observation.event.type === 'timeline')! };
    delete (withoutIdentity as { itemIdentity?: unknown }).itemIdentity;
    const outcome = await rowsOf([withoutIdentity]);
    expect(outcome.identityBreach || outcome.rowsWithoutIdentity > 0).toBe(true);
  });

  it('has a golden rows file for every recording', () => {
    for (const library of Object.values(providers)) {
      for (const name of library.recordingNames()) expect(() => library.recordingRows(name), name).not.toThrow();
    }
  });
});
