import { describe, expect, it } from 'vitest';

import { TimelineStore } from './timeline-store.js';

describe('TimelineStore', () => {
  it('assigns one epoch and monotonically increasing sequence positions', () => {
    const store = new TimelineStore('epoch-1');

    const first = store.append({
      providerId: 'codex',
      sourceKey: 'native-1',
      occurredAt: 1_725_000_000_000,
      item: { type: 'assistant_message', text: 'Hello' },
    });
    const second = store.append({
      providerId: 'codex',
      sourceKey: 'native-2',
      occurredAt: 1_725_000_000_001,
      item: { type: 'reasoning', text: 'Checking' },
    });

    expect(first).toMatchObject({ status: 'appended', row: { epoch: 'epoch-1', seq: 1 } });
    expect(second).toMatchObject({ status: 'appended', row: { epoch: 'epoch-1', seq: 2 } });
    expect(store.cursor).toEqual({ epoch: 'epoch-1', seq: 2 });
  });

  it('deduplicates a provider source revision without advancing the cursor', () => {
    const store = new TimelineStore('epoch-1');
    const input = {
      providerId: 'codex',
      sourceKey: 'native-message',
      nativeRevision: 3,
      occurredAt: 1_725_000_000_000,
      item: { type: 'assistant_message' as const, text: 'Hello' },
    };

    expect(store.append(input).status).toBe('appended');
    expect(store.append(input)).toEqual({ status: 'duplicate', row: expect.objectContaining({ seq: 1 }) });
    expect(store.append({ ...input, nativeRevision: 4, item: { ...input.item, text: ' world' } })).toMatchObject({
      status: 'appended',
      row: { seq: 2 },
    });
    expect(store.rows().map(({ seq }) => seq)).toEqual([1, 2]);
  });

  it('binds resource records to an already-recorded canonical row', () => {
    const store = new TimelineStore('epoch-1');
    const appended = store.append({
      providerId: 'codex', sourceKey: 'native-resource', occurredAt: 1,
      item: { type: 'assistant_message', text: '[output](output.png)' },
    });
    if (appended.status !== 'appended') throw new Error('Expected a new row.');

    const bound = store.bindResources(appended.row.seq, [
      { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
    ]);

    expect(bound.resources).toEqual([
      { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
    ]);
    expect(store.rows()[0]?.resources).toEqual(bound.resources);
  });
});
