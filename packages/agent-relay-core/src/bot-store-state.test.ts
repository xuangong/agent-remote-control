import { expect, it } from 'vitest';
import { decodeHostedSnapshot, encodeHostedSnapshot, encodeValidatedHostedSnapshot, HOSTED_SNAPSHOT_FORMAT } from './record-codec.js';
import { checkedRelayState, emptyRelayState, validateRelayState } from './state.js';
import { migrationBotId } from './bot-store.js';
import { createWindowView } from '@orchardworks/agent-remote-protocol';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'bot-store-test-secret-0123456789' };
const window = { schemaVersion: 3 as const, id: 'g1', title: 'g1', revision: 1, selectedViewId: 'v1', selectedPrimaryViewId: 'v1',
  views: [createWindowView('v1', { hostId: 'mac', providerId: 'claude', nativeSessionId: 's1', title: 's1' }, 'primary')] };

it('moves existing bots into records when the state loads, and keeps them through the stored records', () => {
  const legacy = { ...emptyRelayState(auth), workspaceWindows: [{ subject: 'me', id: 'g1', generation: 0, receipts: [], window, bots: { rank: 'm', members: { v1: { name: 'Chief' } } } }] };
  const loaded = validateRelayState(structuredClone(legacy), auth);
  const botId = migrationBotId('me', 'g1', 'v1');
  expect(loaded.workspaceWindows![0]!.bots!.members.v1).toEqual({ botId });
  expect(loaded.bots).toEqual([expect.objectContaining({ subject: 'me', botId, name: 'Chief' })]);
  // A second load before any commit gives the same id.
  expect(validateRelayState(structuredClone(legacy), auth).bots![0]!.botId).toBe(botId);
  const records = [...encodeHostedSnapshot(loaded, auth).records.values()];
  const decoded = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
  expect(decoded.bots).toEqual(loaded.bots);
  expect(() => validateRelayState({ ...loaded, bots: [...loaded.bots!, loaded.bots![0]] }, auth)).toThrow();

  // A snapshot written before bot records decodes into records too.
  const old = [...encodeValidatedHostedSnapshot(structuredClone(legacy) as never, HOSTED_SNAPSHOT_FORMAT).records.values()];
  const migrated = decodeHostedSnapshot(old.map(record => record.manifest), old.flatMap(record => record.chunks), auth);
  expect(migrated.bots).toEqual([expect.objectContaining({ subject: 'me', botId, name: 'Chief' })]);
});

it('keeps the identity of a bot when its group also holds a bot view without details, on load and on every commit after it', () => {
  const views = [createWindowView('v1', { hostId: 'mac', providerId: 'claude', nativeSessionId: 's1', title: 's1' }, 'primary'),
    createWindowView('v2', { hostId: 'mac', providerId: 'claude', nativeSessionId: 's2', title: 's2' }, 'primary')];
  const pair = { ...window, selectedViewId: 'v1', selectedPrimaryViewId: 'v1', views };
  const legacy = { ...emptyRelayState(auth), workspaceWindows: [{ subject: 'me', id: 'g1', generation: 0, receipts: [], window: pair,
    bots: { rank: 'm', members: { v1: { name: 'Chief', label: 'Lead', pinned: true } } } }] };
  const loaded = validateRelayState(structuredClone(legacy), auth);
  const members = loaded.workspaceWindows![0]!.bots!.members;
  expect(members.v1).toEqual({ botId: migrationBotId('me', 'g1', 'v1'), pinned: true });
  expect(members.v2).toBeUndefined();
  expect(loaded.bots).toEqual([expect.objectContaining({ botId: members.v1!.botId, name: 'Chief', label: 'Lead' })]);
  // A committed state needs no second migration, so the identity the record holds stays.
  expect(checkedRelayState(loaded, auth)).toBe(loaded);
});
