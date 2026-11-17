import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import type { JournalRecording } from '@orchardworks/agent-provider-sdk/testing';

import { attachScripted, historyBoundary, ScriptedSession } from './scripted-session.js';

const SENTINEL = 'rows:sentinel';

/** One canonical timeline row as the runtime keeps it: what an item's key, completion and content were. */
export interface GoldenRow { key: string; completes: boolean; liveOnly: boolean; providerId: string; sourceKey: string; turnId?: string; row: unknown }

/** What a provider recording gives the Controller: the rows of the live run, and the rows read again from native history. */
export interface RecordedRows { live: GoldenRow[]; reread: GoldenRow[] }

export interface RowsOutcome { rows: GoldenRow[]; identityBreach: boolean; rowsWithoutIdentity: number }

/**
 * The canonical timeline rows a real agent manager holds for these observations: history before its boundary and live observations after
 * it, the way the Controller applies them. The manager checks the item identity contract; a breach is reported, not thrown.
 */
export async function rowsOf(observations: readonly ProviderObservation[]): Promise<RowsOutcome> {
  const session = new ScriptedSession('rows', 'rows', [...observations.filter(observation => observation.delivery === 'history'), historyBoundary()]);
  const manager = await attachScripted(session, 'rows');
  let breached = false;
  const subscription = manager.subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { breached = true; } });
  try {
    for (const observation of observations.filter(candidate => candidate.delivery === 'live')) session.push(observation);
    // Live observations are applied in order after this call returns; the sentinel says when they all were.
    session.push({ type: 'observation', sourceKey: SENTINEL, occurredAt: 0, delivery: 'live', event: { type: 'timeline', provider: 'rows', turnId: 't', item: { type: 'assistant_message', text: '', messageId: SENTINEL } }, itemIdentity: { key: SENTINEL, completes: true } });
    for (let waited = 0; waited < 400 && !manager.timelineRows().some(row => row.identity?.key === SENTINEL); waited += 1) await new Promise<void>(resolve => { setTimeout(resolve, 5); });
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    const rows = manager.timelineRows().filter(row => row.identity?.key !== SENTINEL);
    // A file a row names gets a new resource id in every manager unless its bytes were read; the ids are numbered by first appearance.
    const resourceIds = new Map<string, string>();
    return {
      identityBreach: breached,
      rowsWithoutIdentity: rows.filter(row => row.identity === undefined).length,
      rows: rows.map(({ identity, ...row }) => ({
        key: identity?.key ?? '', completes: identity?.completes === true, liveOnly: identity?.liveOnly === true,
        providerId: row.providerId, sourceKey: row.sourceKey, ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
        row: JSON.parse(JSON.stringify(row), (name, value) => name === 'resourceId' && typeof value === 'string' ? resourceIds.get(value) ?? resourceIds.set(value, `<resource:${resourceIds.size + 1}>`).get(value) : value),
      })),
    };
  } finally {
    subscription.release();
    await manager.close();
  }
}

/** The rows of a recording's live run and of its reread, in the shape the golden files hold. */
export async function rowsOfRecording(recording: JournalRecording): Promise<RecordedRows> {
  const live = await rowsOf(recording.live);
  const reread = await rowsOf(recording.reread.map(observation => ({ ...observation, delivery: 'history' as const })));
  for (const outcome of [live, reread]) {
    if (outcome.identityBreach || outcome.rowsWithoutIdentity > 0) throw new Error('A recording broke the item identity contract: a row carries no item identity, or an identity is malformed.');
  }
  return { live: live.rows, reread: reread.rows };
}

export interface RowsGolden extends RecordedRows { kind: 'recording-rows'; producedBy: 'transcripts:record'; provider: string; recording: string }

export const serializeRowsGolden = (golden: RowsGolden): string => {
  const rows = (side: GoldenRow[]) => side.map(row => `  ${JSON.stringify(row)}`).join(',\n');
  return `{\n "kind": "recording-rows",\n "producedBy": "transcripts:record",\n "provider": ${JSON.stringify(golden.provider)},\n "recording": ${JSON.stringify(golden.recording)},\n "live": [\n${rows(golden.live)}\n ],\n "reread": [\n${rows(golden.reread)}\n ]\n}\n`;
};
