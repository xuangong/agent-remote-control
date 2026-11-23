import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { BOT_MISSION_LIMIT, BotRecord, botIdentity, botPlacement, WindowBotDetails } from './index.js';

const id = 'b_' + 'a'.repeat(32);

describe('bot records', () => {
  it('accepts a standing bot of the person with identity and mission, and refuses unknown fields', () => {
    const record = { botId: id, name: 'Chief', label: 'Lead', picture: { shape: 'circle', color: '#ff8a3d' }, mission: 'Coordinate the release.',
      organizer: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 2 };
    expect(Value.Check(BotRecord, record)).toBe(true);
    expect(Value.Check(BotRecord, { ...record, mode: 'coordinator' })).toBe(false);
    expect(Value.Check(BotRecord, { ...record, botId: 'chief' })).toBe(false);
    expect(Value.Check(BotRecord, { ...record, mission: 'x'.repeat(BOT_MISSION_LIMIT + 1) })).toBe(false);
  });

  it('splits bot details into identity, which the record keeps, and placement, which the group keeps', () => {
    const details = { botId: id, name: 'Chief', label: 'Lead', mission: 'Coordinate.', pinned: true as const, rank: 'm', process: 'full' as const };
    expect(Value.Check(WindowBotDetails, details)).toBe(true);
    expect(botIdentity(details)).toEqual({ name: 'Chief', label: 'Lead', mission: 'Coordinate.' });
    expect(botPlacement(details)).toEqual({ botId: id, pinned: true, rank: 'm', process: 'full' });
  });
});
