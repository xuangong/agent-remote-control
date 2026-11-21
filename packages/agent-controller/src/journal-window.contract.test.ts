import { decideWindow, itemDigest } from '@orchardworks/agent-remote-journal';
import { describeDecision, heldTail, vectorText, windowVectors, type VectorItem } from '@orchardworks/agent-remote-journal/testing';
import type { CanonicalTimelineRow } from '@orchardworks/agent-timeline';
import { describe, expect, it } from 'vitest';

import { groupItems } from './publisher/journal-items.js';
import { windowOp } from './publisher/journal-reconcile.js';

/**
 * The publisher's side of the window vectors: the window it builds from its timeline items, with the digests it computes,
 * is judged by the journal's decision as the vector says. Only the message items of the table are rebuilt from rows.
 */
const messageOnly = windowVectors.filter(({ held, window }) => [...held, ...window].every(({ kind }) => kind === undefined));
const rowOf = (item: VectorItem, seq: number): CanonicalTimelineRow => ({
  epoch: 'e', seq, providerId: 'codex', sourceKey: `source:${item.key}`, occurredAt: 1_725_000_000_000, timestamp: '2024-08-30T06:40:00.000Z', turnId: item.turn ?? 'turn-1',
  item: { type: 'assistant_message', text: vectorText(item), messageId: item.key }, resources: [],
  identity: { key: item.key, ...(item.state === 'open' ? {} : { completes: true }), ...(item.live ? { liveOnly: true } : {}) },
});

describe('the window the publisher builds, over the window vectors', () => {
  it.each(messageOnly.map(vector => [vector.name, vector] as const))('%s', async (_name, vector) => {
    const { op: sized } = await windowOp(groupItems(vector.window.map((item, at) => rowOf(item, at + 1))), vector.order);
    const op = sized.op;
    if (op.op !== 'window') throw new Error('expected a window entry');
    const digests = new Map(await Promise.all([...vector.held, ...vector.window].map(async item => [`${item.key}:${vectorText(item)}`, await itemDigest({ type: 'assistant_message', text: vectorText(item), messageId: item.key })] as const)));
    const tail = heldTail(vector, item => digests.get(`${item.key}:${vectorText(item)}`)!);
    // The window says how its siblings are ordered, and the decision reads it from there, as the Relay does.
    const decision = decideWindow(tail, op.items, { ...(vector.room ? { roomBytes: vector.room.roomBytes } : {}), ...(op.order ? { order: op.order } : {}) });
    expect(describeDecision(decision, op.items)).toEqual(vector.expect);
  });
});
