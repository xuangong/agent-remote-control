import { describe, expect, it } from 'vitest';
import { chooseMention, mentionCandidates, parseMention } from './composer-mention.js';

const bots = [{ botId: 'b_1', name: 'Reviewer' }, { botId: 'b_2', name: 'Release' }, { botId: 'b_3', name: 'Release Manager' }];

describe('mentions in the composer', () => {
  it('reads @Name and the question, case-insensitively, with the longest name winning', () => {
    expect(parseMention('@reviewer what changed?', bots)).toEqual({ bot: bots[0], text: 'what changed?' });
    expect(parseMention('  @Release Manager  ship it?', bots)).toEqual({ bot: bots[2], text: 'ship it?' });
    expect(parseMention('@Release ship it?', bots)).toEqual({ bot: bots[1], text: 'ship it?' });
    expect(parseMention('@Release\nmulti\nline', bots)).toEqual({ bot: bots[1], text: 'multi\nline' });
  });

  it('is no mention without a known bot, a space after the name or a question', () => {
    expect(parseMention('@Nobody hello', bots)).toBeUndefined();
    expect(parseMention('@Reviewerx hello', bots)).toBeUndefined();
    expect(parseMention('@Reviewer', bots)).toBeUndefined();
    expect(parseMention('@Reviewer   ', bots)).toBeUndefined();
    expect(parseMention('hello @Reviewer there', bots)).toBeUndefined();
    expect(parseMention('@Reviewer hi', [])).toBeUndefined();
  });

  it('offers the bots whose name starts with what is typed after @, and closes once a name is complete and followed by a space', () => {
    expect(mentionCandidates('@', bots).map(bot => bot.name)).toEqual(['Reviewer', 'Release', 'Release Manager']);
    expect(mentionCandidates('@rel', bots).map(bot => bot.name)).toEqual(['Release', 'Release Manager']);
    expect(mentionCandidates('@Release', bots).map(bot => bot.name)).toEqual(['Release', 'Release Manager']);
    expect(mentionCandidates('@Release ', bots)).toEqual([]);
    expect(mentionCandidates('@Release M', bots).map(bot => bot.name)).toEqual(['Release Manager']);
    expect(mentionCandidates('@zzz', bots)).toEqual([]);
    expect(mentionCandidates('hello @', bots)).toEqual([]);
    expect(mentionCandidates('@Reviewer\nsecond line', bots)).toEqual([]);
  });

  it('puts a chosen bot into the draft with a space for the question', () => {
    expect(chooseMention(bots[2]!)).toBe('@Release Manager ');
    expect(parseMention(`${chooseMention(bots[0]!)}done?`, bots)?.bot).toBe(bots[0]);
  });
});
