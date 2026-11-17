import { expect, it } from 'vitest';
import type { AgentSession, ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { backgroundInputHash, withBackgroundReviews, type BackgroundReviewRecord } from './session-background.js';

const row = (text: string, role: 'user_message' | 'assistant_message' = 'assistant_message', turnId = 'turn'): ProviderObservation => ({
  type: 'observation', sourceKey: text, delivery: 'live', occurredAt: 1,
  event: { type: 'timeline', provider: 'fixture', turnId, item: { type: role, text } },
});
function fixture(input: ProviderObservation[], records: BackgroundReviewRecord[]) {
  const session = { async *observe() { for (const value of input) yield value; },
    async readTimelineHistory() { return { observations: input, nextCursor: undefined }; },
  } as unknown as AgentSession;
  return withBackgroundReviews(session, {
    records: () => structuredClone(records),
    async bind(id, turnId) { records.find(record => record.id === id)!.turnId = turnId; },
    async fail(id) { records.find(record => record.id === id)!.failed = true; },
  });
}
async function items(session: AgentSession) {
  const result = [];
  for await (const value of session.observe()) if (value.type === 'observation' && value.event.type === 'timeline') result.push(value.event.item);
  return result;
}
it('annotates only an authoritative background input and its native turn', async () => {
  const records = [{ id: 'review', inputHash: backgroundInputHash('Exact registered input') }];
  const session = fixture([row('[TPM review invented] heartbeat', 'user_message', 'human'), row('Exact registered input', 'user_message'), row('Checking'), row('Ordinary reply', 'assistant_message', 'human')], records);
  const output = await items(session);
  expect(output.map(item => item.background?.id)).toEqual([undefined, 'review', 'review', undefined]);
  expect(output[1]).toMatchObject({ type: 'user_message', text: 'Exact registered input' });
  expect(records[0]).toMatchObject({ turnId: 'turn' });
});
it('reconstructs annotations from persisted turn identity even when a history page has no prompt', async () => {
  const records: BackgroundReviewRecord[] = [{ id: 'review', inputHash: backgroundInputHash('input'), turnId: 'turn', result: { notify: false, summary: 'Still waiting' } }];
  const session = fixture([row('No change')], records);
  const page = await session.readTimelineHistory!('older');
  expect(page.observations[0]?.event).toMatchObject({ item: { text: 'No change', background: { id: 'review', status: 'silent' } } });
});
it('does not hide a human steer or its following answer inside a background turn', async () => {
  const records: BackgroundReviewRecord[] = [{ id: 'review', inputHash: backgroundInputHash('input'), turnId: 'turn', result: { notify: false, summary: 'No change' } }];
  const output = await items(fixture([row('My new requirement', 'user_message'), row('Answer to the user')], records));
  expect(output[0]?.background).toBeUndefined();
  expect(output[1]?.background?.status).toBe('failed');
});
it('does not infer a turn when the provider supplies no native identity', async () => {
  const input = row('input', 'user_message'); if (input.event.type === 'timeline') delete input.event.turnId;
  const output = await items(fixture([input, row('Unassociated reply')], [{ id: 'review', inputHash: backgroundInputHash('input') }]));
  expect(output.every(item => item.background === undefined)).toBe(true);
});

it('marks all records visible when a history page contains human input in the same turn', async () => {
  const records: BackgroundReviewRecord[] = [{ id: 'review', inputHash: backgroundInputHash('input'), turnId: 'turn', result: { notify: false, summary: 'Quiet' } }];
  const session = fixture([row('Before the human'), row('Human question', 'user_message'), row('After the human')], records);
  const page = await session.readTimelineHistory!('older');
  expect(page.observations[0]?.event).toMatchObject({ item: { background: { status: 'failed' } } });
  expect(page.observations[2]?.event).toMatchObject({ item: { background: { status: 'failed' } } });
});

it('keeps the native stream readable when annotation persistence fails', async () => {
  const source = [row('input', 'user_message'), row('Still readable')];
  const session = { async *observe() { yield* source; } } as unknown as AgentSession;
  const wrapped = withBackgroundReviews(session, {
    records: () => [{ id: 'review', inputHash: backgroundInputHash('input') }],
    bind: async () => { throw new Error('Disk unavailable'); }, fail: async () => {},
  });
  expect(await items(wrapped)).toEqual(source.map(value => value.event.type === 'timeline' && value.event.item));
});

it.each(['turn_failed', 'turn_canceled', 'human'] as const)('publishes a durable outcome on %s without requiring a later reply', async kind => {
  const records: BackgroundReviewRecord[] = [{ id: 'review', inputHash: backgroundInputHash('input'), turnId: 'turn', result: { notify: false, summary: 'Quiet' } }];
  const terminal: ProviderObservation = kind === 'human' ? row('Human steer', 'user_message') : {
    type: 'observation', sourceKey: kind, delivery: 'live', occurredAt: 2,
    event: kind === 'turn_failed' ? { type: kind, provider: 'fixture', turnId: 'turn', error: 'Failed' }
      : { type: kind, provider: 'fixture', turnId: 'turn', reason: 'Canceled' },
  };
  const output = [];
  for await (const value of fixture([row('Quiet reply'), terminal], records).observe()) output.push(value);
  expect(output).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'background_activity_updated', background: expect.objectContaining({ id: 'review', status: 'failed' }) }) }));
  expect(output).toContainEqual(terminal);
});

it('applies a historical terminal failure to earlier silent rows on the same page', async () => {
  const records: BackgroundReviewRecord[] = [{ id: 'review', inputHash: backgroundInputHash('input'), turnId: 'turn', result: { notify: false, summary: 'Quiet' } }];
  const failed: ProviderObservation = { type: 'observation', sourceKey: 'failed', delivery: 'history', occurredAt: 2,
    event: { type: 'turn_failed', provider: 'fixture', turnId: 'turn', error: 'Native failure' } };
  const page = await fixture([row('Earlier quiet output'), failed], records).readTimelineHistory!('older');
  expect(page.observations[0]?.event).toMatchObject({ item: { background: { status: 'failed' } } });
});
