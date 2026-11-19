// The one real-size check of the succession byte ceiling. The rules of capacity are tested at a small injected ceiling in
// session-succession-capacity.test.ts; this file proves the production default really is 8 MiB: a state of exactly 8 MiB is restored and
// refuses further growth, and a state one byte larger is refused at restore. Serializing and validating 8 MiB is slow, so it runs in the process tier.
import { expect, test } from 'vitest';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { memoryStateFiles } from './memory-state-files.js';
import { jsonBytes } from './succession-persistence.js';

const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const attachment = (id: string, text = '[]') => ({ operationId: id, roleId: id, roleRevision: 2, source: ref(`source-${id}`), target: ref(`target-${id}`), boundary: { epoch: 'epoch', seq: 1 }, capturedAt: '2026-10-10T00:00:00Z', text, itemCount: JSON.parse(text).length });

test('the production ceiling is eight MiB: exactly full restores and refuses growth, one byte more is refused at restore', async () => {
  const directory = '/succession/capacity', files = memoryStateFiles(), store = new SessionSuccessionContextStore(directory, {}, files); await store.ready;
  await store.attach(attachment('input'));
  const state = files.json('context.json'), eightMiB = 8 * 1024 * 1024;
  const pending = (id: string, text: string) => ({ ...attachment(id, JSON.stringify([{ role: 'user', text }])), version: 2, state: 'pending', deliveries: [] });
  while (jsonBytes(state) < eightMiB - 1024 * 1024) state.attachments.push(pending(`padding-${state.attachments.length}`, 'x'.repeat(1024 * 1024 - 100)));
  const padding = pending('padding-last', ''); state.attachments.push(padding);
  padding.text = JSON.stringify([{ role: 'user', text: 'x'.repeat(eightMiB - jsonBytes(state)) }]);
  expect(jsonBytes(state)).toBe(eightMiB);
  files.put('context.json', state);
  const full = new SessionSuccessionContextStore(directory, {}, files); await full.ready;
  await expect(full.attach(attachment('unrelated'))).rejects.toThrow(/capacity/);

  padding.text += 'x'; files.put('context.json', state);
  await expect(new SessionSuccessionContextStore(directory, {}, files).ready).rejects.toThrow(/byte limit/);
});
