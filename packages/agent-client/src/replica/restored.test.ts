import { describe, expect, it } from 'vitest';
import { buildEntry, buildRestoredReplica, buildSessionToStore, buildTailPage, buildTailRows } from '../testing/index.js';
import { AgentReplica } from './store.js';

describe('a replica restored from the device', () => {
  it('holds the stored rows by item key at once, marked restored, with no frame applied', () => {
    const { timeline } = buildRestoredReplica({ rows: 3 }).getState();
    expect(timeline.entries.map(entry => entry.itemKey)).toEqual(['m1', 'm2', 'm3']);
    expect(timeline).toMatchObject({ initialized: true, restoredFromDevice: true, epoch: 'e1', nextSeq: 4 });
  });

  it('is announced to subscribers once, and a repeated restore changes nothing', () => {
    const replica = new AgentReplica();
    let announced = 0;
    replica.subscribe(() => announced++);
    const session = buildSessionToStore(2);
    replica.restoreFromDevice(session);
    replica.restoreFromDevice(buildSessionToStore(5));
    expect(announced).toBe(1);
    expect(replica.getState().timeline.entries).toHaveLength(2);
  });

  it('is replaced by the first server tail, which ends the restored mark', () => {
    const replica = buildRestoredReplica({ rows: 3 });
    replica.applyHistory(buildTailPage([buildEntry(3), buildEntry(4)], { epoch: 'e1' }));
    const { timeline } = replica.getState();
    expect(timeline.entries.map(entry => entry.itemKey)).toEqual(['m3', 'm4']);
    expect(timeline.restoredFromDevice).toBeUndefined();
  });

  it('keeps what a replica already read from the Relay', () => {
    const replica = new AgentReplica();
    replica.applyHistory(buildTailPage(buildTailRows(1), { epoch: 'e7' }));
    replica.restoreFromDevice(buildSessionToStore(3));
    expect(replica.getState().timeline.epoch).toBe('e7');
    expect(replica.getState().timeline.restoredFromDevice).toBeUndefined();
  });
});
