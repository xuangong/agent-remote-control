import { describe, expect, it } from 'vitest';
import * as claude from '@orchardworks/agent-provider-claude/recordings';
import * as codex from '@orchardworks/agent-provider-codex/recordings';
import * as copilot from '@orchardworks/agent-provider-copilot/recordings';
import type { GoldenRow } from '@orchardworks/agent-remote-fixtures';
import { foldTurns } from '@orchardworks/agent-client';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

/**
 * S6, client replica to renderer: the turn fold the conversation renders reads every recorded provider timeline whole. The golden rows of
 * each recording (live run and reread) become the timeline a replica holds, an item replacing its earlier rows in place; folded into turns,
 * every entry appears in exactly one turn, once (rule T-1 of `foldTurns`), and a person's message opens each turn but the first.
 */
const providers = { claude, codex, copilot } as const;

function timelineOf(rows: readonly GoldenRow[]): ProjectedTimelineEntry[] {
  const byKey = new Map<string, ProjectedTimelineEntry>();
  for (const golden of rows) {
    const row = golden.row as { item: ProjectedTimelineEntry['item']; timestamp: string; seq: number; turnId?: string; resources?: ProjectedTimelineEntry['resources'] };
    const earlier = byKey.get(golden.key);
    byKey.set(golden.key, { providerId: golden.providerId, itemKey: golden.key, item: row.item, ...(row.turnId ? { turnId: row.turnId } : {}), timestamp: row.timestamp,
      seqStart: earlier?.seqStart ?? row.seq, seqEnd: row.seq, sourceSeqRanges: [], collapsed: [], resources: row.resources ?? [] });
  }
  return [...byKey.values()].sort((a, b) => a.seqStart - b.seqStart);
}

describe.each(Object.entries(providers))('S6 recorded timelines fold into turns: %s', (_provider, library) => {
  it.each(library.recordingNames().flatMap(name => (['live', 'reread'] as const).map(side => [name, side] as const)))('%s (%s): every entry is in one turn, once', (name, side) => {
    const entries = timelineOf(library.recordingRows(name)[side] as GoldenRow[]);
    for (const [activeTurn, status] of [[null, 'idle'], [{ turnId: entries.at(-1)?.turnId ?? 'none' }, 'running']] as const) {
      const turns = foldTurns(entries, activeTurn, status);
      const folded = turns.flatMap(turn => [...(turn.prompt ? [turn.prompt] : []), ...turn.work.flatMap(step => step.entries), ...turn.answer, ...turn.letters]);
      expect(folded).toHaveLength(entries.length);
      expect(new Set(folded)).toEqual(new Set(entries));
      expect(turns.slice(1).every(turn => turn.prompt?.item.type === 'user_message')).toBe(true);
      expect(new Set(turns.map(turn => turn.key)).size).toBe(turns.length);
    }
  });
});
