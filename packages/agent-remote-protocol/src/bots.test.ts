import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { assistantMessageText, attachmentLines, BOT_MISSION_LIMIT, BotAttachment, BotMessageResult, BotRecord, isTeamHostCall, botIdentity, botPlacement, WindowBotDetails } from './index.js';

const id = 'b_' + 'a'.repeat(32);

describe('bot records', () => {
  it('accepts a standing bot of the person with identity and mission, and refuses unknown fields', () => {
    const record = { botId: id, name: 'Chief', label: 'Lead', picture: { shape: 'circle', color: '#ff8a3d' }, mission: 'Coordinate the release.',
      chief: { kind: 'person' }, lifetime: 'standing', createdAt: 1, updatedAt: 2 };
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

const botMessages = JSON.parse(readFileSync(new URL('./fixtures/bot-messages.v1.json', import.meta.url), 'utf8'));

describe('the outcome of a message', () => {
  it('is one of five outcomes with an optional id and reason, and nothing else', () => {
    for (const result of botMessages.results.valid) expect(Value.Check(BotMessageResult, result)).toBe(true);
    for (const result of botMessages.results.invalid) expect(Value.Check(BotMessageResult, result)).toBe(false);
    expect(new Set(botMessages.results.valid.map((result: { outcome: string }) => result.outcome))).toEqual(new Set(['delivered', 'held', 'duplicate', 'forbidden', 'unreachable']));
  });

  it('has the calls the Host makes by itself: the reply of a turn naming the one message it answers, and the words the person wrote to a bot', () => {
    for (const call of botMessages.calls.valid) expect(isTeamHostCall(call)).toBe(true);
    for (const call of botMessages.calls.invalid) expect(isTeamHostCall(call)).toBe(false);
  });

  it('describes an attachment by its id, a name without a path, its size and its hash', () => {
    for (const file of botMessages.attachments.valid) expect(Value.Check(BotAttachment, file)).toBe(true);
    for (const file of botMessages.attachments.invalid) expect(Value.Check(BotAttachment, file)).toBe(false);
  });

  it('lists a message\'s files in lines the Relay writes, one for each, after the sender\'s own words', () => {
    const lines = attachmentLines(botMessages.attachments.valid);
    expect(lines.split('\n')).toHaveLength(1 + botMessages.attachments.valid.length);
    expect(lines).toContain(`- ${botMessages.attachments.valid[2].id} · my log (2).txt · text/x-diff · 2048 bytes · sha256 ${'a'.repeat(64)}`);
    expect(assistantMessageText({ messageId: 'm0123456789ab', from: 'Dev', body: `Fixed.\n${lines}` })).toContain('\n- a_');
  });
});
